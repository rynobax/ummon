import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { Thread, ThreadAnchor } from "../src/shared/types.ts";

/** Questions on the diff, answered by the workspace's Claude Code session. */

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export interface ThreadActions {
  ask(anchor: ThreadAnchor, text: string): Promise<void>;
  followUp(threadId: string, text: string): Promise<void>;
}

export function useThreads(workspaceId: string): { threads: Thread[]; actions: ThreadActions } {
  const [threads, setThreads] = useState<Thread[]>([]);

  // The server sends every thread on connect and again on each change. EventSource reconnects on its own.
  useEffect(() => {
    const events = new EventSource(`/api/workspaces/${workspaceId}/threads/events`);
    events.onmessage = (event) => setThreads(JSON.parse(event.data));
    return () => events.close();
  }, [workspaceId]);

  const actions: ThreadActions = {
    async ask(anchor, text) {
      await postJson(`/api/workspaces/${workspaceId}/threads`, { anchor, text });
    },
    async followUp(threadId, text) {
      await postJson(`/api/threads/${threadId}/messages`, { from: "reviewer", text });
    },
  };
  return { threads, actions };
}

/**
 * Whether a thread is minimized. Kept in localStorage rather than component
 * state, because the diff may remount annotations when it re-renders.
 */
function useMinimized(threadId: string): [boolean, (value: boolean) => void] {
  const key = `ummon.minimized.${threadId}`;
  const [minimized, setMinimized] = useState(() => localStorage.getItem(key) === "1");
  const set = (value: boolean) => {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
    setMinimized(value);
  };
  return [minimized, set];
}

export function ThreadView({ thread, onFollowUp }: { thread: Thread; onFollowUp: (text: string) => Promise<void> }) {
  const [minimized, setMinimized] = useMinimized(thread.id);
  const replies = thread.messages.length - 1;

  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="m-2 flex max-w-3xl items-center gap-2 rounded border border-neutral-300 bg-white px-3 py-1 text-left font-sans text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
      >
        <span>▸</span>
        <span className="truncate text-neutral-700 dark:text-neutral-300">{thread.messages[0]?.text}</span>
        <span className="shrink-0">
          {thread.waiting ? "waiting" : `${replies} ${replies === 1 ? "reply" : "replies"}`}
        </span>
      </button>
    );
  }

  return (
    <AnnotationBox>
      <button onClick={() => setMinimized(true)} className="float-right text-xs text-neutral-500" title="Minimize">
        ▾
      </button>
      <div className="space-y-3">
        {thread.messages.map((message, i) => (
          <div key={i}>
            <div className="mb-0.5 text-xs font-medium text-neutral-500">{message.from === "reviewer" ? "You" : "Claude"}</div>
            <div className="intro text-sm leading-relaxed">
              <Markdown>{message.text}</Markdown>
            </div>
          </div>
        ))}
      </div>
      {thread.waiting && <div className="mt-2 animate-pulse text-xs text-neutral-500">Waiting for Claude…</div>}
      {thread.error && <div className="mt-2 text-xs text-red-600">{thread.error}</div>}
      {!thread.waiting && <Composer placeholder="Reply" submitLabel="Reply" onSubmit={onFollowUp} />}
    </AnnotationBox>
  );
}

export function DraftView({ onAsk, onCancel }: { onAsk: (text: string) => Promise<void>; onCancel: () => void }) {
  return (
    <AnnotationBox>
      <Composer placeholder="Ask about these lines" submitLabel="Ask" onSubmit={onAsk} onCancel={onCancel} autoFocus />
    </AnnotationBox>
  );
}

function AnnotationBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="m-2 max-w-3xl rounded border border-neutral-300 bg-white px-3 py-2 font-sans dark:border-neutral-700 dark:bg-neutral-900">
      {children}
    </div>
  );
}

function Composer({
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (text: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // `autoFocus` alone misses: the diff mounts annotations before attaching them to the page.
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => textarea.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(text.trim());
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel?.();
        }}
        placeholder={placeholder}
        ref={textarea}
        rows={2}
        className="w-full resize-y rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
      />
      <div className="mt-1 flex items-center gap-2 text-xs">
        <button
          onClick={submit}
          disabled={!text.trim() || sending}
          className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {sending ? "Sending…" : submitLabel}
        </button>
        {onCancel && (
          <button onClick={onCancel} className="px-2 py-1 text-neutral-500">
            Cancel
          </button>
        )}
        <span className="text-neutral-400">⇧↵ for a new line</span>
        {error && <span className="text-red-600">{error}</span>}
      </div>
    </div>
  );
}
