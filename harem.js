// Catalog helpers. Romance is Jikan genre 22. Harem is genre/theme 35.
// The saved list is the union, sorted by score. Hentai (12), Erotica (49), and Rx stay out.
// Ecchi (9) stays in. Harem titles are flagged so the app can spotlight them.

const JIKAN_URL = "https://api.jikan.moe/v4/anime";
const TENRAI_URL = "https://api.tenrai.org/v1/anime";
const PAGE_LIMIT = 25;
const MAX_PAGES = 120;
const REQUEST_GAP_MS = 380;
const HENTAI_GENRE = 12;
const EROTICA_GENRE = 49;
const ECCHI_GENRE = 9;
const HAREM_GENRE = 35;
const ROMANCE_GENRE = 22;
const CATALOG_VERSION = 2;

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function tagList(anime) {
  return []
    .concat(anime.genres || [])
    .concat(anime.themes || [])
    .concat(anime.explicit_genres || [])
    .concat(anime.demographics || []);
}

function genreIds(anime) {
  return tagList(anime)
    .map(function (tag) {
      return tag && tag.mal_id;
    })
    .filter(function (id) {
      return Number.isInteger(id);
    });
}

function isBlocked(anime) {
  const ids = genreIds(anime);
  if (ids.indexOf(HENTAI_GENRE) !== -1 || ids.indexOf(EROTICA_GENRE) !== -1) return true;
  const rating = String((anime && anime.rating) || "");
  if (/^rx\b/i.test(rating) || /hentai/i.test(rating)) return true;
  return false;
}

function isHarem(anime) {
  return genreIds(anime).indexOf(HAREM_GENRE) !== -1;
}

function isEcchi(anime) {
  if (genreIds(anime).indexOf(ECCHI_GENRE) !== -1) return true;
  return tagList(anime).some(function (tag) {
    return tag && /ecchi/i.test(tag.name || "");
  });
}

function cleanSynopsis(text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s*\[Written by MAL Rewrite\]\s*$/i, "")
    .trim();
  return clean.slice(0, 600);
}

function pickYear(anime) {
  if (Number.isInteger(anime.year) && anime.year > 1900) return anime.year;
  const from = anime.aired && anime.aired.prop && anime.aired.prop.from;
  if (from && Number.isInteger(from.year) && from.year > 1900) return from.year;
  return null;
}

function pickPoster(anime) {
  const images = anime.images && (anime.images.jpg || anime.images.webp);
  const url = images && (images.image_url || images.large_image_url || images.small_image_url);
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.href;
  } catch (err) {
    return null;
  }
}

function normalizeAnime(anime) {
  if (!anime || isBlocked(anime)) return null;
  const malId = Number.isInteger(anime.mal_id) ? anime.mal_id : null;
  const original = String(anime.title || "").trim();
  const english = String(anime.title_english || "").trim();
  const title = (english || original).trim();
  if (!malId || !title) return null;
  const altTitle = english && original && english.toLowerCase() !== original.toLowerCase() ? original.slice(0, 180) : "";
  const score = typeof anime.score === "number" && isFinite(anime.score) ? anime.score : null;
  const episodes = Number.isInteger(anime.episodes) ? anime.episodes : null;
  return {
    malId: malId,
    title: title.slice(0, 180),
    altTitle: altTitle,
    harem: isHarem(anime),
    score: score,
    type: String(anime.type || "Anime"),
    year: pickYear(anime),
    episodes: episodes,
    synopsis: cleanSynopsis(anime.synopsis),
    poster: pickPoster(anime),
    rating: String(anime.rating || ""),
    ecchi: isEcchi(anime),
    genreIds: genreIds(anime)
  };
}

function sortCatalog(items) {
  return items.slice().sort(function (a, b) {
    if (a.score == null && b.score != null) return 1;
    if (b.score == null && a.score != null) return -1;
    if (a.score != null && b.score != null && a.score !== b.score) return b.score - a.score;
    return a.title.localeCompare(b.title);
  });
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function excludedFromSpotlight(item) {
  const title = String((item && item.title) || "") + " " + String((item && (item.altTitle || item.alt_title)) || "");
  return /dxd/i.test(title);
}

function pickSpotlight(items, date) {
  const ranked = sortCatalog(items).filter(function (item) {
    return item.score != null && !excludedFromSpotlight(item);
  });
  const pool = ranked.slice(0, 52);
  if (!pool.length) return null;
  const week = isoWeek(date || new Date());
  return { week: week, item: pool[(week - 1) % pool.length] };
}

function pageUrl(host, genreId, page) {
  const params = new URLSearchParams({
    genres: String(genreId),
    genres_exclude: HENTAI_GENRE + "," + EROTICA_GENRE,
    order_by: "score",
    sort: "desc",
    // sfw=true also hides a lot of R+ ecchi romance. Genre excludes plus the Rx filter keep adult titles out.
    sfw: "false",
    limit: String(PAGE_LIMIT),
    page: String(page)
  });
  return host + "?" + params.toString();
}

async function fetchPage(host, genreId, page) {
  const url = pageUrl(host, genreId, page);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "harem-hunter" }
    });
    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after")) || 2;
      await sleep(Math.min(wait, 10) * 1000);
      continue;
    }
    if (!response.ok) {
      const error = new Error("Harem search failed (" + response.status + ")");
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  const error = new Error("The anime search is busy. Try again in a minute.");
  error.status = 429;
  throw error;
}

async function chooseHost() {
  try {
    const response = await fetch(pageUrl(JIKAN_URL, ROMANCE_GENRE, 1), {
      headers: { Accept: "application/json", "User-Agent": "harem-hunter" },
      signal: AbortSignal.timeout(5000)
    });
    if (response.ok) return JIKAN_URL;
  } catch (err) {
    // The public Jikan host stopped answering in October 2026. Tenrai uses the same shape.
  }
  return TENRAI_URL;
}

function remember(into, anime, forceHarem) {
  const item = normalizeAnime(anime);
  if (!item) return;
  if (forceHarem) item.harem = true;
  const previous = into.get(item.malId);
  if (previous && previous.harem) item.harem = true;
  into.set(item.malId, item);
}

async function pullGenre(host, genreId, into, forceHarem) {
  let page = 1;
  let last = 1;
  while (page <= last && page <= MAX_PAGES) {
    const payload = await fetchPage(host, genreId, page);
    const pagination = payload.pagination || {};
    last = pagination.last_visible_page || page;
    const rows = Array.isArray(payload.data) ? payload.data : [];
    rows.forEach(function (anime) {
      remember(into, anime, forceHarem);
    });
    if (!pagination.has_next_page || !rows.length) break;
    page += 1;
    await sleep(REQUEST_GAP_MS);
  }
}

async function fetchCatalog() {
  const host = await chooseHost();
  const into = new Map();
  await pullGenre(host, ROMANCE_GENRE, into, false);
  await sleep(REQUEST_GAP_MS);
  await pullGenre(host, HAREM_GENRE, into, true);
  return sortCatalog(Array.from(into.values()));
}

module.exports = {
  JIKAN_URL,
  TENRAI_URL,
  HAREM_GENRE,
  ROMANCE_GENRE,
  CATALOG_VERSION,
  isBlocked,
  isHarem,
  excludedFromSpotlight,
  isEcchi,
  normalizeAnime,
  sortCatalog,
  isoWeek,
  pickSpotlight,
  pageUrl,
  fetchCatalog
};
