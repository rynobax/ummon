# Restack `{{branch}}` for review

Rewrite the commits on `{{branch}}` into a sequence of layers that a reviewer will read top to bottom in ummon. Each layer is one commit: the subject is the layer title and the body is the layer intro.

## Where things are

- Base, where the stack starts: `{{base}}`
- Original head, the exact final state you must reproduce: `{{head}}`
- HEAD is detached at the base with a clean working tree. Build the new commits on top of it.
- The original branch is untouched and backed up at `{{backupRef}}`.

Start by understanding the whole change, including the intent behind it:

```
git log --format='%h %s%n%n%b' {{base}}..{{head}}
git diff --stat {{base}} {{head}}
git diff {{base}} {{head}}
```

## What makes a good stack

- Order layers so each builds on the ones before it. Foundations first (schemas, migrations, types, interfaces), then core logic, then wiring (API, CLI, jobs), then UI, then cleanup.
- Each layer should be one idea a reviewer can hold in their head. Aim for 3 to 8 layers. A small change can be 1 or 2.
- Keep tests in the same layer as the code they test.
- Put mechanical changes (renames, moves, formatting, generated code, lockfiles, snapshots) in their own layers and say they are mechanical, so the reviewer can skim them.
- One file's changes may be split across several layers.
- Intermediate layers do not need to compile or pass tests, but prefer states that do.
- You may introduce temporary code in an intermediate layer, such as a stub a later layer fills in, when it makes the story clearer. Keep this rare and call it out in that layer's intro.

## Commit messages

- Subject: the layer title. Imperative, under 72 characters.
- Write both for a person: Speak plainly, like one human to another. Prioritize conciseness and simplicity of language.
- Body: the intro. Two to five sentences of markdown for the reviewer. Say what the layer does and why, and point at what deserves scrutiny: tricky logic, behaviour changes, risky edges. Don't list the files; the reviewer sees them.

## Mechanics

- Take a whole file: `git checkout {{head}} -- <path>`. Delete one: `git rm <path>`.
- Take part of a file: write the intermediate content with your edit tools, or apply a partial patch with `git apply`.
- Commit with `git commit --no-verify`, since hooks may fail on intermediate states.
- Never move or delete branches, push, fetch, or edit refs. Only create commits on the detached HEAD.
- You are done when `git diff --stat HEAD {{head}}` prints nothing and `git status --porcelain` is empty. Then {{finish}}
