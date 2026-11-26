import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git, gitMaybe } from "./git.ts";
import { resolveRange } from "./stack.ts";

/**
 * A restack never moves the branch. The agent builds the new commits on a
 * detached HEAD, and `finishRestack` checks that the new tip's tree is
 * identical to the original head's tree, saves the result under
 * refs/ummon/stack/<branch>/, and switches back to the branch. Since the
 * trees match, switching back changes no files.
 */
export interface RestackState {
  branch: string;
  base: string;
  origHead: string;
  origTree: string;
  startedAt: string;
}

/** The restacked commits. The ref points at their tip. */
export const layersRef = (branch: string) => `refs/ummon/stack/${branch}/layers`;
/** The branch commit the restack was built from. Its tree equals the layers' tip tree. */
export const sourceRef = (branch: string) => `refs/ummon/stack/${branch}/source`;

async function statePath(repo: string): Promise<string> {
  // --git-path resolves per worktree, so parallel worktrees don't collide.
  return resolve(repo, (await git(repo, ["rev-parse", "--git-path", "ummon-restack.json"])).trim());
}

export async function readRestackState(repo: string): Promise<RestackState | null> {
  try {
    return JSON.parse(await readFile(await statePath(repo), "utf8"));
  } catch {
    return null;
  }
}

export async function beginRestack(repo: string, baseOverride?: string): Promise<RestackState> {
  if (await readRestackState(repo)) {
    throw new Error("A restack is already in progress. Run `ummon restack finish` or `ummon restack abort`.");
  }
  const range = await resolveRange(repo, baseOverride);
  if (!range.branch) throw new Error("HEAD is detached. Check out the branch you want to restack.");
  if (range.baseSha === range.headSha) throw new Error(`No commits between ${range.baseRef} and HEAD.`);
  const dirty = (await git(repo, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty) throw new Error("The working tree has uncommitted changes. Commit or stash them first.");

  const state: RestackState = {
    branch: range.branch,
    base: range.baseSha,
    origHead: range.headSha,
    origTree: (await git(repo, ["rev-parse", `${range.headSha}^{tree}`])).trim(),
    startedAt: new Date().toISOString(),
  };
  await pruneRestacks(repo);
  await writeFile(await statePath(repo), JSON.stringify(state, null, 2));
  await git(repo, ["checkout", "--quiet", "--detach", state.base]);
  return state;
}

/**
 * Deletes ummon refs of branches that no longer exist. They're shared by every
 * worktree of a repo, so without this they pile up as branches merge.
 * refs/ummon/backup/ holds undo points from when restacks moved the branch.
 */
async function pruneRestacks(repo: string): Promise<void> {
  const refs = (await git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/ummon/stack", "refs/ummon/backup"]))
    .split("\n")
    .filter(Boolean);
  const branches = new Set(refs.filter((ref) => ref.startsWith("refs/heads/")).map((ref) => ref.slice("refs/heads/".length)));
  for (const ref of refs.filter((ref) => ref.startsWith("refs/ummon/"))) {
    // refs/ummon/<kind>/<branch>/<leaf>, where the branch may contain slashes.
    const branch = ref.split("/").slice(3, -1).join("/");
    if (!branches.has(branch)) await git(repo, ["update-ref", "-d", ref]);
  }
}

export type FinishResult = { ok: true; state: RestackState } | { ok: false; problem: string };

export async function finishRestack(repo: string): Promise<FinishResult> {
  const state = await readRestackState(repo);
  if (!state) return { ok: false, problem: "No restack is in progress." };

  const dirty = (await git(repo, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty) return { ok: false, problem: `The working tree has uncommitted changes:\n${dirty}` };

  if ((await gitMaybe(repo, ["merge-base", "--is-ancestor", state.base, "HEAD"])) === null) {
    return { ok: false, problem: `HEAD no longer builds on the base ${state.base}.` };
  }

  const tree = (await git(repo, ["rev-parse", "HEAD^{tree}"])).trim();
  if (tree !== state.origTree) {
    const stat = await git(repo, ["diff", "--stat", "HEAD", state.origHead]);
    return { ok: false, problem: `The new tip does not match the original head. Remaining differences:\n${stat}` };
  }

  const tip = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await git(repo, ["update-ref", layersRef(state.branch), tip]);
  await git(repo, ["update-ref", sourceRef(state.branch), state.origHead]);
  await git(repo, ["switch", "--quiet", state.branch]);
  await rm(await statePath(repo), { force: true });
  return { ok: true, state };
}

export async function abortRestack(repo: string): Promise<RestackState> {
  const state = await readRestackState(repo);
  if (!state) throw new Error("No restack is in progress.");
  // --force also overwrites untracked files the agent left that the branch has.
  await git(repo, ["checkout", "--quiet", "--force", state.branch, "--"]);
  await rm(await statePath(repo), { force: true });
  return state;
}

/**
 * Moves the current branch onto its restacked commits, replaying any commits
 * made since the restack on top. This is the only command that moves a branch.
 * The replay can't conflict, because the restack's tip has the same tree as
 * the commit it was built from.
 */
export async function adoptRestack(repo: string): Promise<{ branch: string; replayed: number }> {
  if (await readRestackState(repo)) throw new Error("A restack is in progress. Finish or abort it first.");
  const branch = await gitMaybe(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!branch) throw new Error("HEAD is detached. Check out the branch whose restack you want to adopt.");
  const layers = await gitMaybe(repo, ["rev-parse", "--verify", "-q", layersRef(branch)]);
  const source = await gitMaybe(repo, ["rev-parse", "--verify", "-q", sourceRef(branch)]);
  if (!layers || !source) throw new Error(`${branch} has no restack.`);
  if ((await gitMaybe(repo, ["merge-base", "--is-ancestor", source, "HEAD"])) === null) {
    throw new Error(`${branch} has been rewritten since its restack. Restack it again first.`);
  }
  const dirty = (await git(repo, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty) throw new Error("The working tree has uncommitted changes. Commit or stash them first.");

  const replayed = Number((await git(repo, ["rev-list", "--count", `${source}..HEAD`])).trim());
  await git(repo, ["rebase", "--quiet", "--onto", layers, source]);
  await git(repo, ["update-ref", "-d", layersRef(branch)]);
  await git(repo, ["update-ref", "-d", sourceRef(branch)]);
  return { branch, replayed };
}

export async function restackGuide(state: RestackState, finish: string): Promise<string> {
  const template = await readFile(new URL("./prompts/restack.md", import.meta.url), "utf8");
  const values: Record<string, string> = {
    branch: state.branch,
    base: state.base,
    head: state.origHead,
    finish,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}
