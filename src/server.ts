import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gitMaybe } from "./git.ts";
import { postToInbox, type Inbox } from "./inbox.ts";
import type { Thread, ThreadAnchor, Workspace } from "./shared/types.ts";
import { readStack, resolveRepo } from "./stack.ts";
import { followUpMessage, questionMessage } from "./threads.ts";

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
  /** The inbox of the Claude Code session that ran `ummon`. Never sent to the browser. */
  inbox?: Inbox;
}

interface StoredThread extends Thread {
  workspaceId: string;
}

/** Everything the server holds, so the CLI can carry it over when it replaces a stale server. */
export interface ServerState {
  registrations: Registration[];
  threads: StoredThread[];
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
 * Workspaces and threads are held in memory only. The server may run in a
 * sandbox that can't write outside its own temp folder, and when the CLI
 * replaces a stale server it carries the state over.
 */
export function createApp() {
  const registrations = new Map<string, Registration>();
  const threads = new Map<string, StoredThread>();
  /** Open thread streams, each told when a workspace's threads change. */
  const watchers = new Set<{ workspaceId: string; send: () => void }>();

  const publicThread = ({ workspaceId: _, ...thread }: StoredThread): Thread => thread;
  const threadsOf = (workspaceId: string) =>
    [...threads.values()].filter((t) => t.workspaceId === workspaceId).map(publicThread);

  function threadsChanged(workspaceId: string) {
    for (const watcher of watchers) if (watcher.workspaceId === workspaceId) watcher.send();
  }

  /** Sends a reviewer message to the workspace's session, recording on the thread whether that worked. */
  async function deliver(thread: StoredThread, message: () => Promise<string>) {
    const inbox = registrations.get(thread.workspaceId)?.inbox;
    try {
      if (!inbox) throw new Error("No Claude Code session is connected. Run `ummon` from one to connect it.");
      await postToInbox(inbox, await message());
      thread.error = undefined;
    } catch (error) {
      thread.waiting = false;
      thread.error = error instanceof Error ? error.message : String(error);
    }
  }

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
    const { path, base, inbox } = await c.req.json<{ path: string; base?: string; inbox?: Inbox }>();
    const repo = await resolveRepo(path);
    const registration = { id: workspaceId(repo), path: repo, base, inbox, registeredAt: new Date().toISOString() };
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
        connected: r.inbox !== undefined,
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

  /** Sends the workspace's threads on connect, then again whenever they change. */
  app.get("/api/workspaces/:id/threads/events", (c) => {
    const workspaceId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const watcher = { workspaceId, send: () => void stream.writeSSE({ data: JSON.stringify(threadsOf(workspaceId)) }) };
      watchers.add(watcher);
      watcher.send();
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      watchers.delete(watcher);
    });
  });

  app.post("/api/workspaces/:id/threads", async (c) => {
    if (!isTrustedWrite(c)) return c.text("Forbidden", 403);
    const registration = registrations.get(c.req.param("id"));
    if (!registration) return c.text("Unknown workspace.", 404);
    const { anchor, text } = await c.req.json<{ anchor: ThreadAnchor; text: string }>();
    const { layerSha, path, side, start, end } = anchor;
    const thread: StoredThread = {
      id: randomUUID().slice(0, 8),
      workspaceId: registration.id,
      layerSha, path, side, start, end,
      messages: [{ from: "reviewer", text, at: new Date().toISOString() }],
      waiting: true,
    };
    threads.set(thread.id, thread);
    await deliver(thread, async () => questionMessage(await readStack(registration.path, registration.base), thread, text));
    threadsChanged(thread.workspaceId);
    return c.json(publicThread(thread));
  });

  /** Messages on a thread: `from: "reviewer"` from the page, `from: "session"` from `ummon reply`. */
  app.post("/api/threads/:id/messages", async (c) => {
    if (!isTrustedWrite(c)) return c.text("Forbidden", 403);
    const thread = threads.get(c.req.param("id"));
    if (!thread) return c.text("Unknown thread. It may have been lost when the ummon server restarted.", 404);
    const { from, text } = await c.req.json<{ from: "reviewer" | "session"; text: string }>();
    thread.messages.push({ from, text, at: new Date().toISOString() });
    if (from === "session") {
      thread.waiting = false;
      thread.error = undefined;
    } else {
      thread.waiting = true;
      await deliver(thread, async () => followUpMessage(thread, text));
    }
    threadsChanged(thread.workspaceId);
    return c.json(publicThread(thread));
  });

  app.post("/api/state/export", (c) => {
    if (!isTrustedWrite(c)) return c.text("Forbidden", 403);
    return c.json({ registrations: [...registrations.values()], threads: [...threads.values()] } satisfies ServerState);
  });

  app.post("/api/state/import", async (c) => {
    if (!isTrustedWrite(c)) return c.text("Forbidden", 403);
    const state = await c.req.json<ServerState>();
    for (const r of state.registrations) if (!registrations.has(r.id)) registrations.set(r.id, r);
    for (const t of state.threads) if (!threads.has(t.id)) threads.set(t.id, t);
    for (const id of new Set(state.threads.map((t) => t.workspaceId))) threadsChanged(id);
    return c.json({ ok: true });
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
