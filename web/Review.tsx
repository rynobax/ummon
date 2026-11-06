import { useCallback, useEffect, useRef, useState } from "react";
import type { Stack } from "../src/shared/types.ts";
import { LayerView, type DiffStyle } from "./LayerView.tsx";

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

  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  // Poll while a restack is running so the layers appear as they're committed.
  useEffect(() => {
    if (!stack?.restackInProgress) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [stack?.restackInProgress, load]);

  return { stack, error, reload: load };
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
  const { stack, error, reload } = useStack(workspaceId);
  const selectedFromHash = useSelectedLayerFromHash();
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(
    () => (localStorage.getItem("ummon.diffStyle") as DiffStyle | null) ?? "split",
  );

  const toggleDiffStyle = () => {
    const next = diffStyle === "split" ? "unified" : "split";
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
      <aside className="sticky top-0 h-screen w-72 shrink-0 overflow-y-auto border-r border-neutral-200 p-4 dark:border-neutral-800">
        <a href="/" className="text-lg font-semibold tracking-tight hover:underline">
          ummon
        </a>
        <div className="mt-1 truncate font-mono text-xs text-neutral-500" title={stack.repo}>
          {stack.branch ?? stack.headSha.slice(0, 12)}
        </div>
        <div className="font-mono text-xs text-neutral-500">from {stack.baseRef.slice(0, 40)}</div>

        <nav className="mt-6 space-y-1">
          {stack.layers.map((layer, index) => (
            <a
              key={layer.sha ?? "uncommitted"}
              href={`#layer-${index + 1}`}
              aria-current={index === selected ? "page" : undefined}
              className={`flex gap-2 rounded px-2 py-1.5 text-sm ${
                index === selected
                  ? "bg-neutral-200 font-medium dark:bg-neutral-800"
                  : "hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60"
              }`}
            >
              <span className="w-5 shrink-0 text-right font-mono text-neutral-400">{index + 1}</span>
              <span className="leading-snug">{layer.title}</span>
            </a>
          ))}
        </nav>

        <div className="mt-6 flex gap-2 text-xs">
          <button onClick={toggleDiffStyle} className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700">
            {diffStyle === "split" ? "Unified" : "Split"}
          </button>
          <button onClick={reload} className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700">
            Refresh
          </button>
        </div>
        {error && <div className="mt-4 text-xs text-red-600">{error}</div>}
      </aside>

      <main className="min-w-0 flex-1 space-y-6 p-8">
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
          />
        ) : (
          <div className="text-sm text-neutral-500">No changes</div>
        )}
      </main>
    </div>
  );
}
