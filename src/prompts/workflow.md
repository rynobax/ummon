# Review this branch with ummon

Restack the current branch in place so each commit is one reviewable layer, then serve the review.

Everything you write for the reviewer, in layer intros and in replies to their questions: Speak plainly, like one human to another. Prioritize conciseness and simplicity of language.

1. Run `git status --porcelain --untracked-files=no`. If there are uncommitted changes, commit them as part of this work before continuing.
2. Run `ummon restack begin`. It checks out a detached HEAD at the base, backs up the branch, and prints a restack guide. Follow that guide exactly. Use what you know from this conversation about why each change was made when writing the layer intros.
3. Run `ummon restack finish`. If it reports remaining differences, fix them and run it again. If you get stuck, run `ummon restack abort` and tell the user.
4. Run `ummon --no-open`. It starts ummon's shared server if it isn't already running, registers this workspace, and prints the review's URL. Give the user that URL as a link, along with the backup ref that `finish` printed.
5. The reviewer, who is the user you're working with, may ask questions on the diff. They arrive in this session as messages starting with `[ummon]`. Answer each with `ummon reply`, as the message says. The reviewer only sees what you send that way.
