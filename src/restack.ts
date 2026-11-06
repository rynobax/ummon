import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git, gitMaybe } from "./git.ts";
import { resolveRange } from "./stack.ts";

/**
 * In-place restack. The branch ref is only moved by `finishRestack`, and only
 * once the new tip's tree is identical to the original head's tree. Until
 * then the agent works on a detached HEAD, and the original head is also
 * saved under refs/ummon/backup/ so a finished restack can be undone.
 */
export interface RestackState {
  branch: string;
  base: string;
  origHead: string;
  origTree: string;
  backupRef: string;
  startedAt: string;
}

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

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const state: RestackState = {
    branch: range.branch,
    base: range.baseSha,
    origHead: range.headSha,
    origTree: (await git(repo, ["rev-parse", `${range.headSha}^{tree}`])).trim(),
    backupRef: `refs/ummon/backup/${range.branch}/${stamp}`,
    startedAt: new Date().toISOString(),
  };
  await git(repo, ["update-ref", state.backupRef, state.origHead]);
  await pruneBackups(repo);
  await writeFile(await statePath(repo), JSON.stringify(state, null, 2));
  await git(repo, ["checkout", "--quiet", "--detach", state.base]);
  return state;
}

/**
 * Deletes backups of branches that no longer exist. Backup refs are shared by
 * every worktree of a repo, so without this they pile up as branches merge.
 */
async function pruneBackups(repo: string): Promise<void> {
  const refs = (await git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/ummon/backup"]))
    .split("\n")
    .filter(Boolean);
  const branches = new Set(refs.filter((ref) => ref.startsWith("refs/heads/")).map((ref) => ref.slice("refs/heads/".length)));
  for (const ref of refs.filter((ref) => ref.startsWith("refs/ummon/backup/"))) {
    // refs/ummon/backup/<branch>/<timestamp>, where the branch may contain slashes.
    const branch = ref.slice("refs/ummon/backup/".length).split("/").slice(0, -1).join("/");
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

  await git(repo, ["checkout", "--quiet", "-B", state.branch, "HEAD"]);
  await rm(await statePath(repo), { force: true });
  return { ok: true, state };
}

export async function abortRestack(repo: string): Promise<RestackState> {
  const state = await readRestackState(repo);
  if (!state) throw new Error("No restack is in progress.");
  await git(repo, ["checkout", "--quiet", "--force", "-B", state.branch, state.origHead]);
  await rm(await statePath(repo), { force: true });
  return state;
}

export async function restackGuide(state: RestackState, finish: string): Promise<string> {
  const template = await readFile(new URL("./prompts/restack.md", import.meta.url), "utf8");
  const values: Record<string, string> = {
    branch: state.branch,
    base: state.base,
    head: state.origHead,
    backupRef: state.backupRef,
    finish,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}
