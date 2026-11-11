import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PICKS, placesMentioned } from "../src/cards.js";

/**
 * A Places result with just what placesMentioned reads. By default it is
 * next door to CT Hub 2 and its id is its name.
 */
function place(name, { id = name, latitude = 1.3116, longitude = 103.8615 } = {}) {
  return { id, displayName: { text: name }, location: { latitude, longitude } };
}

const ids = (places) => places.map(({ id }) => id);

test("placesMentioned finds the places Uncle names, in his order", () => {
  const places = [
    place("Makuake"),
    place("MR K PRATA"),
    place("Habibi-san"),
    place("Café Kopi"),
  ];
  const reply = "Mr K Prata if you rushing. Got time? Habibi-san. Cafe Kopi also can.";
  assert.deepEqual(ids(placesMentioned(reply, places)), [
    "MR K PRATA",
    "Habibi-san",
    "Café Kopi",
  ]);
});

test("placesMentioned matches a branch by the name before its suffix", () => {
  const places = [
    place("Ya Kun Kaya Toast @ Lavender"),
    place("Tian Tian Chicken Rice (Lavender)"),
    place("Swee Choon - Jalan Besar"),
  ];
  const reply =
    "Tian Tian Chicken Rice is the one. Ya Kun Kaya Toast if you want kopi.";
  assert.deepEqual(ids(placesMentioned(reply, places)), [
    "Tian Tian Chicken Rice (Lavender)",
    "Ya Kun Kaya Toast @ Lavender",
  ]);
});

test("placesMentioned only matches whole words and skips short names", () => {
  const places = [place("Pho"), place("Kopi Tiam"), place("Thai Express")];
  const reply = "Pho also can, or any kopitiam, but Thai Express best lah.";
  assert.deepEqual(ids(placesMentioned(reply, places)), ["Thai Express"]);
});

test("placesMentioned counts a shared name once, nearest first", () => {
  const places = [
    place("Ya Kun Kaya Toast", { id: "far branch", latitude: 1.3073 }),
    place("Ya Kun Kaya Toast", { id: "near branch" }),
    place("Makuake"),
    place("Tipo Osteria"),
    place("Mr K Prata"),
  ];
  const reply = "Ya Kun Kaya Toast, Makuake, Tipo Osteria or Mr K Prata lah.";
  assert.equal(MAX_PICKS, 3);
  assert.deepEqual(ids(placesMentioned(reply, places)), [
    "near branch",
    "Makuake",
    "Tipo Osteria",
  ]);
});

test("placesMentioned matches the shortened names Uncle uses", () => {
  const places = [
    place("Lai Soon Chicken Rice"),
    place("YiPing Hainanese Chicken Rice"),
    place("Chicken Rice Bowl"),
  ];
  // "Yi Ping" is spaced differently, and "Lai Soon" drops the dish.
  const reply = "Lai Soon is near but skip. Want 5-star? Yi Ping, 670 m.";
  assert.deepEqual(ids(placesMentioned(reply, places)), [
    "Lai Soon Chicken Rice",
    "YiPing Hainanese Chicken Rice",
  ]);
  // Plain dish words never pick out a place on their own.
  assert.deepEqual(
    placesMentioned("Chicken rice for lunch lah.", places),
    [],
  );
});

test("placesMentioned returns nothing when no place is named", () => {
  const reply = "Rain later, bring umbrella.";
  assert.deepEqual(placesMentioned(reply, [place("Makuake")]), []);
  assert.deepEqual(placesMentioned(reply, []), []);
});
