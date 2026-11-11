import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CT_HUB_2,
  buildPlacesRequest,
  searchRadius,
  formatPlaces,
  formatForecast,
  formatBusArrivals,
  haversineMetres,
} from "../src/tools.js";

test("formatForecast picks the requested area", () => {
  const payload = {
    data: {
      items: [
        {
          valid_period: { text: "12 pm to 2 pm" },
          forecasts: [
            { area: "Geylang", forecast: "Fair" },
            { area: "Kallang", forecast: "Light Rain" },
          ],
        },
      ],
    },
  };

  assert.deepEqual(formatForecast(payload, "Kallang"), {
    area: "Kallang",
    forecast: "Light Rain",
    valid_period: "12 pm to 2 pm",
  });
});

test("formatBusArrivals converts durations to whole minutes", () => {
  const payload = {
    services: [
      {
        no: "13",
        next: { duration_ms: 100_798 },
        subsequent: { duration_ms: 1_210_000 },
      },
      { no: "107M", next: { duration_ms: 30_000 }, subsequent: null },
    ],
  };

  assert.deepEqual(formatBusArrivals(payload, "07371"), {
    stop_code: "07371",
    services: [
      { service: "13", next_min: 2, subsequent_min: 20 },
      { service: "107M", next_min: 1, subsequent_min: null },
    ],
  });
});

test("haversineMetres measures CT Hub 2 to Lavender MRT at under 600 m", () => {
  const ctHub2 = { latitude: 1.3115, longitude: 103.8615 };
  const lavenderMrt = { latitude: 1.3073, longitude: 103.8631 };
  const distance = haversineMetres(ctHub2, lavenderMrt);
  assert.ok(distance > 400 && distance < 550, `got ${distance}`);
});

test("buildPlacesRequest keeps the search to 800 m around CT Hub 2", () => {
  const body = buildPlacesRequest({ query: "chicken rice" });
  const { low, high } = body.locationRestriction.rectangle;
  const centre = {
    latitude: (low.latitude + high.latitude) / 2,
    longitude: (low.longitude + high.longitude) / 2,
  };
  const ctHub2 = { latitude: 1.3115, longitude: 103.8615 };
  assert.ok(haversineMetres(centre, ctHub2) < 1, "box is centred on CT Hub 2");

  const north = { latitude: high.latitude, longitude: centre.longitude };
  const east = { latitude: centre.latitude, longitude: high.longitude };
  assert.equal(Math.round(haversineMetres(centre, north)), 800);
  assert.equal(Math.round(haversineMetres(centre, east)), 800);
});

test("searchRadius defaults to a walk and stays between 100 m and 5 km", () => {
  assert.equal(searchRadius(undefined), 800);
  assert.equal(searchRadius("far"), 800);
  assert.equal(searchRadius(3000), 3000);
  assert.equal(searchRadius("1500"), 1500);
  assert.equal(searchRadius(20), 100);
  assert.equal(searchRadius(99999), 5000);
});

test("formatPlaces gives open status, nearest first, within the radius", () => {
  const places = [
    {
      displayName: { text: "By the MRT" },
      rating: 4.1,
      location: { latitude: 1.3073, longitude: 103.8631 },
      currentOpeningHours: { openNow: false },
    },
    {
      displayName: { text: "In Bedok" },
      rating: 4.3,
      location: { latitude: 1.3236, longitude: 103.9273 },
      currentOpeningHours: { openNow: true },
    },
    {
      displayName: { text: "Next door" },
      location: { latitude: 1.3116, longitude: 103.8615 },
    },
  ];

  assert.deepEqual(formatPlaces(places, CT_HUB_2, 800), [
    { name: "Next door", rating: null, distance_m: 11, open_now: null },
    { name: "By the MRT", rating: 4.1, distance_m: 500, open_now: false },
  ]);
});
