import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitMaybe } from "./git.ts";
import { readRestackState } from "./restack.ts";
import type { Layer, Stack, StackFile } from "./shared/types.ts";
import { summarizeTests } from "./tests.ts";

export interface Range {
  repo: string;
  branch: string | null;
  baseRef: string;
  baseSha: string;
  headSha: string;
}

export async function resolveRepo(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

async function defaultBaseRef(repo: string): Promise<string> {
  const originHead = await gitMaybe(repo, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (await gitMaybe(repo, ["rev-parse", "--verify", "-q", candidate])) return candidate;
  }
  throw new Error("Could not find a base branch. Pass one with --base <ref>.");
}

export async function resolveRange(repo: string, baseOverride?: string): Promise<Range> {
  const headSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const branch = await gitMaybe(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (baseOverride) {
    const baseSha = (await git(repo, ["merge-base", baseOverride, "HEAD"])).trim();
    return { repo, branch, baseRef: baseOverride, baseSha, headSha };
  }
  const trunk = await defaultBaseRef(repo);
  const trunkBase = (await git(repo, ["merge-base", trunk, "HEAD"])).trim();
  const parent = await findParentBranch(repo, branch, trunkBase);
  return parent
    ? { repo, branch, baseRef: parent.ref, baseSha: parent.sha, headSha }
    : { repo, branch, baseRef: trunk, baseSha: trunkBase, headSha };
}

/**
 * For a stacked branch, finds the branch it's stacked on: the first commit
 * below HEAD (following first parents, down to the trunk merge-base) that is
 * the tip of another local or remote branch. The current branch's own remote
 * copy doesn't count.
 */
async function findParentBranch(
  repo: string,
  branch: string | null,
  trunkBase: string,
): Promise<{ ref: string; sha: string } | null> {
  const tips = new Map<string, string[]>();
  const refs = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes"]);
  for (const line of refs.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split(" ");
    const isSelf =
      branch !== null &&
      (ref === `refs/heads/${branch}` || (ref.startsWith("refs/remotes/") && ref.split("/").slice(3).join("/") === branch));
    if (isSelf || ref.endsWith("/HEAD")) continue;
    tips.set(sha, [...(tips.get(sha) ?? []), ref]);
  }

  const below = (await git(repo, ["rev-list", "--first-parent", `${trunkBase}..HEAD`])).split("\n").filter(Boolean).slice(1);
  for (const sha of below) {
    const refsHere = tips.get(sha);
    if (!refsHere) continue;
    // Prefer the local branch name over a remote-tracking one.
    const ref = refsHere.find((r) => r.startsWith("refs/heads/")) ?? refsHere[0];
    return { ref: ref.replace(/^refs\/(heads|remotes)\//, ""), sha };
  }
  return null;
}

export async function readStack(repo: string, baseOverride?: string): Promise<Stack> {
  const restack = await readRestackState(repo);
  // While a restack is in progress HEAD is detached at the new commits, so show
  // those against the recorded base. That lets the page watch the restack happen.
  const range: Range = restack
    ? {
        repo,
        branch: restack.branch,
        baseRef: restack.base,
        baseSha: restack.base,
        headSha: (await git(repo, ["rev-parse", "HEAD"])).trim(),
      }
    : await resolveRange(repo, baseOverride);

  const shas = (await git(repo, ["rev-list", "--reverse", "--first-parent", `${range.baseSha}..${range.headSha}`]))
    .split("\n")
    .filter(Boolean);

  const layers: Layer[] = [];
  for (const sha of shas) layers.push(await commitLayer(repo, sha));

  if (!restack) {
    const files = await uncommittedChanges(repo);
    if (files.length > 0) {
      layers.push({ sha: null, kind: "uncommitted", title: "Uncommitted changes", intro: "", files });
    }
  }

  return { ...range, restackInProgress: restack !== null, layers };
}

/**
 * A commit's layer never changes, so each is built once. That keeps the page's
 * polling cheap: only the uncommitted changes are diffed every time.
 */
const commitLayers = new Map<string, Layer>();
const MAX_CACHED_LAYERS = 5000;

async function commitLayer(repo: string, sha: string): Promise<Layer> {
  const cached = commitLayers.get(sha);
  if (cached) return cached;
  const meta = await git(repo, ["show", "-s", "--format=%s%x00%b", sha]);
  const [title, intro = ""] = meta.split("\0");
  const patch = await git(repo, ["diff", "-M", "--no-color", "--no-ext-diff", `${sha}^1`, sha]);
  const files = await withTestSummaries(repo, splitPatch(patch), `${sha}^1`, sha);
  const layer: Layer = { sha, kind: "commit", title: title.trim(), intro: intro.trim(), files };
  if (commitLayers.size >= MAX_CACHED_LAYERS) commitLayers.clear();
  commitLayers.set(sha, layer);
  return layer;
}

/**
 * Diffs the working tree against HEAD, including untracked files. Uses only
 * read-only git commands: the server may run in a sandbox that can't write to
 * the repo, and it should never change a repo it's only showing.
 */
async function uncommittedChanges(repo: string): Promise<StackFile[]> {
  const tracked = await git(repo, ["diff", "-M", "--no-color", "--no-ext-diff", "HEAD"]);
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const untrackedPatches = await Promise.all(
    untracked.map((path) =>
      git(repo, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", path], { okCodes: [0, 1] }),
    ),
  );
  return withTestSummaries(repo, splitPatch([tracked, ...untrackedPatches].join("")), "HEAD", null);
}

/**
 * Adds a test summary to each test file, from its contents before and after.
 * `after` is a commit, or null for the working tree.
 */
async function withTestSummaries(repo: string, files: StackFile[], before: string, after: string | null) {
  return Promise.all(
    files.map(async (file) => {
      if (!file.isTest) return file;
      const created = /^new file mode /m.test(file.patch);
      const deleted = /^deleted file mode /m.test(file.patch);
      const [old, now] = await Promise.all([
        created ? null : git(repo, ["show", `${before}:${file.oldPath ?? file.path}`]),
        deleted ? null : after ? git(repo, ["show", `${after}:${file.path}`]) : readFile(join(repo, file.path), "utf8"),
      ]);
      return { ...file, tests: summarizeTests(file.path, old, now, file.patch) };
    }),
  );
}

export function splitPatch(patch: string): StackFile[] {
  const chunks = patch.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  return chunks.map((chunk) => {
    const lines = chunk.split("\n");
    let path: string | undefined;
    let oldPath: string | undefined;
    let additions = 0;
    let deletions = 0;
    let inHunks = false;
    for (const line of lines) {
      if (line.startsWith("@@")) inHunks = true;
      if (inHunks) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
        continue;
      }
      if (line.startsWith("rename from ")) oldPath = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) path = line.slice("rename to ".length);
      else if (line.startsWith("+++ b/")) path ??= line.slice("+++ b/".length);
      else if (line.startsWith("--- a/")) oldPath ??= line.slice("--- a/".length);
    }
    // Binary and mode-only changes have no ---/+++ lines; fall back to the header.
    path ??= oldPath ?? headerPath(lines[0]);
    if (oldPath === path) oldPath = undefined;
    return { path, oldPath, isTest: isTestPath(path), patch: chunk, additions, deletions };
  });
}

function headerPath(header: string): string {
  const match = header.match(/^diff --git a\/(.+) b\/(.+)$/);
  return match ? match[2] : header.slice("diff --git ".length);
}

const TEST_PATTERNS = [
  /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|fixtures)\//,
  /\.(test|spec|e2e)\.[^/]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(go|py|rb|exs?)$/,
  /_spec\.rb$/,
  /Tests?\.(java|kt|cs|swift)$/,
  /\.snap$/,
];

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(path));
}
