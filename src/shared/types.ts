export interface StackFile {
  path: string;
  oldPath?: string;
  isTest: boolean;
  /** Single-file unified diff, as produced by `git diff`. */
  patch: string;
  additions: number;
  deletions: number;
  /** Test files only: the tests this change adds, removes and changes. */
  tests?: TestChanges;
}

/**
 * Tests found by pattern, not by AI. Each test or group is a path: the
 * enclosing group names, outermost first, then its own name.
 */
export interface TestChanges {
  added: string[][];
  removed: string[][];
  changed: string[][];
  /** Groups (`describe` blocks and the like) that only exist after the change. */
  addedGroups: string[][];
  /** Groups that only existed before the change. */
  removedGroups: string[][];
}

export interface Layer {
  /** Commit sha, or null for the uncommitted-changes layer. */
  sha: string | null;
  kind: "commit" | "uncommitted";
  title: string;
  /** Markdown commentary for the reviewer (the commit body). */
  intro: string;
  files: StackFile[];
}

export interface Workspace {
  id: string;
  path: string;
  /** Base ref override given when the workspace was registered. */
  base?: string;
  branch: string | null;
  registeredAt: string;
}

export interface Stack {
  repo: string;
  branch: string | null;
  baseRef: string;
  baseSha: string;
  headSha: string;
  restackInProgress: boolean;
  layers: Layer[];
}
