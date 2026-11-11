import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoop, MAX_ROUNDS, MAX_TOOL_CALLS_PER_ROUND } from "../src/loop.js";

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
 * Stand in for the network, and keep the loop's logging quiet.
 *
 * The model's nth reply is reply(n, body), where body is the request it
 * was sent. reply returns an assistant message, a whole choice (with
 * finish_reason), or a raw Response. Tool APIs answer with tool(url, init),
 * an empty payload by default. Returns live call counts, the model request
 * bodies and the tool request options.
 */
function stubFetch(t, reply, tool = () => Response.json({})) {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const calls = { model: 0, tools: 0, bodies: [], toolInits: [] };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/chat/completions")) {
      calls.model += 1;
      const body = JSON.parse(init.body);
      calls.bodies.push(body);
      const out = reply(calls.model, body);
      if (out instanceof Response) {
        return out;
      }
      const choice = "message" in out ? out : { message: out };
      return Response.json({ choices: [choice] });
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

test("on the last round, the model must answer without tools", async (t) => {
  const calls = stubFetch(t, (n, body) =>
    body.tool_choice === "none" ? say("Umbrella lah.") : rainCall,
  );
  const reply = await runLoop([], "will it rain later?", KEYS);
  assert.equal(reply, "Umbrella lah.");
  assert.deepEqual(
    calls.bodies.map((body) => body.tool_choice ?? "auto"),
    [...Array(MAX_ROUNDS - 1).fill("auto"), "none"],
  );
});

test("when time runs short, the model must answer now", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  // Each model call takes 30 s, so the second is the last that fits.
  const calls = stubFetch(t, (n, body) => {
    t.mock.timers.tick(30_000);
    return body.tool_choice === "none"
      ? say("No time, umbrella lah.")
      : rainCall;
  });
  const reply = await runLoop([], "will it rain later?", KEYS);
  assert.equal(reply, "No time, umbrella lah.");
  assert.equal(calls.model, 2);
});

test("every model request caps the reply length", async (t) => {
  const calls = stubFetch(t, () => say("Ok lah."));
  await runLoop([], "hello?", KEYS);
  assert.ok(calls.bodies[0].max_tokens > 0);
});

test("a tool that fails does not end the turn", async (t) => {
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

test("bad tool calls get an error result instead of a crash", async (t) => {
  const bad = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "a",
        type: "function",
        function: {
          name: "get_bus_arrivals",
          // Not JSON: a number cannot have a leading zero.
          arguments: '{"stop_code": 07361}',
        },
      },
      {
        id: "b",
        type: "function",
        function: { name: "find_lunch_places", arguments: "null" },
      },
      { id: "c", type: "function" },
    ],
  };
  const calls = stubFetch(t, (n) => (n === 1 ? bad : say("Say again?")));

  const reply = await runLoop([], "bus?", KEYS);
  assert.equal(reply, "Say again?");
  assert.equal(calls.tools, 0);
  const results = calls.bodies[1].messages.filter((m) => m.role === "tool");
  assert.deepEqual(results.map((m) => m.tool_call_id), ["a", "b", "c"]);
  for (const result of results) {
    assert.ok(JSON.parse(result.content).error);
  }
});

test("a tool call without an id is given one", async (t) => {
  const noId = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        type: "function",
        function: { name: "get_rain_forecast", arguments: "{}" },
      },
    ],
  };
  const calls = stubFetch(t, (n) => (n === 1 ? noId : say("Fair lah.")));

  await runLoop([], "rain?", KEYS);
  const [assistant, result] = calls.bodies[1].messages.slice(-2);
  assert.ok(assistant.tool_calls[0].id);
  assert.equal(result.tool_call_id, assistant.tool_calls[0].id);
});

test("only MAX_TOOL_CALLS_PER_ROUND tool calls run per reply", async (t) => {
  const queries = ["a", "b", "c", "d", "e", "f"];
  const six = callTools(
    ...queries.map((query) => ["find_lunch_places", { query }]),
  );
  const calls = stubFetch(t, (n) => (n === 1 ? six : say("Ok lah.")));

  await runLoop([], "lunch?", KEYS);
  assert.equal(calls.tools, MAX_TOOL_CALLS_PER_ROUND);
  const results = calls.bodies[1].messages.filter((m) => m.role === "tool");
  assert.equal(results.length, queries.length);
  assert.match(results.at(-1).content, /Too many tool calls/);
});

test("identical tool calls in one turn run once", async (t) => {
  const twice = callTools(["get_rain_forecast", {}], ["get_rain_forecast", {}]);
  const calls = stubFetch(t, (n) => [twice, rainCall, say("Fair lah.")][n - 1]);

  await runLoop([], "rain?", KEYS);
  assert.equal(calls.tools, 1);
});

test("an empty or filtered reply still gets a line from Uncle", async (t) => {
  stubFetch(t, (n) => ({
    message: say(null),
    finish_reason: n === 1 ? "stop" : "content_filter",
  }));
  assert.equal(
    await runLoop([], "hello?", KEYS),
    "Uncle got nothing to say. Ask again lah.",
  );
  assert.equal(
    await runLoop([], "hello?", KEYS),
    "Uncle won't answer that one. Ask about lunch lah.",
  );
});

test("a 200 with no message fails with the provider's reason", async (t) => {
  stubFetch(t, () => Response.json({ error: { message: "model overloaded" } }));
  await assert.rejects(runLoop([], "hello?", KEYS), /model overloaded/);
});
