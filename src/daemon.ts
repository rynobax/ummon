import { execFile, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inboxFromEnv } from "./inbox.ts";
import { BUILD_ID, type ServerState } from "./server.ts";
import type { Workspace } from "./shared/types.ts";

/**
 * How the CLI finds, starts, and talks to the shared ummon server.
 *
 * The server is best run by launchd (`ummon install`): Claude Code sessions
 * run commands in a sandbox, a server started from one inherits it, and a
 * sandboxed server can't post questions into Claude Code sessions.
 */

const LOG_FILE = join(tmpdir(), "ummon-server.log");
// Built output keeps the source layout, so cli sits next to this file as .ts
// when running from source and as .js when running from dist.
const CLI_PATH = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url));

const LAUNCH_AGENT_LABEL = "dev.ummon.server";
const LAUNCH_AGENT_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
const LAUNCH_AGENT_LOG = join(homedir(), "Library", "Logs", "ummon-server.log");

type Health = { app: string; build: string };

async function health(origin: string): Promise<Health | null> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? ((await response.json()) as Health) : null;
  } catch {
    return null;
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function post(origin: string, path: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Stops the server. Under launchd it comes straight back, running whatever code is built now. */
export async function stopServer(origin: string): Promise<boolean> {
  const before = await health(origin);
  if (!before) return false;
  await post(origin, "/api/shutdown", {}).catch(() => {});
  await waitFor(async () => (await health(origin))?.build !== before.build, 5000);
  return true;
}

/** Reads a running server's workspaces and threads, so a replacement can pick them up. */
async function exportState(origin: string): Promise<ServerState> {
  const response = await post(origin, "/api/state/export", {}).catch(() => null);
  if (response?.ok) return (await response.json()) as ServerState;
  // Servers from before export existed only list workspaces.
  const workspaces = await fetch(`${origin}/api/workspaces`)
    .then((r) => r.json() as Promise<Workspace[]>)
    .catch(() => []);
  return {
    registrations: workspaces.map(({ id, path, base, registeredAt }) => ({ id, path, base, registeredAt })),
    threads: [],
  };
}

export function isInstalled(): boolean {
  return existsSync(LAUNCH_AGENT_PLIST);
}

/**
 * Makes sure an up-to-date ummon server is running on `port` and returns its
 * origin. A server running older code is stopped; launchd restarts an
 * installed one with the new code, and otherwise a detached one is spawned.
 */
export async function ensureServer(port: number): Promise<string> {
  const origin = `http://localhost:${port}`;
  const current = await health(origin);
  if (current?.app === "ummon" && current.build === BUILD_ID) return origin;

  let carried: ServerState | null = null;
  if (current?.app === "ummon") {
    carried = await exportState(origin);
    await stopServer(origin);
  }

  const isCurrent = async () => (await health(origin))?.build === BUILD_ID;
  // launchd restarts an installed server within a second or so of it exiting.
  const started = (isInstalled() && (await waitFor(isCurrent, 5000))) || (spawnDetached(port), await waitFor(isCurrent, 10000));
  if (!started) {
    throw new Error(`Couldn't start the ummon server on port ${port}. Is something else using it? See ${LOG_FILE}`);
  }
  if (carried) await post(origin, "/api/state/import", carried).catch(() => {});
  return origin;
}

function spawnDetached(port: number) {
  const log = openSync(LOG_FILE, "a");
  spawn(process.execPath, [CLI_PATH, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
}

/**
 * Registers a workspace. When run from a Claude Code session, also passes
 * along that session's inbox so the reviewer's questions can be sent to it.
 */
export async function registerWorkspace(origin: string, path: string, base?: string): Promise<{ url: string; connected: boolean }> {
  const inbox = inboxFromEnv();
  const response = await post(origin, "/api/workspaces", { path, base, inbox });
  if (!response.ok) throw new Error(await response.text());
  const { id } = (await response.json()) as { id: string };
  return { url: `${origin}/w/${id}`, connected: inbox !== undefined };
}

export async function replyToThread(origin: string, threadId: string, text: string): Promise<void> {
  const response = await post(origin, `/api/threads/${threadId}/messages`, { from: "session", text });
  if (!response.ok) throw new Error(await response.text());
}

const execFileAsync = promisify(execFile);

function launchAgentPlist(port: number): string {
  const args = [process.execPath, CLI_PATH, "serve", "--port", String(port)];
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escape(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(process.env.PATH ?? "/usr/bin:/bin")}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>1</integer>
  <key>StandardOutPath</key><string>${escape(LAUNCH_AGENT_LOG)}</string>
  <key>StandardErrorPath</key><string>${escape(LAUNCH_AGENT_LOG)}</string>
</dict>
</plist>
`;
}

const domain = () => `gui/${userInfo().uid}`;

/** Runs the server under launchd, so it's always up and outside any sandbox. */
export async function install(port: number): Promise<void> {
  if (process.platform !== "darwin") throw new Error("`ummon install` only supports macOS.");
  const origin = `http://localhost:${port}`;
  const carried = (await health(origin))?.app === "ummon" ? await exportState(origin) : null;
  await uninstall().catch(() => {});
  await stopServer(origin);

  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await writeFile(LAUNCH_AGENT_PLIST, launchAgentPlist(port));
  try {
    await execFileAsync("launchctl", ["bootstrap", domain(), LAUNCH_AGENT_PLIST]);
  } catch (error) {
    await rm(LAUNCH_AGENT_PLIST, { force: true });
    throw new Error(
      `launchctl couldn't load the server. If this is running inside a sandbox, run \`ummon install\` in your own terminal.\n${error instanceof Error ? error.message : error}`,
    );
  }
  if (!(await waitFor(async () => (await health(origin))?.build === BUILD_ID, 10000))) {
    throw new Error(`The server didn't come up. See ${LAUNCH_AGENT_LOG}`);
  }
  if (carried) await post(origin, "/api/state/import", carried).catch(() => {});
}

export async function uninstall(): Promise<boolean> {
  if (!isInstalled()) return false;
  await execFileAsync("launchctl", ["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]).catch(() => {});
  await rm(LAUNCH_AGENT_PLIST, { force: true });
  return true;
}
