#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { restackWithAgent } from "./agent.ts";
import { abortRestack, beginRestack, finishRestack, restackGuide } from "./restack.ts";
import { ensureServer, install, isInstalled, registerWorkspace, replyToThread, stopServer, uninstall } from "./daemon.ts";
import { DEFAULT_PORT, runServer } from "./server.ts";
import { resolveRepo } from "./stack.ts";

const HELP = `ummon: layered code review

Usage:
  ummon [--base <ref>] [--no-open]                Review the current branch in the browser
  ummon restack [--base <ref>]                    Have an agent restack the current branch in place
  ummon restack begin [--base <ref>]              Start a manual restack and print the guide
  ummon restack finish                            Verify a manual restack and move the branch
  ummon restack abort                             Abandon a restack and restore the branch
  ummon reply <thread>                            Answer a reviewer's question, reading markdown from stdin
  ummon guide                                     Print the review workflow for a coding agent
  ummon install                                   Run the ummon server with launchd (macOS)
  ummon uninstall                                 Stop running the server with launchd
  ummon stop                                      Stop the ummon server
  ummon serve                                     Run the ummon server in the foreground

One ummon server on port ${DEFAULT_PORT} (or --port) serves every workspace. Running
\`ummon\` starts it if needed and registers the current workspace with it.
Run from a Claude Code session, it also connects that session, so questions
asked on the diff are sent to it. That needs a server outside the session's
sandbox: run \`ummon install\` once in your own terminal.
The base defaults to the branch this one is stacked on, if any, otherwise the
merge-base with origin/HEAD (or main/master).
Every restack backs up the original head under refs/ummon/backup/. Backups of
branches that no longer exist are deleted at the start of the next restack.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    port: { type: "string", default: String(DEFAULT_PORT) },
    "no-open": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function openBrowser(url: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // Sandboxes (such as Claude Code's) often block opening a browser, so say so
  // rather than leaving the user wondering whether the server started.
  let reported = false;
  const failed = () => {
    if (!reported) console.log(`Couldn't open a browser. Open ${url} yourself.`);
    reported = true;
  };
  spawn(opener, [url], { stdio: "ignore" })
    .on("error", failed)
    .on("exit", (code) => code !== 0 && failed());
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [command, subcommand] = positionals;
  if (values.help || command === "help") return console.log(HELP);
  if (command === "guide") {
    return console.log(await readFile(new URL("./prompts/workflow.md", import.meta.url), "utf8"));
  }

  const port = Number(values.port);
  const origin = `http://localhost:${port}`;
  if (command === "serve") return runServer(port);
  if (command === "stop") {
    if (isInstalled()) return console.log("The ummon server runs under launchd. Run `ummon uninstall` to stop it.");
    const stopped = await stopServer(origin);
    return console.log(stopped ? "Stopped the ummon server." : "No ummon server is running.");
  }
  if (command === "install") {
    await install(port);
    return console.log(`The ummon server now runs under launchd at ${origin}, and starts when you log in.`);
  }
  if (command === "uninstall") {
    return console.log((await uninstall()) ? "Removed the ummon launch agent and stopped its server." : "ummon isn't installed.");
  }
  if (command === "reply") {
    if (!subcommand) throw new Error("Usage: ummon reply <thread> <<'EOF' ... EOF");
    const text = positionals.length > 2 ? positionals.slice(2).join(" ") : await readStdin();
    if (!text.trim()) throw new Error("The reply is empty. Pass it on stdin.");
    await replyToThread(origin, subcommand, text.trim());
    return console.log("Sent your reply to the reviewer.");
  }

  const repo = await resolveRepo(process.cwd());

  if (command === undefined) {
    const { url, connected } = await registerWorkspace(await ensureServer(port), repo, values.base);
    console.log(`ummon is reviewing ${repo} at ${url}`);
    if (connected) {
      console.log("Questions the reviewer asks on the diff will arrive in this Claude Code session as messages starting with [ummon].");
    }
    if (!values["no-open"]) openBrowser(url);
    return;
  }

  if (command === "restack") {
    if (subcommand === undefined) {
      const state = await beginRestack(repo, values.base);
      console.error(`Restacking ${state.branch} (backup at ${state.backupRef})`);
      const ok = await restackWithAgent(repo, state);
      if (ok) console.log(`Restacked ${state.branch}. Undo with: git reset --hard ${state.backupRef}`);
      process.exitCode = ok ? 0 : 1;
      return;
    }
    if (subcommand === "begin") {
      const state = await beginRestack(repo, values.base);
      return console.log(await restackGuide(state, "run `ummon restack finish`."));
    }
    if (subcommand === "finish") {
      const result = await finishRestack(repo);
      if (!result.ok) {
        console.error(result.problem);
        process.exitCode = 1;
        return;
      }
      return console.log(`Restacked ${result.state.branch}. Undo with: git reset --hard ${result.state.backupRef}`);
    }
    if (subcommand === "abort") {
      const state = await abortRestack(repo);
      return console.log(`Restored ${state.branch} to ${state.origHead.slice(0, 12)}.`);
    }
  }

  console.error(HELP);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
