# ummon

A local web app for reviewing code changes as a stack of layers.

## Terms

- **Workspace**: a repo or worktree registered with the ummon server. Each has its own review page at `/w/<id>`.
- **Server**: the single ummon process (port 7337 by default) that serves every workspace. `ummon install` runs it under launchd; otherwise `ummon` spawns it. Either way `ummon` replaces it when ummon has been rebuilt, carrying its workspaces and threads over.
- **Base**: the commit a review starts from. Defaults to the merge-base of HEAD with `origin/HEAD`, `main`, or `master`.
- **Head**: the commit under review.
- **Stack**: the ordered commits from base to head (first-parent), plus an uncommitted-changes layer when the working tree differs from HEAD.
- **Layer**: one commit in a stack, shown as one section of the review. The commit subject is its title and the body is its intro.
- **Intro**: markdown commentary on a layer, written for the reviewer.
- **Restack**: rewriting a branch's commits into layers that are easier to review. The new tip's tree must equal the original head's tree exactly. Intermediate layers may contain code that isn't in the final state.
- **In-place restack**: a restack of the user's own branch. The branch ref only moves after verification, and the original head is kept at `refs/ummon/backup/<branch>/<timestamp>` until the branch is deleted. Each restack prunes backups of deleted branches.
- **Clone restack** (planned): a restack in an ummon-owned clone, for branches that aren't yours, such as other people's PRs.
- **Source / Tests**: the diff tabs in a layer. Files are classified by path patterns, not by AI.
- **Dynamic** (diff style): the default. Each file is shown split if any block replaces two or more lines with two or more lines, and unified otherwise.
- **Test summary**: the "Tests (summary)" tab — the names of the tests a layer adds, removes and changes, with no code. Found deterministically in `src/tests.ts`: test declarations are matched per language, each test's extent comes from indentation, and a test is changed when a diff line falls inside it. A renamed test shows as removed plus added.
- **Context provider** (planned): a source of background for the agent, such as PR info from `gh` or the transcript of the Claude Code session that wrote the change.
- **Session link**: the connection from a workspace to the live Claude Code session that ran `ummon` in it: that session's inbox socket and token, from `CLAUDE_CODE_MESSAGING_*`. Rerunning `ummon` from a session relinks the workspace to it.
- **Thread**: a question the reviewer asks on a line range of one layer's diff, plus the replies. ummon posts reviewer messages into the linked session, and the session answers with `ummon reply <thread>`. Threads live in server memory.

## Decisions

- Layers are git commits. Everything downstream reads commits; how they get made can change.
- ummon never moves a branch ref until the restack is verified, and never pushes or fetches.
- The server only reads repos and never writes to them. A server started from one sandboxed session must still work for every workspace, except that it can't reach session inboxes: Claude Code's sandbox blocks Unix sockets, which is why `ummon install` exists.
- The reviewer's questions go to the session that wrote the change, not to a separate agent, so the answer has the session's context and "fix this" can be acted on.
- All Agent SDK usage lives in `src/agent.ts`.
- SQLite (planned) is a cache that can always be deleted, never the only copy of anything.
