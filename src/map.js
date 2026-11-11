/**
 * Endpoints behind the page's map panel. /config tells the page how to draw
 * the Google map, and /places finds the closest places to eat, as cards with
 * reviews, photos and a Google Maps link (see cards.js).
 *
 * As with the tools, the handlers do the network calls and pure functions
 * shape the data. The pure functions are the ones covered by tests.
 */

import { CT_HUB_2 } from "./tools.js";
import { json, withinRateLimit } from "./http.js";
import { formatCard, resolveCardPhotos } from "./cards.js";

const NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
// Reviews put Nearby Search in its Enterprise + Atmosphere SKU, and every
// photo is a separate Place Photos request, so fetch only what cards show.
const NEARBY_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.currentOpeningHours",
  "places.googleMapsUri",
  "places.photos",
  "places.reviews",
].join(",");
const NEARBY_TYPES = ["restaurant", "food_court"];
const NEARBY_COUNT = 3;
const NEARBY_RADIUS_METRES = 1500;
const PLACES_TIMEOUT_MS = 5_000;

/**
 * GET /config: what the page needs to draw the interactive map. The browser
 * key is public by design, so it must not be the Places key: restrict it to
 * the Maps JavaScript API and to this site's address in Google Cloud.
 * Without one, the page shows Google's basic embedded map instead.
 */
export function handleConfig(env) {
  return json({
    mapsKey: env.GOOGLE_MAPS_BROWSER_KEY || null,
    // Advanced markers need a map ID; Google's DEMO_MAP_ID is for testing.
    mapId: env.GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
  });
}

/**
 * GET /places?lat=&lng=: the closest places to eat around that point, or
 * around CT Hub 2 without one, nearest first.
 */
export async function handlePlaces(request, env) {
  if (!(await withinRateLimit(request, env))) {
    return json({ error: "Uncle is busy. Wait a minute and try again." }, 429);
  }
  if (!env.GOOGLE_PLACES_API_KEY) {
    return json({ error: "The Places key is not set." }, 503);
  }

  const origin = parseOrigin(new URL(request.url).searchParams);
  try {
    const res = await fetch(NEARBY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": NEARBY_FIELDS,
      },
      body: JSON.stringify(buildNearbyRequest(origin)),
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Nearby Search returned ${res.status}: ${await res.text()}`);
      return json({ error: "Cannot find places right now." }, 502);
    }

    const data = await res.json();
    const places = formatNearbyPlaces(data.places ?? [], origin);
    return json({ origin, places: await resolveCardPhotos(places, env) });
  } catch (err) {
    console.error("places failed:", err);
    return json({ error: "Cannot find places right now." }, 502);
  }
}

/**
 * The point to search around: lat and lng from the page if they are real
 * coordinates, otherwise CT Hub 2. source says which one it is.
 */
export function parseOrigin(params) {
  const read = (key) => {
    const raw = params.get(key);
    return raw === null || raw.trim() === "" ? NaN : Number(raw);
  };
  const latitude = read("lat");
  const longitude = read("lng");
  if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    return { latitude, longitude, source: "you" };
  }
  return { ...CT_HUB_2, source: "ct_hub_2" };
}

/**
 * The Nearby Search body: the closest few places to eat around origin.
 */
export function buildNearbyRequest({ latitude, longitude }) {
  return {
    includedTypes: NEARBY_TYPES,
    maxResultCount: NEARBY_COUNT,
    rankPreference: "DISTANCE",
    locationRestriction: {
      circle: {
        center: { latitude, longitude },
        radius: NEARBY_RADIUS_METRES,
      },
    },
  };
}

/**
 * Shape Nearby Search results into cards, nearest first.
 */
export function formatNearbyPlaces(places, origin) {
  return places
    .filter(({ location }) => location)
    .map((place) => formatCard(place, origin))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, NEARBY_COUNT);
}
