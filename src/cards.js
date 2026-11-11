/**
 * Place cards for the page's map panel: the places closest to you (from
 * /places) and the places Uncle recommends in the chat (from /chat). Both
 * start as Google Places results.
 *
 * The pure functions shape and choose the cards, and are covered by tests.
 * resolveCardPhotos does the network calls.
 */

import { CT_HUB_2, haversineMetres } from "./tools.js";

const PLACES_API = "https://places.googleapis.com/v1";
const PHOTOS_PER_PLACE = 2;
const REVIEWS_PER_PLACE = 2;
const PHOTO_WIDTH_PX = 480;
const PHOTO_TIMEOUT_MS = 5_000;
const PHOTO_NAME = /^places\/[\w-]+\/photos\/[\w-]+$/;
export const MAX_PICKS = 3;

// Shorter names than these are too likely to be ordinary words in a reply:
// a whole name, and a shortened one written without spaces.
const MIN_NAME_CHARS = 4;
const MIN_SHORT_NAME_CHARS = 5;
// Names are matched against runs of up to this many words in the reply.
const MAX_NAME_WORDS = 10;
// Where a branch suffix starts: " @ Lavender", " - Jalan Besar", " (Lavender)".
const BRANCH_SUFFIX = /\s+[@|–—-]\s*|\s*[(:]/;
// Words too common in place names to pick one out. A shortened name ("Lai
// Soon" for "Lai Soon Chicken Rice") counts only if it keeps another word.
const GENERIC_WORDS = new Set([
  "a", "and", "at", "by", "de", "di", "la", "le", "of", "on", "the",
  "bakery", "bar", "bistro", "cafe", "canteen", "center", "centre", "coffee",
  "corner", "court", "diner", "eatery", "express", "food", "grill", "hawker",
  "house", "kitchen", "kopi", "kopitiam", "restaurant", "shop", "stall",
  "tea", "tiam", "bak", "beef", "biryani", "bread", "burger", "chicken",
  "chinese", "curry", "dim", "duck", "dumpling", "fish", "hainanese",
  "indian", "italian", "japanese", "kaya", "korean", "laksa", "mala", "mee",
  "nasi", "noodle", "noodles", "pork", "prata", "ramen", "rice", "roast",
  "satay", "seafood", "soup", "steak", "sum", "sushi", "thai", "toast",
  "western",
]);

/**
 * Shape one Places result into a card, with its distance from origin.
 * Photos keep their name (ref) until resolveCardPhotos swaps it for a URL.
 * Every photo and review keeps its author, which Google requires us to show.
 */
export function formatCard(place, origin) {
  return {
    id: place.id,
    name: place.displayName?.text ?? "Unnamed",
    address: place.formattedAddress ?? null,
    location: {
      latitude: place.location.latitude,
      longitude: place.location.longitude,
    },
    distance_m: Math.round(haversineMetres(origin, place.location)),
    rating: place.rating ?? null,
    rating_count: place.userRatingCount ?? 0,
    open_now: place.currentOpeningHours?.openNow ?? null,
    maps_url: safeUrl(place.googleMapsUri),
    photos: (place.photos ?? []).slice(0, PHOTOS_PER_PLACE).map((photo) => ({
      ref: photo.name,
      ...author(photo.authorAttributions?.[0]),
    })),
    reviews: (place.reviews ?? []).slice(0, REVIEWS_PER_PLACE).map(review),
  };
}

function review(r) {
  const text = r.text ?? r.originalText;
  return {
    ...author(r.authorAttribution),
    rating: r.rating ?? null,
    when: r.relativePublishTimeDescription ?? null,
    text: text?.text ?? "",
    // Google asks apps to say when a review has been translated.
    translated: Boolean(
      r.text &&
        r.originalText &&
        r.text.languageCode !== r.originalText.languageCode,
    ),
  };
}

function author(attribution) {
  return {
    author: attribution?.displayName ?? "A Google user",
    author_url: safeUrl(attribution?.uri),
    author_photo: safeUrl(attribution?.photoUri),
  };
}

// Keep links and images from the API only if they are https (making
// protocol-relative ones https), so the page never gets another scheme.
function safeUrl(url) {
  if (typeof url !== "string") {
    return null;
  }
  if (url.startsWith("//")) {
    return `https:${url}`;
  }
  return url.startsWith("https://") ? url : null;
}

/**
 * The places Uncle names in his reply, in the order he names them, at most
 * MAX_PICKS. Each place is {displayName: {text}} and, if known, a location.
 *
 * A place counts as named by its whole name; by the part before a branch
 * suffix ("Ya Kun Kaya Toast" for "Ya Kun Kaya Toast @ Lavender"); or by its
 * first few words if they include a distinctive one ("Lai Soon" for "Lai
 * Soon Chicken Rice", but not "Chicken Rice" for "Chicken Rice Bowl").
 * Matching is by whole words, ignoring case, accents and the spaces inside
 * a name ("YiPing" names "Yi Ping"). Places that share a name count once,
 * as the one nearest CT Hub 2.
 */
export function placesMentioned(reply, places) {
  const index = indexReply(words(reply));
  const hits = [];
  for (const place of places) {
    const name = place.displayName?.text;
    const at = name ? firstMention(index, name) : -1;
    if (at >= 0) {
      hits.push({
        place,
        at,
        key: words(name).join(" "),
        metres: place.location
          ? haversineMetres(CT_HUB_2, place.location)
          : Infinity,
      });
    }
  }
  hits.sort((a, b) => a.at - b.at || a.metres - b.metres);

  const picks = [];
  const seen = new Set();
  for (const { place, key } of hits) {
    if (!seen.has(key)) {
      seen.add(key);
      picks.push(place);
    }
  }
  return picks.slice(0, MAX_PICKS);
}

// A text's words: lowercase letters and digits, without accents.
function words(text) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Where each run of up to MAX_NAME_WORDS words first starts in the reply,
// keyed as written ("yi ping") and run together ("yiping").
function indexReply(replyWords) {
  const spaced = new Map();
  const joined = new Map();
  replyWords.forEach((_, i) => {
    for (let n = 1; n <= MAX_NAME_WORDS && i + n <= replyWords.length; n++) {
      const run = replyWords.slice(i, i + n);
      if (!spaced.has(run.join(" "))) spaced.set(run.join(" "), i);
      if (!joined.has(run.join(""))) joined.set(run.join(""), i);
    }
  });
  return { spaced, joined };
}

// The word position where the reply first names a place, or -1.
function firstMention({ spaced, joined }, name) {
  const whole = words(name);
  const base = words(name.split(BRANCH_SUFFIX)[0]);
  const positions = [];
  for (const form of [whole, base]) {
    if (form.join("").length >= MIN_NAME_CHARS) {
      positions.push(spaced.get(form.join(" ")));
      if (distinctive(form)) {
        positions.push(joined.get(form.join("")));
      }
    }
  }
  for (let count = 1; count < base.length; count++) {
    const short = base.slice(0, count);
    if (distinctive(short) && short.join("").length >= MIN_SHORT_NAME_CHARS) {
      positions.push(joined.get(short.join("")));
    }
  }
  const found = positions.filter((at) => at !== undefined);
  return found.length > 0 ? Math.min(...found) : -1;
}

function distinctive(nameWords) {
  return nameWords.some((word) => !GENERIC_WORDS.has(word));
}

/**
 * Cards for the places Uncle names in his reply, in his order. found holds
 * the Places results his searches returned this turn, by id. known holds
 * {id, name} for places the page already has cards for, so Uncle can name
 * them again without a new search.
 *
 * A place found this turn gets a full card, with photos ready to show and
 * its distance from CT Hub 2, where the searches are centred. A known place
 * the page has a card for comes back as {id, known: true}.
 */
export async function cardsForReply(reply, found, known, env) {
  const candidates = [
    ...found.values(),
    ...known
      .filter(({ id }) => !found.has(id))
      .map(({ id, name }) => ({ id, displayName: { text: name }, known: true })),
  ];
  const cards = placesMentioned(reply, candidates).map((place) =>
    place.known ? { id: place.id, known: true } : formatCard(place, CT_HUB_2),
  );
  await resolveCardPhotos(
    cards.filter((card) => !card.known),
    env,
  );
  return cards;
}

/**
 * Swap each card's photo names for image URLs. A photo name is not an image
 * URL: the media endpoint turns it into a short-lived URL that the browser
 * can load without the Places key. A photo that fails is left out rather
 * than failing the whole card.
 */
export async function resolveCardPhotos(cards, env) {
  await Promise.all(
    cards.map(async (card) => {
      card.photos = await resolvePhotos(card.photos, env);
    }),
  );
  return cards;
}

async function resolvePhotos(photos, env) {
  const resolved = await Promise.all(
    photos.map(async ({ ref, ...credit }) => {
      if (!PHOTO_NAME.test(ref ?? "")) {
        return null;
      }
      try {
        const res = await fetch(
          `${PLACES_API}/${ref}/media?maxWidthPx=${PHOTO_WIDTH_PX}&skipHttpRedirect=true`,
          {
            headers: { "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY },
            signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
          },
        );
        if (!res.ok) {
          return null;
        }
        const url = safeUrl((await res.json()).photoUri);
        return url && { url, ...credit };
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter(Boolean);
}
