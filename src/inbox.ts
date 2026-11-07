import { connect } from "node:net";

/**
 * A Claude Code session's inbox. Every session listens on a Unix socket and
 * exports its path and token as CLAUDE_CODE_MESSAGING_SOCKET and
 * CLAUDE_CODE_MESSAGING_TOKEN. A message written there arrives in the session
 * as a user message, and wakes the session if it's idle.
 */
export interface Inbox {
  socket: string;
  token: string;
}

export function inboxFromEnv(env: NodeJS.ProcessEnv = process.env): Inbox | undefined {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  return socket && token ? { socket, token } : undefined;
}

const POST_TIMEOUT_MS = 2000;

/** Claude Code's inbox protocol: an auth line, then a user message, one JSON object per line. */
export function postToInbox(inbox: Inbox, text: string): Promise<void> {
  const payload =
    JSON.stringify({ type: "auth", token: inbox.token }) +
    "\n" +
    JSON.stringify({ type: "user", message: { role: "user", content: text } }) +
    "\n";
  return new Promise((resolve, reject) => {
    const socket = connect(inbox.socket);
    socket.setTimeout(POST_TIMEOUT_MS, () => socket.destroy(new Error("Timed out posting to the session.")));
    socket.once("error", (error: NodeJS.ErrnoException) => reject(describe(error)));
    socket.once("connect", () => socket.end(payload, () => resolve()));
  });
}

function describe(error: NodeJS.ErrnoException): Error {
  if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
    return new Error("The Claude Code session has ended. Run `ummon` from a live session to reconnect.");
  }
  if (error.code === "EPERM") {
    return new Error(
      "The ummon server is running in a sandbox that can't reach Claude Code sessions. Run `ummon install` in your own terminal.",
    );
  }
  return error;
}
