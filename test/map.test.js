import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNearbyRequest,
  formatNearbyPlaces,
  handleConfig,
  handlePlaces,
  parseOrigin,
} from "../src/map.js";

const ENV = { GOOGLE_PLACES_API_KEY: "test-key" };
const CT_HUB_2 = { latitude: 1.3115, longitude: 103.8615 };

const params = (query) => new URLSearchParams(query);

test("parseOrigin uses the page's location only if it is real", () => {
  assert.deepEqual(parseOrigin(params("lat=1.3&lng=103.86")), {
    latitude: 1.3,
    longitude: 103.86,
    source: "you",
  });
  for (const query of ["", "lat=&lng=", "lat=95&lng=103.86", "lat=a&lng=b"]) {
    assert.deepEqual(
      parseOrigin(params(query)),
      { ...CT_HUB_2, source: "ct_hub_2" },
      query,
    );
  }
});

test("buildNearbyRequest asks for the three closest places to eat", () => {
  assert.deepEqual(buildNearbyRequest({ ...CT_HUB_2, source: "ct_hub_2" }), {
    includedTypes: ["restaurant", "food_court"],
    maxResultCount: 3,
    rankPreference: "DISTANCE",
    locationRestriction: { circle: { center: CT_HUB_2, radius: 1500 } },
  });
});

test("formatNearbyPlaces shapes cards with credited photos and reviews", () => {
  const places = [
    {
      id: "far",
      displayName: { text: "Far" },
      location: { latitude: 1.3073, longitude: 103.8631 },
      rating: 4.1,
      userRatingCount: 50,
    },
    {
      id: "near",
      displayName: { text: "Near" },
      formattedAddress: "114 Lavender St",
      location: { latitude: 1.3116, longitude: 103.8615 },
      rating: 4.6,
      userRatingCount: 1234,
      currentOpeningHours: { openNow: true },
      googleMapsUri: "https://maps.google.com/?cid=1",
      photos: [
        {
          name: "places/near/photos/a",
          authorAttributions: [
            {
              displayName: "Ann",
              uri: "//maps.google.com/maps/contrib/1",
              photoUri: "//lh3.googleusercontent.com/a",
            },
          ],
        },
        { name: "places/near/photos/b" },
        { name: "places/near/photos/c" },
      ],
      reviews: [
        {
          rating: 5,
          relativePublishTimeDescription: "a week ago",
          text: { text: "Shiok!", languageCode: "en" },
          originalText: { text: "Shiok!", languageCode: "en" },
          authorAttribution: {
            displayName: "Bob",
            uri: "https://www.google.com/maps/contrib/2",
            photoUri: "https://lh3.googleusercontent.com/b",
          },
        },
        {
          rating: 4,
          text: { text: "Good value", languageCode: "en" },
          originalText: { text: "物美价廉", languageCode: "zh" },
        },
        { rating: 1, text: { text: "Not shown: only two reviews fit" } },
      ],
    },
    { id: "no-location", displayName: { text: "Nowhere" } },
    {
      id: "mid",
      displayName: { text: "Mid" },
      location: { latitude: 1.3125, longitude: 103.8615 },
      googleMapsUri: "javascript:alert(1)",
    },
    {
      id: "bedok",
      displayName: { text: "Too far" },
      location: { latitude: 1.3236, longitude: 103.9273 },
    },
  ];

  const cards = formatNearbyPlaces(places, CT_HUB_2);
  assert.deepEqual(
    cards.map(({ id, distance_m }) => [id, distance_m]),
    [
      ["near", 11],
      ["mid", 111],
      ["far", 500],
    ],
  );
  assert.deepEqual(cards[0], {
    id: "near",
    name: "Near",
    address: "114 Lavender St",
    location: { latitude: 1.3116, longitude: 103.8615 },
    distance_m: 11,
    rating: 4.6,
    rating_count: 1234,
    open_now: true,
    maps_url: "https://maps.google.com/?cid=1",
    photos: [
      {
        ref: "places/near/photos/a",
        author: "Ann",
        author_url: "https://maps.google.com/maps/contrib/1",
        author_photo: "https://lh3.googleusercontent.com/a",
      },
      {
        ref: "places/near/photos/b",
        author: "A Google user",
        author_url: null,
        author_photo: null,
      },
    ],
    reviews: [
      {
        author: "Bob",
        author_url: "https://www.google.com/maps/contrib/2",
        author_photo: "https://lh3.googleusercontent.com/b",
        rating: 5,
        when: "a week ago",
        text: "Shiok!",
        translated: false,
      },
      {
        author: "A Google user",
        author_url: null,
        author_photo: null,
        rating: 4,
        when: null,
        text: "Good value",
        translated: true,
      },
    ],
  });
  // A link that is not https is dropped, not passed to the page.
  assert.equal(cards[1].maps_url, null);
  assert.equal(cards[1].open_now, null);
});

test("handlePlaces swaps photo names for image URLs", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith(":searchNearby")) {
      return Response.json({
        places: [
          {
            id: "p1",
            displayName: { text: "Near" },
            location: { latitude: 1.3116, longitude: 103.8615 },
            photos: [
              { name: "places/p1/photos/ok" },
              { name: "places/p1/photos/gone" },
            ],
          },
        ],
      });
    }
    if (String(url).includes("/photos/ok/media")) {
      return Response.json({ photoUri: "https://lh3.googleusercontent.com/ok" });
    }
    return new Response("Not found", { status: 404 });
  });

  const res = await handlePlaces(
    new Request("http://localhost/places?lat=1.3115&lng=103.8615"),
    ENV,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.origin.source, "you");
  // The photo that failed is left out; the card still comes back.
  assert.deepEqual(body.places[0].photos, [
    {
      url: "https://lh3.googleusercontent.com/ok",
      author: "A Google user",
      author_url: null,
      author_photo: null,
    },
  ]);

  const [search] = requests;
  assert.deepEqual(
    JSON.parse(search.init.body).locationRestriction.circle.center,
    CT_HUB_2,
  );
  // The key travels in a header, never in a URL the page could see.
  assert.equal(search.init.headers["X-Goog-Api-Key"], "test-key");
  assert.ok(requests.every(({ url }) => !url.includes("test-key")));
});

test("handlePlaces turns failures into JSON errors", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () =>
    new Response("PERMISSION_DENIED", { status: 403 }),
  );
  const request = () => new Request("http://localhost/places");

  assert.equal((await handlePlaces(request(), {})).status, 503);
  assert.equal((await handlePlaces(request(), ENV)).status, 502);

  const limited = {
    ...ENV,
    CHAT_LIMITER: { limit: async () => ({ success: false }) },
  };
  assert.equal((await handlePlaces(request(), limited)).status, 429);
});

test("handleConfig gives the page the browser key and a map ID", async () => {
  assert.deepEqual(await handleConfig({}).json(), {
    mapsKey: null,
    mapId: "DEMO_MAP_ID",
  });
  const env = { GOOGLE_MAPS_BROWSER_KEY: "browser-key", GOOGLE_MAPS_MAP_ID: "m1" };
  assert.deepEqual(await handleConfig(env).json(), {
    mapsKey: "browser-key",
    mapId: "m1",
  });
});
