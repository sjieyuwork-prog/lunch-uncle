import { buildSystemPrompt, userMessage } from "./prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";

// TODO: set the base URL and model for your OpenAI-compatible provider.
const LLM_BASE_URL = "TODO";
const LLM_MODEL = "TODO";

const LLM_TIMEOUT_MS = 20_000;
// No round starts after this, so even a slow turn answers well before the
// page stops waiting at 90 s.
const TURN_BUDGET_MS = 45_000;
export const MAX_ROUNDS = 8;
export const MAX_TOOL_CALLS_PER_ROUND = 4;
// Room for a 120-word reply or a few tool calls, but not for an essay.
const MAX_REPLY_TOKENS = 1024;

const FALLBACK_REPLY = "Just go Berseh Food Centre lah.";
const GIVE_UP_REPLY =
  "Uncle tried too many times already. Ask something simpler.";
const EMPTY_REPLY = "Uncle got nothing to say. Ask again lah.";
const FILTERED_REPLY = "Uncle won't answer that one. Ask about lunch lah.";
const FOOD_WORDS = /\b(eat|lunch|food|makan|hungry|restaurant|hawker)\b/i;

/**
 * Run the agentic loop for one user turn and return Uncle's reply.
 *
 * history is the prior conversation as OpenAI-style {role, content} messages.
 * sessionId identifies the conversation to the OpenCode Go endpoint, which
 * uses it to route every model call the same way and so reuse its cache.
 * Without one from the page, each turn gets its own.
 */
export async function runLoop(
  history,
  message,
  env,
  sessionId = crypto.randomUUID(),
) {
  // If the Places key is missing, Uncle cannot search, so give food questions
  // a safe answer. Rain and bus questions do not need the key.
  if (!env.GOOGLE_PLACES_API_KEY && FOOD_WORDS.test(message)) {
    return FALLBACK_REPLY;
  }

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
    userMessage(message, new Date()),
  ];

  const deadline = Date.now() + TURN_BUDGET_MS;
  // Each distinct tool call runs once per turn; repeats reuse its result.
  const toolResults = new Map();

  for (let round = 0; round < MAX_ROUNDS && Date.now() < deadline; round++) {
    // On the last round, or with no time left for another, Uncle must
    // answer from what he has found so far.
    const lastRound =
      round === MAX_ROUNDS - 1 || Date.now() + LLM_TIMEOUT_MS > deadline;
    const { message: assistant, finish_reason } = await callModel(
      messages,
      env,
      sessionId,
      lastRound,
    );

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (finish_reason === "content_filter") {
        return FILTERED_REPLY;
      }
      const reply =
        typeof assistant.content === "string" ? assistant.content.trim() : "";
      return reply || EMPTY_REPLY;
    }
    if (lastRound) {
      break;
    }

    // Each tool result must name the call it answers, so every call needs
    // an id before the assistant message goes back to the model.
    toolCalls.forEach((call, i) => {
      call.id ??= `call_${round}_${i}`;
    });
    messages.push(assistant);

    const results = await Promise.all(
      toolCalls.map((call, i) => runToolCall(call, i, env, toolResults)),
    );
    toolCalls.forEach((call, i) => {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: results[i],
      });
    });
  }

  return GIVE_UP_REPLY;
}

/**
 * Run one of the model's tool calls and return the result for the model.
 * Calls past the per-round cap, and calls without a name or with bad
 * arguments, get an error result instead, so the model can try again.
 */
async function runToolCall(call, index, env, toolResults) {
  if (index >= MAX_TOOL_CALLS_PER_ROUND) {
    return JSON.stringify({
      error: `Too many tool calls at once. Make at most ${MAX_TOOL_CALLS_PER_ROUND} per reply.`,
    });
  }

  const name = call.function?.name;
  const args = parseArgs(call.function?.arguments);
  if (typeof name !== "string" || args === null) {
    return JSON.stringify({
      error: "A tool call needs a name and a JSON object of arguments.",
    });
  }

  const key = `${name} ${JSON.stringify(args)}`;
  if (!toolResults.has(key)) {
    console.log(`tool ${name}`, args);
    toolResults.set(key, executeTool(name, args, env));
  }
  return toolResults.get(key);
}

async function callModel(messages, env, sessionId, lastRound) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      // The tools stay listed on the last round so earlier calls in the
      // transcript still make sense; tool_choice stops new ones.
      tools: toolDefinitions,
      ...(lastRound && { tool_choice: "none" }),
      max_tokens: MAX_REPLY_TOKENS,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`LLM returned ${res.status}: ${await res.text()}`);
  }

  // Some providers report errors, such as overload, in a 200 response.
  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice?.message) {
    const reply = JSON.stringify(data).slice(0, 500);
    throw new Error(`LLM returned no message: ${reply}`);
  }
  return choice;
}

/**
 * Read a tool call's arguments: a JSON object, sent as a string or, by some
 * providers, already parsed. Returns null for anything else.
 */
function parseArgs(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return {};
  }
  let args = raw;
  if (typeof raw === "string") {
    try {
      args = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const isObject =
    args !== null && typeof args === "object" && !Array.isArray(args);
  return isObject ? args : null;
}
