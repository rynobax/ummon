import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gitMaybe } from "./git.ts";
import type { Workspace } from "./shared/types.ts";
import { readStack, resolveRepo } from "./stack.ts";

/**
 * One ummon server serves every workspace. `ummon` registers the current
 * repo with it and prints a link to /w/<id>.
 */

export const DEFAULT_PORT = 7337;

/**
 * Identifies the code the server is running. Changes whenever ummon is
 * rebuilt, so the CLI can replace a server that's running stale code.
 */
export const BUILD_ID = String(statSync(fileURLToPath(import.meta.url)).mtimeMs);

// Compiled, this file sits at dist/server.js next to dist/web. Run from source
// (pnpm dev:server), it sits at src/server.ts.
const WEB_DIR =
  [new URL("./web", import.meta.url), new URL("../dist/web", import.meta.url)]
    .map((url) => fileURLToPath(url))
    .find((dir) => existsSync(dir)) ?? fileURLToPath(new URL("./web", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

interface Registration {
  id: string;
  path: string;
  base?: string;
  registeredAt: string;
}

export function workspaceId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 10);
}

/**
 * Only the ummon CLI should register workspaces or stop the server. Requiring
 * a JSON content type forces a CORS preflight for cross-origin pages, and the
 * Origin check rejects any browser page other than ummon's own.
 */
function isTrustedWrite(c: Context): boolean {
  const origin = c.req.header("origin");
  const host = c.req.header("host");
  const sameOrigin = origin === undefined || origin === `http://${host}`;
  return sameOrigin && (c.req.header("content-type") ?? "").startsWith("application/json");
}

/**
 * Workspaces are held in memory only. The server is often started from a
 * sandboxed Claude Code session that can't write outside its own temp
 * folder, and when the CLI replaces a stale server it carries the list over.
 */
export function createApp() {
  const registrations = new Map<string, Registration>();

  const app = new Hono();
  app.onError((error, c) => c.text(error.message, 500));

  app.get("/api/health", (c) => c.json({ app: "ummon", build: BUILD_ID }));

  app.post("/api/shutdown", (c) => {
    if (!isTrustedWrite(c)) return c.text("Forbidden", 403);
    setTimeout(() => process.exit(0), 50);
    return c.json({ ok: true });
  });

  app.post("/api/workspaces", async (c) => {
    if (!isTrustedWrite(c)) return c.text("Forbidden", 403);
    const { path, base } = await c.req.json<{ path: string; base?: string }>();
    const repo = await resolveRepo(path);
    const registration = { id: workspaceId(repo), path: repo, base, registeredAt: new Date().toISOString() };
    registrations.set(registration.id, registration);
    return c.json({ id: registration.id });
  });

  app.get("/api/workspaces", async (c) => {
    const present = [...registrations.values()].filter((r) => existsSync(r.path));
    const workspaces: Workspace[] = await Promise.all(
      present.map(async (r) => ({
        id: r.id,
        path: r.path,
        base: r.base,
        branch: await gitMaybe(r.path, ["symbolic-ref", "--short", "-q", "HEAD"]),
        registeredAt: r.registeredAt,
      })),
    );
    workspaces.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
    return c.json(workspaces);
  });

  app.get("/api/workspaces/:id/stack", async (c) => {
    const registration = registrations.get(c.req.param("id"));
    if (!registration) return c.text("Unknown workspace. Run `ummon` in it to register it.", 404);
    return c.json(await readStack(registration.path, registration.base));
  });

  app.get("*", async (c) => {
    const requested = normalize(c.req.path).replace(/^(\.\.[/\\])+/, "");
    for (const path of [join(WEB_DIR, requested), join(WEB_DIR, "index.html")]) {
      try {
        const body = await readFile(path);
        return c.body(body, 200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      } catch {
        // Fall through to index.html so client-side routes work.
      }
    }
    return c.text("The web UI has not been built. Run `pnpm build` in the ummon repo.", 500);
  });

  return app;
}

export async function runServer(port: number): Promise<void> {
  const app = createApp();
  await new Promise<void>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => resolve());
    server.once("error", reject);
  });
  console.log(`ummon server listening on http://localhost:${port}`);
}
