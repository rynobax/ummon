#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { restackWithAgent } from "./agent.ts";
import { abortRestack, beginRestack, finishRestack, restackGuide } from "./restack.ts";
import { ensureServer, registerWorkspace, stopServer } from "./daemon.ts";
import { DEFAULT_PORT, runServer } from "./server.ts";
import { resolveRepo } from "./stack.ts";

const HELP = `ummon: layered code review

Usage:
  ummon [--base <ref>] [--no-open]                Review the current branch in the browser
  ummon restack [--base <ref>]                    Have an agent restack the current branch in place
  ummon restack begin [--base <ref>]              Start a manual restack and print the guide
  ummon restack finish                            Verify a manual restack and move the branch
  ummon restack abort                             Abandon a restack and restore the branch
  ummon guide                                     Print the review workflow for a coding agent
  ummon stop                                      Stop the ummon server
  ummon serve                                     Run the ummon server in the foreground

One ummon server on port ${DEFAULT_PORT} (or --port) serves every workspace. Running
\`ummon\` starts it if needed and registers the current workspace with it.
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

async function main() {
  const [command, subcommand] = positionals;
  if (values.help || command === "help") return console.log(HELP);
  if (command === "guide") {
    return console.log(await readFile(new URL("./prompts/workflow.md", import.meta.url), "utf8"));
  }

  const port = Number(values.port);
  if (command === "serve") return runServer(port);
  if (command === "stop") {
    const stopped = await stopServer(`http://localhost:${port}`);
    return console.log(stopped ? "Stopped the ummon server." : "No ummon server is running.");
  }

  const repo = await resolveRepo(process.cwd());

  if (command === undefined) {
    const url = await registerWorkspace(await ensureServer(port), repo, values.base);
    console.log(`ummon is reviewing ${repo} at ${url}`);
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
