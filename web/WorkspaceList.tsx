import { useEffect, useState } from "react";
import type { Workspace } from "../src/shared/types.ts";
import { repoName } from "./Review.tsx";

export function WorkspaceList() {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/workspaces")
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        setWorkspaces(await response.json());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="min-h-screen bg-neutral-50 p-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <h1 className="text-lg font-semibold tracking-tight">ummon</h1>
      {error && <div className="mt-4 text-sm text-red-600">{error}</div>}
      {workspaces?.length === 0 && (
        <p className="mt-4 text-sm text-neutral-500">
          No workspaces yet. Run <code className="font-mono">ummon</code> in a repo to add one.
        </p>
      )}
      <ul className="mt-6 max-w-3xl space-y-1">
        {workspaces?.map((workspace) => (
          <li key={workspace.id}>
            <a
              href={`/w/${workspace.id}`}
              className="block rounded px-3 py-2 hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60"
            >
              <div className="text-sm">
                <span className="text-neutral-500">{repoName(workspace.path)} /</span>{" "}
                <span className="font-medium">{workspace.branch ?? "detached HEAD"}</span>
              </div>
              <div className="truncate font-mono text-xs text-neutral-500">{workspace.path}</div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
