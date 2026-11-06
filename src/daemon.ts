import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_ID } from "./server.ts";
import type { Workspace } from "./shared/types.ts";

/** How the CLI finds, starts, and talks to the shared ummon server. */

const LOG_FILE = join(tmpdir(), "ummon-server.log");
// Built output keeps the source layout, so cli sits next to this file as .ts
// when running from source and as .js when running from dist.
const CLI_PATH = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url));

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

export async function stopServer(origin: string): Promise<boolean> {
  if (!(await health(origin))) return false;
  await post(origin, "/api/shutdown", {}).catch(() => {});
  await waitFor(async () => (await health(origin)) === null, 5000);
  return true;
}

/**
 * Makes sure an up-to-date ummon server is running on `port`, starting a
 * detached one if needed. Returns its origin.
 */
export async function ensureServer(port: number): Promise<string> {
  const origin = `http://localhost:${port}`;
  const current = await health(origin);
  if (current?.app === "ummon" && current.build === BUILD_ID) return origin;

  // A server running older code: replace it, keeping its workspaces.
  let carried: Workspace[] = [];
  if (current?.app === "ummon") {
    carried = await fetch(`${origin}/api/workspaces`)
      .then((response) => response.json() as Promise<Workspace[]>)
      .catch(() => []);
    await stopServer(origin);
  }

  const log = openSync(LOG_FILE, "a");
  spawn(process.execPath, [CLI_PATH, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();

  const started = await waitFor(async () => (await health(origin))?.build === BUILD_ID, 10000);
  if (!started) {
    throw new Error(`Couldn't start the ummon server on port ${port}. Is something else using it? See ${LOG_FILE}`);
  }
  for (const workspace of carried.reverse()) {
    await registerWorkspace(origin, workspace.path, workspace.base).catch(() => {});
  }
  return origin;
}

export async function registerWorkspace(origin: string, path: string, base?: string): Promise<string> {
  const response = await post(origin, "/api/workspaces", { path, base });
  if (!response.ok) throw new Error(await response.text());
  const { id } = (await response.json()) as { id: string };
  return `${origin}/w/${id}`;
}
