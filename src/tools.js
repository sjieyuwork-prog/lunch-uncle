/**
 * Tool definitions and implementations for Lunch Uncle.
 *
 * Each tool is split in two: a fetch function that talks to the network,
 * and a pure format function that shapes the response for the model.
 * The format functions are the ones covered by tests.
 */

// CT Hub 2, 114 Lavender Street.
export const CT_HUB_2 = { latitude: 1.3115, longitude: 103.8615 };

const EARTH_RADIUS_METRES = 6371000;
const METRES_PER_DEGREE = (EARTH_RADIUS_METRES * Math.PI) / 180;

const SEARCH_RADIUS_METRES = 800;
const MIN_SEARCH_RADIUS_METRES = 100;
const MAX_SEARCH_RADIUS_METRES = 5000;
const MAX_PLACES = 10;
const FORECAST_AREA = "Kallang";

const TOOL_TIMEOUT_MS = 5_000;
// Cloudflare keeps these GET responses at the edge for this many seconds.
// The forecast changes about every half hour; arrivelah allows 15 s.
const FORECAST_CACHE_SECONDS = 300;
const BUS_CACHE_SECONDS = 15;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/";

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_lunch_places",
      description:
        "Search for places to eat near CT Hub 2. Returns name, rating, straight-line distance in metres and open_now (true, false, or null if unknown), nearest first.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to search for, e.g. "chicken rice", "japanese", "cheap lunch".',
          },
          open_now: {
            type: "boolean",
            description: "Only return places that are open right now.",
          },
          max_distance_m: {
            type: "integer",
            description:
              "How far from CT Hub 2 to search, in metres. Defaults to 800, a short walk. Up to 5000 if the user will take a bus or cab.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rain_forecast",
      description:
        "Get the two-hour weather forecast for the Kallang area, which covers CT Hub 2. stale is true if the forecast period has already ended, so it may be out of date.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bus_arrivals",
      description:
        "Get the next bus arrivals at a Singapore bus stop, by five-digit stop code.",
      parameters: {
        type: "object",
        properties: {
          stop_code: {
            type: "string",
            description: 'Five-digit bus stop code, e.g. "07361".',
          },
        },
        required: ["stop_code"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one tool call requested by the model and return the result as a string.
 * Never throws: a failure becomes an error result the model can work with.
 * found, if given, collects the full Places results the model was shown,
 * by place id, so the page can show cards for the ones Uncle recommends.
 */
export async function executeTool(name, args, env, found) {
  try {
    switch (name) {
      case "find_lunch_places":
        return JSON.stringify(await findLunchPlaces(args, env, found));
      case "get_rain_forecast":
        return JSON.stringify(await getRainForecast());
      case "get_bus_arrivals":
        return JSON.stringify(await getBusArrivals(args));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    // A network error, timeout or non-JSON reply from one API should not
    // end the whole turn, or stop the other tools in the same round.
    console.error(`${name} failed:`, err);
    return JSON.stringify({ error: `${name} failed: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// find_lunch_places
// ---------------------------------------------------------------------------

// Besides what the model reads, ask for what the page's place cards show
// (address, review count, Maps link, photos and reviews), so a place Uncle
// recommends becomes a card without another request. Reviews make each
// search an Enterprise + Atmosphere request.
const PLACES_FIELD_MASK = [
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

async function findLunchPlaces(args, env, found) {
  if (typeof args.query !== "string" || args.query.trim() === "") {
    return { error: "query is required" };
  }

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": PLACES_FIELD_MASK,
    },
    body: JSON.stringify(buildPlacesRequest(args)),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { error: `Places API returned ${res.status}` };
  }

  const data = await res.json();
  const places = data.places ?? [];
  const radius = searchRadius(args.max_distance_m);
  // Keep the full results the model is shown, for the page's cards.
  for (const place of places) {
    const shown =
      place.location &&
      Math.round(haversineMetres(CT_HUB_2, place.location)) <= radius;
    if (place.id && shown) {
      found?.set(place.id, place);
    }
  }
  return { places: formatPlaces(places, CT_HUB_2, radius) };
}

/**
 * Build the Text Search request body for a lunch query near CT Hub 2.
 * Results are restricted to a box around CT Hub 2 that fits the search
 * radius, so far-away famous places cannot crowd out nearby ones.
 */
export function buildPlacesRequest({ query, open_now = false, max_distance_m }) {
  return {
    textQuery: query,
    includedType: "restaurant",
    openNow: open_now,
    pageSize: MAX_PLACES,
    locationRestriction: {
      rectangle: boxAround(CT_HUB_2, searchRadius(max_distance_m)),
    },
  };
}

/**
 * The search radius in metres: what the model asked for, kept between
 * 100 m and 5 km, or the walking-distance default if it did not ask.
 */
export function searchRadius(requested) {
  const metres = Number(requested);
  if (!(metres > 0)) {
    return SEARCH_RADIUS_METRES;
  }
  return Math.min(
    Math.max(Math.round(metres), MIN_SEARCH_RADIUS_METRES),
    MAX_SEARCH_RADIUS_METRES,
  );
}

// The smallest latitude/longitude box that holds a circle of this radius.
function boxAround({ latitude, longitude }, metres) {
  const dLat = metres / METRES_PER_DEGREE;
  const dLon = dLat / Math.cos((latitude * Math.PI) / 180);
  return {
    low: { latitude: latitude - dLat, longitude: longitude - dLon },
    high: { latitude: latitude + dLat, longitude: longitude + dLon },
  };
}

/**
 * Shape Places API results into the fields Uncle needs, nearest first.
 * The search box's corners reach past the radius, so drop places beyond it.
 */
export function formatPlaces(places, origin, maxDistance = Infinity) {
  return places
    .filter(({ location }) => location)
    .map(({ displayName, rating, location, currentOpeningHours }) => ({
      name: displayName?.text ?? "Unnamed",
      rating: rating ?? null,
      distance_m: Math.round(haversineMetres(origin, location)),
      open_now: currentOpeningHours?.openNow ?? null,
    }))
    .filter((place) => place.distance_m <= maxDistance)
    .sort((a, b) => a.distance_m - b.distance_m);
}

/**
 * Great-circle distance between two {latitude, longitude} points, in metres.
 */
export function haversineMetres(a, b) {
  const R = EARTH_RADIUS_METRES;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// get_rain_forecast
// ---------------------------------------------------------------------------

async function getRainForecast() {
  const res = await fetch(FORECAST_URL, {
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    cf: { cacheTtl: FORECAST_CACHE_SECONDS },
  });
  if (!res.ok) {
    return { error: `Forecast API returned ${res.status}` };
  }
  return formatForecast(await res.json(), FORECAST_AREA, Date.now());
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload.
 * stale is true if the forecast period ended before now (in milliseconds).
 */
export function formatForecast(payload, area, now) {
  const item = payload?.data?.items?.[0];
  if (!item) {
    return { error: "No forecast available" };
  }
  const entry = item.forecasts?.find((f) => f.area === area);
  return {
    area,
    forecast: entry?.forecast ?? "Unknown",
    valid_period: item.valid_period?.text ?? null,
    stale: Date.parse(item.valid_period?.end) < now,
  };
}

// ---------------------------------------------------------------------------
// get_bus_arrivals
// ---------------------------------------------------------------------------

async function getBusArrivals(args) {
  const stopCode = normaliseStopCode(args.stop_code);
  if (!stopCode) {
    return { error: "stop_code must be a five-digit bus stop code" };
  }
  const res = await fetch(`${BUS_URL}?id=${stopCode}`, {
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    cf: { cacheTtl: BUS_CACHE_SECONDS },
  });
  if (!res.ok) {
    return { error: `Bus API returned ${res.status}` };
  }
  return formatBusArrivals(await res.json(), stopCode, Date.now());
}

/**
 * Turn the model's stop code into five digits, putting back a dropped
 * leading zero (7361 becomes "07361"). Returns null if it is not digits.
 */
export function normaliseStopCode(code) {
  const digits = String(code ?? "").trim();
  return /^\d{1,5}$/.test(digits) ? digits.padStart(5, "0") : null;
}

/**
 * Reduce an arrivelah response to service numbers and whole minutes until
 * each bus arrives, counted from now (a timestamp in milliseconds).
 */
export function formatBusArrivals(payload, stopCode, now) {
  // arrivelah answers a bad stop code with HTTP 200 and an error field.
  if (payload?.error) {
    return { stop_code: stopCode, error: payload.error };
  }
  const services = payload?.services ?? [];
  return {
    stop_code: stopCode,
    services: services.map((s) => ({
      service: s.no,
      next_min: minutesUntil(s.next, now),
      subsequent_min: minutesUntil(s.subsequent, now),
    })),
  };
}

// Prefer the arrival time: duration_ms is fixed when arrivelah builds the
// response, so it goes stale while the response sits in a cache. Round
// down, so a bus 90 seconds away shows as 1 minute, not 2.
function minutesUntil(arrival, now) {
  if (!arrival) {
    return null;
  }
  const ms =
    typeof arrival.time === "string"
      ? Date.parse(arrival.time) - now
      : arrival.duration_ms;
  if (typeof ms !== "number" || Number.isNaN(ms)) {
    return null;
  }
  return Math.max(0, Math.floor(ms / 60000));
}
