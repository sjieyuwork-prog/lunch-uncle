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

/**
 * An assistant message that calls tools, one [name, args] pair per call.
 */
const callTools = (...calls) => ({
  role: "assistant",
  content: null,
  tool_calls: calls.map(([name, args], i) => ({
    id: `call_${i}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  })),
});

const rainCall = callTools(["get_rain_forecast", {}]);

/**
 * Stand in for the network. The model's nth reply is reply(n), and tool
 * APIs answer with tool(url, init), an empty payload by default. Returns
 * live call counts, the model request bodies and the tool request options.
 */
function stubFetch(t, reply, tool = () => Response.json({})) {
  const calls = { model: 0, tools: 0, bodies: [], toolInits: [] };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/chat/completions")) {
      calls.model += 1;
      calls.bodies.push(JSON.parse(init.body));
      return Response.json({ choices: [{ message: reply(calls.model) }] });
    }
    calls.tools += 1;
    calls.toolInits.push(init);
    return tool(url, init);
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

test("a tool that fails does not end the turn", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const busCall = callTools(["get_bus_arrivals", { stop_code: "07361" }]);
  const calls = stubFetch(
    t,
    (n) => [rainCall, busCall, say("Both sites down lah.")][n - 1],
    // The forecast times out, then the bus API sends an HTML error page.
    (url) => {
      if (String(url).includes("data.gov.sg")) {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      return new Response("<html>Bad gateway</html>");
    },
  );

  const reply = await runLoop([], "rain or bus?", KEYS);
  assert.equal(reply, "Both sites down lah.");
  for (const body of calls.bodies.slice(1)) {
    const result = body.messages.at(-1);
    assert.equal(result.role, "tool");
    assert.match(JSON.parse(result.content).error, /failed/);
  }
});

test("every tool request has a timeout", async (t) => {
  t.mock.method(console, "log", () => {});
  const allTools = callTools(
    ["find_lunch_places", { query: "chicken rice" }],
    ["get_rain_forecast", {}],
    ["get_bus_arrivals", { stop_code: "07361" }],
  );
  const calls = stubFetch(t, (n) => (n === 1 ? allTools : say("Ok lah.")));

  await runLoop([], "lunch, rain and bus?", KEYS);
  assert.equal(calls.toolInits.length, 3);
  for (const init of calls.toolInits) {
    assert.ok(init?.signal instanceof AbortSignal);
  }
});
