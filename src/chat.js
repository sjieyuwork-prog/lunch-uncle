import { runLoop } from "./loop.js";

// Limits on what one /chat request can make the model read.
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_MESSAGE_CHARS = 1000;
export const MAX_HISTORY_MESSAGES = 20;

const HISTORY_ROLES = new Set(["user", "assistant"]);
// The page's conversation id, sent on as the x-opencode-session header.
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Handle POST /chat: check the request, run one turn, and reply with JSON.
 */
export async function handleChat(request, env) {
  if (!(await withinRateLimit(request, env))) {
    return json({ error: "Uncle is busy. Wait a minute and try again." }, 429);
  }

  // Insisting on JSON also stops other sites posting here from a browser:
  // that needs a CORS preflight, which this Worker never approves.
  const type = request.headers.get("content-type") ?? "";
  if (type.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "Send the request as application/json" }, 415);
  }

  // content-length can be missing, so check the size again after reading.
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    return json({ error: "Request is too large" }, 413);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return json({ error: "Request is too large" }, 413);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const turn = parseTurn(body);
  if (turn.error) {
    return json({ error: turn.error }, 400);
  }

  try {
    const reply = await runLoop(
      turn.history,
      turn.message,
      env,
      turn.sessionId,
    );
    return json({ reply });
  } catch (err) {
    console.error("chat failed:", err);
    return json({ error: "Uncle cannot think right now, try again later." }, 500);
  }
}

/**
 * Count this request against its client's limit, set in wrangler.toml.
 * Without the CHAT_LIMITER binding, as in tests, nothing is limited.
 */
async function withinRateLimit(request, env) {
  if (!env.CHAT_LIMITER) {
    return true;
  }
  // The hostname keeps apart Workers that share a limiter namespace.
  const { hostname } = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.CHAT_LIMITER.limit({
    key: `${hostname} ${ip}`,
  });
  return success;
}

/**
 * Check a parsed /chat body. Returns {history, message, sessionId}, or
 * {error} if the body is not valid.
 *
 * History may only hold user and assistant messages, so a client cannot
 * slip in its own system prompt or tool results. Only the most recent
 * messages are kept, with any extra fields dropped. A session id that does
 * not look like one is ignored, and the turn gets a fresh one.
 */
function parseTurn(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }

  const { history = [], message } = body;
  if (typeof message !== "string" || message.trim() === "") {
    return { error: "message is required" };
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return { error: `message must be ${MAX_MESSAGE_CHARS} characters or fewer` };
  }

  if (!Array.isArray(history) || !history.every(isChatMessage)) {
    return { error: "history must be a list of user and assistant messages" };
  }

  const { session } = body;
  return {
    message,
    history: history
      .slice(-MAX_HISTORY_MESSAGES)
      .map(({ role, content }) => ({ role, content })),
    sessionId:
      typeof session === "string" && SESSION_ID.test(session)
        ? session
        : undefined,
  };
}

function isChatMessage(entry) {
  return (
    typeof entry === "object" &&
    entry !== null &&
    HISTORY_ROLES.has(entry.role) &&
    typeof entry.content === "string"
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
