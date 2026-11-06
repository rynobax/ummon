import { query, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { abortRestack, finishRestack, restackGuide, type RestackState } from "./restack.ts";

/** All Agent SDK usage lives in this module. */

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "Grep", "Glob", "LS", "TodoWrite"]);
const FORBIDDEN_GIT_SUBCOMMANDS = new Set([
  "push", "fetch", "pull", "remote", "update-ref", "branch", "switch", "tag", "config", "gc", "prune",
  "reflog", "stash", "clean", "worktree", "filter-branch", "replace", "symbolic-ref",
]);

/** True if any `git` invocation in a shell command uses a subcommand that touches refs or remotes. */
function touchesRefs(command: string): boolean {
  for (const segment of command.split(/[;&|\n()]+/)) {
    const tokens = segment.trim().split(/\s+/);
    const gitIndex = tokens.indexOf("git");
    if (gitIndex === -1) continue;
    let i = gitIndex + 1;
    // Skip global options such as `-C <path>` and `-c key=value`.
    while (tokens[i]?.startsWith("-")) i += tokens[i] === "-C" || tokens[i] === "-c" ? 2 : 1;
    const subcommand = tokens[i];
    if (FORBIDDEN_GIT_SUBCOMMANDS.has(subcommand)) return true;
    if (subcommand === "checkout" && tokens.slice(i + 1).some((t) => t === "-b" || t === "-B")) return true;
  }
  return false;
}

function restackPermissions(repo: string): CanUseTool {
  const allowedRoots = [repo, tmpdir(), "/tmp", "/private/tmp"];
  return async (toolName, input) => {
    if (toolName === "Bash") {
      const command = String(input.command ?? "");
      if (touchesRefs(command)) {
        return { behavior: "deny", message: "Restacking may only create commits on the detached HEAD." };
      }
      return { behavior: "allow", updatedInput: input };
    }
    if (FILE_TOOLS.has(toolName)) {
      const path = input.file_path ?? input.path;
      if (typeof path === "string" && !allowedRoots.some((root) => resolve(repo, path).startsWith(root))) {
        return { behavior: "deny", message: `${path} is outside the repository.` };
      }
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `${toolName} is not available while restacking.` };
  };
}

function logProgress(message: SDKMessage) {
  if (message.type !== "assistant") return;
  for (const block of message.message.content) {
    if (block.type === "text" && block.text.trim()) {
      process.stderr.write(`\n${block.text.trim()}\n`);
    } else if (block.type === "tool_use") {
      const input = block.input as Record<string, unknown>;
      const detail = input.command ?? input.file_path ?? input.pattern ?? "";
      process.stderr.write(`  · ${block.name} ${String(detail).split("\n")[0].slice(0, 120)}\n`);
    }
  }
}

async function runAgent(repo: string, prompt: string, resume?: string): Promise<string | undefined> {
  let sessionId = resume;
  for await (const message of query({
    prompt,
    options: {
      cwd: repo,
      resume,
      settingSources: [],
      permissionMode: "default",
      canUseTool: restackPermissions(repo),
      systemPrompt: { type: "preset", preset: "claude_code" },
    },
  })) {
    sessionId = message.session_id ?? sessionId;
    logProgress(message);
    if (message.type === "result" && message.subtype !== "success") {
      throw new Error(`Restack agent stopped: ${message.subtype}`);
    }
  }
  return sessionId;
}

const MAX_FIX_ATTEMPTS = 2;

/** Has an agent restack the branch, then verifies it. Rolls back on failure. */
export async function restackWithAgent(repo: string, state: RestackState): Promise<boolean> {
  try {
    const guide = await restackGuide(state, "stop and say so. ummon will verify the result.");
    let sessionId = await runAgent(repo, guide);
    for (let attempt = 0; ; attempt++) {
      const result = await finishRestack(repo);
      if (result.ok) return true;
      if (attempt >= MAX_FIX_ATTEMPTS) {
        process.stderr.write(`\nRestack failed verification:\n${result.problem}\n`);
        break;
      }
      sessionId = await runAgent(repo, `Verification failed. Fix this and stop when done:\n\n${result.problem}`, sessionId);
    }
  } catch (error) {
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  }
  await abortRestack(repo);
  process.stderr.write(`Rolled back. ${state.branch} is unchanged.\n`);
  return false;
}
