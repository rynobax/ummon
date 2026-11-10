import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import type { Layer, StackFile, TestChanges, Thread, ThreadAnchor } from "../src/shared/types.ts";
import { DraftView, ThreadView, type ThreadActions } from "./Threads.tsx";

/** "dynamic" picks split or unified per file; see `wantsSplit`. */
export type DiffStyle = "dynamic" | "split" | "unified";

/**
 * True if the patch has a block where two or more lines are replaced by two
 * or more lines. Those read better side by side; pure additions, pure
 * deletions and one-line swaps read better unified.
 */
export function wantsSplit(patch: string): boolean {
  let deleted = 0;
  let added = 0;
  let inHunks = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunks = true;
    if (!inHunks || line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("-")) deleted++;
    else if (line.startsWith("+")) added++;
    else {
      if (deleted >= 2 && added >= 2) return true;
      deleted = added = 0;
    }
  }
  return deleted >= 2 && added >= 2;
}
type Tab = "source" | "tests" | "testSummary";

interface Props {
  layer: Layer;
  index: number;
  total: number;
  diffStyle: DiffStyle;
  /** Threads on this layer. */
  threads: Thread[];
  /** Whether questions can be asked: a Claude Code session is connected. */
  connected: boolean;
  actions: ThreadActions;
}

export function LayerView({ layer, index, total, diffStyle, threads, connected, actions }: Props) {
  const source = layer.files.filter((file) => !file.isTest);
  const tests = layer.files.filter((file) => file.isTest);
  const [tab, setTab] = useState<Tab>(source.length > 0 ? "source" : "tests");
  const shown = tab === "source" ? source : tests;
  const testCount = tests.reduce((total, file) => total + changeCount(file.tests), 0);

  return (
    <section>
      <header className="mb-3">
        <div className="flex items-baseline gap-3 text-xs text-neutral-500">
          <span className="font-medium uppercase tracking-wide">
            Layer {index + 1} of {total}
          </span>
          {layer.sha && <code className="font-mono">{layer.sha.slice(0, 8)}</code>}
          <span className="font-mono">
            <span className="text-green-600">+{sum(layer.files, "additions")}</span>{" "}
            <span className="text-red-600">−{sum(layer.files, "deletions")}</span>
          </span>
        </div>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{layer.title}</h2>
      </header>

      {layer.intro && (
        <div className="intro mb-4 max-w-3xl text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
          <Markdown>{layer.intro}</Markdown>
        </div>
      )}

      {tests.length > 0 && (
        <div className="mb-3 flex gap-1 border-b border-neutral-200 text-sm dark:border-neutral-800">
          {source.length > 0 && (
            <TabButton active={tab === "source"} onClick={() => setTab("source")}>
              Source <span className="text-neutral-400">{source.length}</span>
            </TabButton>
          )}
          <TabButton active={tab === "tests"} onClick={() => setTab("tests")}>
            Tests <span className="text-neutral-400">{tests.length}</span>
          </TabButton>
          <TabButton active={tab === "testSummary"} onClick={() => setTab("testSummary")}>
            Tests (summary) <span className="text-neutral-400">{testCount}</span>
          </TabButton>
        </div>
      )}

      {tab === "testSummary" ? (
        <div className="space-y-3">
          {tests.map((file) => (
            <TestSummaryView key={file.path} file={file} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((file) => (
            <FileView
              key={file.path}
              file={file}
              layerSha={layer.sha}
              diffStyle={diffStyle}
              threads={threads.filter((t) => t.path === file.path)}
              connected={connected}
              actions={actions}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type Annotation = { threadId: string } | { draft: true };

interface FileViewProps {
  file: StackFile;
  layerSha: string | null;
  diffStyle: DiffStyle;
  threads: Thread[];
  connected: boolean;
  actions: ThreadActions;
}

function FileView({ file, layerSha, diffStyle, threads, connected, actions }: FileViewProps) {
  const [draft, setDraft] = useState<ThreadAnchor | null>(null);
  // The highlighted lines: the drag in progress, then the draft's range. Kept here so closing the draft clears it.
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const closeDraft = () => {
    setDraft(null);
    setSelection(null);
  };

  const options = useMemo(
    () => ({
      diffStyle: diffStyle === "dynamic" ? (wantsSplit(file.patch) ? ("split" as const) : ("unified" as const)) : diffStyle,
      themeType: "system" as const,
      overflow: "wrap" as const,
      // The "+" button beside each line; drag it to select several lines.
      enableGutterUtility: connected,
      onLineSelectionChange: setSelection,
      onGutterUtilityClick: (range: SelectedLineRange) => {
        setSelection(range);
        setDraft({
          layerSha,
          path: file.path,
          side: range.side ?? "additions",
          start: Math.min(range.start, range.end),
          end: Math.max(range.start, range.end),
        });
      },
    }),
    [diffStyle, connected, layerSha, file.path, file.patch],
  );

  const annotations = useMemo(() => {
    const list: DiffLineAnnotation<Annotation>[] = threads.map((t) => ({
      side: t.side,
      lineNumber: t.end,
      metadata: { threadId: t.id },
    }));
    if (draft) list.push({ side: draft.side, lineNumber: draft.end, metadata: { draft: true } });
    return list;
  }, [threads, draft]);

  const renderAnnotation = (annotation: DiffLineAnnotation<Annotation>) => {
    const { metadata } = annotation;
    if ("draft" in metadata) {
      return (
        <DraftView
          onAsk={async (text) => {
            await actions.ask(draft!, text);
            closeDraft();
          }}
          onCancel={closeDraft}
        />
      );
    }
    const thread = threads.find((t) => t.id === metadata.threadId);
    return thread ? <ThreadView thread={thread} onFollowUp={(text) => actions.followUp(thread.id, text)} /> : null;
  };

  // Binary, mode-only and pure-rename changes have no hunks to render.
  if (!file.patch.includes("\n@@")) {
    const what = file.oldPath ? `Renamed from ${file.oldPath}` : "No text changes";
    return (
      <div className="rounded border border-neutral-200 px-3 py-2 font-mono text-sm dark:border-neutral-800">
        {file.path} <span className="text-neutral-500">· {what}</span>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded border border-neutral-200 dark:border-neutral-800">
      <PatchDiff<Annotation, undefined>
        patch={file.patch}
        options={options}
        selectedLines={selection}
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation}
      />
    </div>
  );
}

type Mark = { symbol: string; color: string };

const MARKS = {
  added: { symbol: "+", color: "text-green-600" },
  removed: { symbol: "−", color: "text-red-600" },
  changed: { symbol: "~", color: "text-amber-600" },
} satisfies Record<"added" | "removed" | "changed", Mark>;

/** A describe block or a test, with what's nested in it. Groups are marked only when the whole group is new or gone. */
interface TestNode {
  name: string;
  isGroup: boolean;
  mark?: Mark;
  children: TestNode[];
}

/** Merges every changed test's group path into one tree, in first-seen order. */
function testTree(changes: TestChanges): TestNode[] {
  const groupMarks = new Map<string, Mark>([
    ...changes.addedGroups.map((path) => [path.join("\0"), MARKS.added] as const),
    ...changes.removedGroups.map((path) => [path.join("\0"), MARKS.removed] as const),
  ]);
  const root: TestNode[] = [];
  for (const kind of ["added", "removed", "changed"] as const) {
    for (const path of changes[kind]) {
      let level = root;
      path.slice(0, -1).forEach((group, depth) => {
        let node = level.find((n) => n.isGroup && n.name === group);
        if (!node) {
          const mark = groupMarks.get(path.slice(0, depth + 1).join("\0"));
          level.push((node = { name: group, isGroup: true, mark, children: [] }));
        }
        level = node.children;
      });
      level.push({ name: path.at(-1)!, isGroup: false, mark: MARKS[kind], children: [] });
    }
  }
  return root;
}

function TestSummaryView({ file }: { file: StackFile }) {
  const changes = file.tests;
  return (
    <div className="rounded border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
      <div className="font-mono text-xs text-neutral-500">{file.path}</div>
      {!changes || changeCount(changes) === 0 ? (
        <div className="mt-1 text-neutral-500">
          No test declarations changed{" "}
          <span className="font-mono">
            (<span className="text-green-600">+{file.additions}</span>{" "}
            <span className="text-red-600">−{file.deletions}</span> lines)
          </span>
        </div>
      ) : (
        <TestList nodes={testTree(changes)} className="mt-1" />
      )}
    </div>
  );
}

function TestList({ nodes, className = "" }: { nodes: TestNode[]; className?: string }) {
  return (
    <ul className={`space-y-0.5 ${className}`}>
      {nodes.map((node, i) => (
        <li key={i}>
          <div className="flex gap-2">
            <span className={`w-3 shrink-0 font-mono ${node.mark?.color ?? ""}`}>{node.mark?.symbol}</span>
            <span className={node.isGroup ? "text-neutral-500" : ""}>{node.name}</span>
          </div>
          {node.children.length > 0 && (
            <TestList nodes={node.children} className="ml-1.5 mt-0.5 border-l border-neutral-200 pl-3 dark:border-neutral-800" />
          )}
        </li>
      ))}
    </ul>
  );
}

function changeCount(changes: TestChanges | undefined) {
  return changes ? changes.added.length + changes.removed.length + changes.changed.length : 0;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-1.5 ${active ? "border-neutral-900 dark:border-neutral-100" : "border-transparent text-neutral-500"}`}
    >
      {children}
    </button>
  );
}

function sum(files: StackFile[], key: "additions" | "deletions") {
  return files.reduce((total, file) => total + file[key], 0);
}
