import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  formatSingaporeTime,
  userMessage,
} from "../src/prompt.js";

test("buildSystemPrompt is the same for every request", () => {
  // Anything that changes per request at the start of the prompt stops a
  // provider caching the prompt and the conversation after it.
  assert.equal(buildSystemPrompt(), buildSystemPrompt());
  assert.ok(buildSystemPrompt().startsWith("You are Lunch Uncle"));
});

test("formatSingaporeTime gives the Singapore weekday, date and time", () => {
  // 23:45 UTC on Sunday is already 07:45 on Monday in Singapore.
  const earlyMonday = new Date("2026-11-15T23:45:00Z");
  assert.equal(
    formatSingaporeTime(earlyMonday),
    "Monday 16 November 2026, 07:45 SGT",
  );
  const lunchtime = new Date("2026-11-11T04:30:00Z");
  assert.equal(
    formatSingaporeTime(lunchtime),
    "Wednesday 11 November 2026, 12:30 SGT",
  );
});

test("userMessage stamps the user's text with the Singapore time", () => {
  const lunchtime = new Date("2026-11-11T04:30:00Z");
  assert.deepEqual(userMessage("where to eat?", lunchtime), {
    role: "user",
    content: "[Wednesday 11 November 2026, 12:30 SGT] where to eat?",
  });
});
