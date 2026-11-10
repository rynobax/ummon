import type { Side, Stack, Thread, ThreadAnchor } from "./shared/types.ts";

/**
 * The messages ummon sends to a workspace's Claude Code session when the
 * reviewer asks about the diff. The session answers with `ummon reply`.
 */

export function questionMessage(stack: Stack, thread: Thread, question: string): string {
  const index = stack.layers.findIndex((layer) => layer.sha === thread.layerSha);
  const layer = stack.layers[index];
  const where = layer
    ? `Layer ${index + 1} of ${stack.layers.length}: "${layer.title}"${layer.sha ? ` (commit ${layer.sha.slice(0, 12)})` : ""}`
    : `Commit ${thread.layerSha ?? "(uncommitted changes)"}`;
  const file = layer?.files.find((f) => f.path === thread.path);
  const excerpt = file ? diffExcerpt(file.patch, thread.side, thread.start, thread.end) : "";

  return [
    `[ummon] The reviewer asked a question about this branch in ummon. The reviewer is the user you're working with.`,
    ``,
    where,
    `${thread.path}, ${describeLines(thread)}`,
    ...(excerpt ? ["```diff", excerpt, "```"] : []),
    ``,
    `Question:`,
    question,
    ``,
    replyInstructions(thread.id),
  ].join("\n");
}

export function followUpMessage(thread: Thread, text: string): string {
  return [
    `[ummon] Follow-up from the reviewer on ${thread.path}, ${describeLines(thread)}:`,
    ``,
    text,
    ``,
    replyInstructions(thread.id),
  ].join("\n");
}

function replyInstructions(threadId: string): string {
  return [
    `Answer in markdown by running:`,
    ``,
    `ummon reply ${threadId} <<'EOF'`,
    `<your answer>`,
    `EOF`,
    ``,
    `The reviewer only sees what you send with \`ummon reply\`. If they ask for a change, make it, then reply with what you changed.`,
    `Speak plainly, like one human to another. Prioritize conciseness and simplicity of language.`,
  ].join("\n");
}

function describeLines({ side, start, end }: ThreadAnchor): string {
  const lines = start === end ? `line ${start}` : `lines ${start}–${end}`;
  return `${lines} of the ${side === "additions" ? "new" : "old"} version`;
}

/**
 * The lines of a single-file patch within [start, end] on one side, with
 * their +/-/space prefixes. Line numbers are in the new file for additions
 * and the old file for deletions; context lines count on both sides.
 */
export function diffExcerpt(patch: string, side: Side, start: number, end: number): string {
  const picked: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunks = false;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunks = true;
      continue;
    }
    if (!inHunks) continue;
    const kind = line[0];
    if (kind !== " " && kind !== "+" && kind !== "-") continue; // "\ No newline at end of file"
    const onSide = kind === " " || (kind === "+") === (side === "additions");
    const number = side === "additions" ? newLine : oldLine;
    if (onSide && number >= start && number <= end) picked.push(line);
    if (kind !== "+") oldLine++;
    if (kind !== "-") newLine++;
  }
  return picked.join("\n");
}
