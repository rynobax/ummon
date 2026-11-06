# ummon

A local web app for reviewing code changes as a stack of layers.

## Terms

- **Workspace**: a repo or worktree registered with the ummon server. Each has its own review page at `/w/<id>`.
- **Server**: the single ummon process (port 7337 by default) that serves every workspace. `ummon` starts it if needed and replaces it when ummon has been rebuilt.
- **Base**: the commit a review starts from. Defaults to the merge-base of HEAD with `origin/HEAD`, `main`, or `master`.
- **Head**: the commit under review.
- **Stack**: the ordered commits from base to head (first-parent), plus an uncommitted-changes layer when the working tree differs from HEAD.
- **Layer**: one commit in a stack, shown as one section of the review. The commit subject is its title and the body is its intro.
- **Intro**: markdown commentary on a layer, written for the reviewer.
- **Restack**: rewriting a branch's commits into layers that are easier to review. The new tip's tree must equal the original head's tree exactly. Intermediate layers may contain code that isn't in the final state.
- **In-place restack**: a restack of the user's own branch. The branch ref only moves after verification, and the original head is kept at `refs/ummon/backup/<branch>/<timestamp>` until the branch is deleted. Each restack prunes backups of deleted branches.
- **Clone restack** (planned): a restack in an ummon-owned clone, for branches that aren't yours, such as other people's PRs.
- **Source / Tests**: the diff tabs in a layer. Files are classified by path patterns, not by AI.
- **Test summary**: the "Tests (summary)" tab — the names of the tests a layer adds, removes and changes, with no code. Found deterministically in `src/tests.ts`: test declarations are matched per language, each test's extent comes from indentation, and a test is changed when a diff line falls inside it. A renamed test shows as removed plus added.
- **Context provider** (planned): a source of background for the agent, such as PR info from `gh` or the transcript of the Claude Code session that wrote the change.
- **Session link** (planned): the connection from ummon to the live Claude Code session for a worktree, through Tethys, used to send chat messages like "fix this".

## Decisions

- Layers are git commits. Everything downstream reads commits; how they get made can change.
- ummon never moves a branch ref until the restack is verified, and never pushes or fetches.
- The server only reads repos and never writes to them. A server started from one sandboxed session must still work for every workspace.
- All Agent SDK usage lives in `src/agent.ts`.
- SQLite (planned) is a cache that can always be deleted, never the only copy of anything.
