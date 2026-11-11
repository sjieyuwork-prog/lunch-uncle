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
        "Get the two-hour weather forecast for the Kallang area, which covers CT Hub 2.",
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
            description: 'Five-digit bus stop code, e.g. "07371".',
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
 */
export async function executeTool(name, args, env) {
  switch (name) {
    case "find_lunch_places":
      return JSON.stringify(await findLunchPlaces(args, env));
    case "get_rain_forecast":
      return JSON.stringify(await getRainForecast());
    case "get_bus_arrivals":
      return JSON.stringify(await getBusArrivals(args));
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ---------------------------------------------------------------------------
// find_lunch_places
// ---------------------------------------------------------------------------

async function findLunchPlaces(args, env) {
  if (typeof args.query !== "string" || args.query.trim() === "") {
    return { error: "query is required" };
  }

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.location,places.rating,places.currentOpeningHours",
    },
    body: JSON.stringify(buildPlacesRequest(args)),
  });

  if (!res.ok) {
    return { error: `Places API returned ${res.status}` };
  }

  const data = await res.json();
  const radius = searchRadius(args.max_distance_m);
  return { places: formatPlaces(data.places ?? [], CT_HUB_2, radius) };
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
  const res = await fetch(FORECAST_URL);
  if (!res.ok) {
    return { error: `Forecast API returned ${res.status}` };
  }
  return formatForecast(await res.json(), FORECAST_AREA);
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload.
 */
export function formatForecast(payload, area) {
  const item = payload?.data?.items?.[0];
  if (!item) {
    return { error: "No forecast available" };
  }
  const entry = item.forecasts.find((f) => f.area === area);
  return {
    area,
    forecast: entry?.forecast ?? "Unknown",
    valid_period: item.valid_period?.text ?? null,
  };
}

// ---------------------------------------------------------------------------
// get_bus_arrivals
// ---------------------------------------------------------------------------

async function getBusArrivals({ stop_code }) {
  const url = `${BUS_URL}?id=${encodeURIComponent(stop_code)}`;
  const res = await fetch(url);
  if (!res.ok) {
    return { error: `Bus API returned ${res.status}` };
  }
  return formatBusArrivals(await res.json(), stop_code);
}

/**
 * Reduce an arrivelah response to service numbers and minutes to arrival.
 */
export function formatBusArrivals(payload, stopCode) {
  const services = payload?.services ?? [];
  return {
    stop_code: stopCode,
    services: services.map((s) => ({
      service: s.no,
      next_min: minutesFromNow(s.next),
      subsequent_min: minutesFromNow(s.subsequent),
    })),
  };
}

function minutesFromNow(arrival) {
  if (!arrival || typeof arrival.duration_ms !== "number") {
    return null;
  }
  return Math.max(0, Math.round(arrival.duration_ms / 60000));
}
