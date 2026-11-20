import { useCallback, useEffect, useRef, useState } from "react";
import type { Stack, Workspace } from "../src/shared/types.ts";
import { ChangeCounts, LayerView, type DiffStyle } from "./LayerView.tsx";
import { useThreads } from "./Threads.tsx";

/** Whether the workspace's Claude Code session can take questions. Rechecked on focus, since rerunning `ummon` connects it. */
function useConnected(workspaceId: string): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const load = () =>
      fetch("/api/workspaces")
        .then((r) => r.json() as Promise<Workspace[]>)
        .then((list) => setConnected(list.find((w) => w.id === workspaceId)?.connected ?? false))
        .catch(() => {});
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [workspaceId]);
  return connected;
}

const POLL_MS = 2000;

function useStack(workspaceId: string) {
  const [stack, setStack] = useState<Stack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastBody = useRef("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/stack`);
      const body = await response.text();
      if (!response.ok) throw new Error(body);
      setError(null);
      // Skip re-rendering every diff when nothing changed.
      if (body !== lastBody.current) {
        lastBody.current = body;
        setStack(JSON.parse(body));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId]);

  // Poll while the tab is visible, so commits, restacks and edits show up on their own.
  useEffect(() => {
    load();
    const timer = setInterval(() => document.visibilityState === "visible" && load(), POLL_MS);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  return { stack, error };
}

/**
 * The selected layer lives in the URL hash (#layer-3, 1-based like the
 * sidebar), so refreshing keeps your place and back/forward step between
 * layers you've visited.
 */
function useSelectedLayerFromHash(): number {
  const read = () => {
    const match = window.location.hash.match(/^#layer-(\d+)$/);
    return match ? Math.max(Number(match[1]) - 1, 0) : 0;
  };
  const [index, setIndex] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setIndex(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return index;
}

export function Review({ workspaceId }: { workspaceId: string }) {
  const { stack, error } = useStack(workspaceId);
  const selectedFromHash = useSelectedLayerFromHash();
  const { threads, actions } = useThreads(workspaceId);
  const connected = useConnected(workspaceId);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(
    () => (localStorage.getItem("ummon.diffStyle") as DiffStyle | null) ?? "dynamic",
  );

  const chooseDiffStyle = (next: DiffStyle) => {
    localStorage.setItem("ummon.diffStyle", next);
    setDiffStyle(next);
  };

  const selected = Math.min(selectedFromHash, Math.max((stack?.layers.length ?? 1) - 1, 0));
  const current = stack?.layers[selected];

  if (!stack) {
    return (
      <div className="p-8 text-sm text-neutral-500">
        {error ?? "Loading…"}
        {error && (
          <a href="/" className="mt-2 block underline">
            All workspaces
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <aside className="sticky top-0 h-screen w-60 shrink-0 overflow-y-auto border-r border-neutral-200 p-4 dark:border-neutral-800">
        <a href="/" className="text-lg font-semibold tracking-tight hover:underline">
          ummon
        </a>
        <div className="mt-1 truncate font-mono text-xs text-neutral-500" title={stack.repo}>
          <span className="text-neutral-700 dark:text-neutral-300">{repoName(stack.repo)}</span>
          {" / "}
          {stack.branch ?? stack.headSha.slice(0, 12)}
        </div>
        <div className="font-mono text-xs text-neutral-500">from {stack.baseRef.slice(0, 40)}</div>
        <div className="mt-1 text-xs">
          <ChangeCounts files={stack.layers.flatMap((layer) => layer.files)} />
        </div>

        <nav className="mt-6 space-y-1">
          {stack.layers.map((layer, index) => (
            <a
              key={layer.sha ?? "uncommitted"}
              href={`#layer-${index + 1}`}
              aria-current={index === selected ? "page" : undefined}
              className={`flex gap-2 rounded py-1.5 pl-1.5 pr-2 text-sm ${
                index === selected
                  ? "bg-neutral-200 font-medium dark:bg-neutral-800"
                  : "hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60"
              }`}
            >
              <span className="shrink-0 text-right font-mono text-neutral-400" style={{ width: `${String(stack.layers.length).length}ch` }}>
                {index + 1}
              </span>
              <span className="leading-snug">{layer.title}</span>
            </a>
          ))}
        </nav>

        <div className="mt-6 flex overflow-hidden rounded border border-neutral-300 text-xs dark:border-neutral-700">
          {(["dynamic", "unified", "split"] as const).map((style) => (
            <button
              key={style}
              onClick={() => chooseDiffStyle(style)}
              title={style === "dynamic" ? "Split for files that replace blocks of lines, unified otherwise" : undefined}
              className={`flex-1 px-2 py-1 capitalize ${style === diffStyle ? "bg-neutral-200 font-medium dark:bg-neutral-800" : "text-neutral-500"}`}
            >
              {style}
            </button>
          ))}
        </div>
        {!connected && (
          <div className="mt-6 text-xs text-neutral-500">
            To ask questions on the diff, run <code>ummon</code> from this workspace's Claude Code session.
          </div>
        )}
        {error && <div className="mt-4 text-xs text-red-600">{error}</div>}
      </aside>

      <main className="min-w-0 flex-1 space-y-6 p-6">
        {stack.restackInProgress && (
          <div className="rounded border border-amber-400/50 bg-amber-100/50 px-4 py-2 text-sm dark:bg-amber-900/20">
            Restack in progress
          </div>
        )}
        {current ? (
          <LayerView
            key={current.sha ?? "uncommitted"}
            layer={current}
            index={selected}
            total={stack.layers.length}
            diffStyle={diffStyle}
            threads={threads.filter((t) => t.layerSha === current.sha)}
            connected={connected}
            actions={actions}
          />
        ) : (
          <div className="text-sm text-neutral-500">No changes</div>
        )}
      </main>
    </div>
  );
}

/** The repo's directory name, which tells apart workspaces on the same branch in different repos. */
export function repoName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
