import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoop, MAX_ROUNDS } from "../src/loop.js";

const KEYS = {
  OPENCODE_API_KEY: "test-key",
  GOOGLE_PLACES_API_KEY: "test-key",
};
const NO_PLACES_KEY = { OPENCODE_API_KEY: "test-key" };
const FALLBACK_REPLY = "Just go Berseh Food Centre lah.";

const say = (content) => ({ role: "assistant", content });

const rainCall = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "get_rain_forecast", arguments: "{}" },
    },
  ],
};

/**
 * Stand in for the network. The model's nth reply is reply(n), and every
 * tool API answers with an empty payload. Returns live call counts.
 */
function stubFetch(t, reply) {
  const calls = { model: 0, tools: 0 };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/chat/completions")) {
      calls.model += 1;
      return Response.json({ choices: [{ message: reply(calls.model) }] });
    }
    calls.tools += 1;
    return Response.json({});
  });
  return calls;
}

test("with the Places key, food questions reach the model", async (t) => {
  const calls = stubFetch(t, () => say("Try the ramen place lah."));
  const reply = await runLoop([], "any good japanese food nearby?", KEYS);
  assert.equal(reply, "Try the ramen place lah.");
  assert.equal(calls.model, 1);
});

test("without the Places key, food questions get the fallback", async (t) => {
  const calls = stubFetch(t, () => say("Try the ramen place lah."));
  const reply = await runLoop([], "where to eat?", NO_PLACES_KEY);
  assert.equal(reply, FALLBACK_REPLY);
  assert.equal(calls.model, 0);
});

test("without the Places key, other questions reach the model", async (t) => {
  const calls = stubFetch(t, () => say("Bring umbrella lah."));
  const reply = await runLoop([], "will it rain later?", NO_PLACES_KEY);
  assert.equal(reply, "Bring umbrella lah.");
  assert.equal(calls.model, 1);
});

test("the loop gives up after MAX_ROUNDS rounds of tool calls", async (t) => {
  t.mock.method(console, "log", () => {});
  // The model never stops asking for tools. It answers at call 50 so a
  // broken round counter fails this test instead of hanging it.
  const calls = stubFetch(t, (n) => (n < 50 ? rainCall : say("runaway")));
  const reply = await runLoop([], "will it rain later?", KEYS);
  assert.equal(calls.model, MAX_ROUNDS);
  assert.equal(
    reply,
    "Uncle tried too many times already. Ask something simpler.",
  );
});
