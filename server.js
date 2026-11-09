// Romance Anime List server.
// Serves the static page and a small JSON API. Each account has a private list in Postgres.

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { CATEGORIES, SEED } = require("./seed");
const { fetchCatalog, pickSpotlight } = require("./harem");

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_DAYS = 14;
const BCRYPT_ROUNDS = 10;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.error("SESSION_SECRET is required and must be at least 16 characters.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: databaseSsl(DATABASE_URL)
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));

app.get("/health", function (req, res) {
  res.json({ ok: true });
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many tries. Wait a few minutes, then try again." }
});

app.post("/api/signup", authLimiter, asyncRoute(signup));
app.post("/api/login", authLimiter, asyncRoute(login));
app.post("/api/logout", asyncRoute(logout));
app.get("/api/me", asyncRoute(me));
app.get("/api/anime", asyncRoute(requireUser), asyncRoute(getAnime));
app.post("/api/anime", asyncRoute(requireUser), asyncRoute(addAnime));
app.post("/api/anime/reset", asyncRoute(requireUser), asyncRoute(resetAnime));
app.put("/api/anime", asyncRoute(requireUser), asyncRoute(replaceAnime));
app.delete("/api/anime/:id", asyncRoute(requireUser), asyncRoute(deleteAnime));
app.get("/api/harem/spotlight", asyncRoute(haremSpotlight));
app.get("/api/harem", asyncRoute(haremPage));

app.use(express.static(path.join(__dirname, "public")));

app.use(function (err, req, res, next) {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong." });
});

let dummyHash = "";

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});

async function main() {
  dummyHash = await bcrypt.hash("not-a-real-passphrase", BCRYPT_ROUNDS);
  await setupDatabase();
  app.listen(PORT, "0.0.0.0", function () {
    console.log("Romance Anime List listening on " + PORT);
  });
}

function databaseSsl(connectionString) {
  // Render's external URL asks for TLS. Local Postgres usually does not.
  if (/sslmode=require/i.test(connectionString) || /render\.com/i.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      passphrase_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anime_items (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      year INTEGER,
      category TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      poster TEXT,
      mal_id INTEGER,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    )
  `);
  await pool.query("DELETE FROM sessions WHERE expires_at < now()");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS harem_catalog (
      mal_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      score DOUBLE PRECISION,
      type TEXT,
      year INTEGER,
      episodes INTEGER,
      synopsis TEXT,
      poster TEXT,
      rating TEXT,
      ecchi BOOLEAN NOT NULL DEFAULT FALSE,
      genre_ids INTEGER[] NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL,
      refreshed_at TIMESTAMPTZ NOT NULL
    )
  `);
}

const HAREM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let haremRefresh = null;

async function haremSpotlight(req, res) {
  await ensureHaremCatalog();
  const ranked = await pool.query(
    `SELECT mal_id, title, score, type, year, episodes, synopsis, poster, ecchi
     FROM harem_catalog
     WHERE score IS NOT NULL
     ORDER BY position ASC
     LIMIT 52`
  );
  const picked = pickSpotlight(ranked.rows.map(rowToHarem), new Date());
  if (!picked) return res.status(503).json({ error: "The harem list is not ready yet." });
  res.json({ week: picked.week, item: picked.item });
}

async function haremPage(req, res) {
  await ensureHaremCatalog();
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;
  const totalResult = await pool.query("SELECT COUNT(*)::int AS total FROM harem_catalog");
  const total = totalResult.rows[0].total;
  const rows = await pool.query(
    `SELECT mal_id, title, score, type, year, episodes, synopsis, poster, ecchi
     FROM harem_catalog
     ORDER BY position ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  res.json({
    page: page,
    limit: limit,
    total: total,
    hasMore: offset + rows.rows.length < total,
    items: rows.rows.map(rowToHarem)
  });
}

function rowToHarem(row) {
  return {
    malId: row.mal_id,
    title: row.title,
    score: row.score,
    type: row.type,
    year: row.year,
    episodes: row.episodes,
    synopsis: row.synopsis,
    poster: row.poster,
    ecchi: row.ecchi
  };
}

async function ensureHaremCatalog() {
  const found = await pool.query("SELECT COUNT(*)::int AS total, MAX(refreshed_at) AS refreshed_at FROM harem_catalog");
  const total = found.rows[0].total;
  const refreshedAt = found.rows[0].refreshed_at ? new Date(found.rows[0].refreshed_at).getTime() : 0;
  const fresh = total > 0 && Date.now() - refreshedAt < HAREM_MAX_AGE_MS;
  if (fresh) return;
  if (total > 0) {
    refreshHaremCatalog().catch(function (err) {
      console.error("Harem refresh failed", err);
    });
    return;
  }
  await refreshHaremCatalog();
}

function refreshHaremCatalog() {
  if (!haremRefresh) {
    haremRefresh = writeHaremCatalog().finally(function () {
      haremRefresh = null;
    });
  }
  return haremRefresh;
}

async function writeHaremCatalog() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(354235)");
    const found = await client.query("SELECT COUNT(*)::int AS total, MAX(refreshed_at) AS refreshed_at FROM harem_catalog");
    const refreshedAt = found.rows[0].refreshed_at ? new Date(found.rows[0].refreshed_at).getTime() : 0;
    if (found.rows[0].total > 0 && Date.now() - refreshedAt < HAREM_MAX_AGE_MS) return;
    const items = await fetchCatalog();
    if (!items.length) throw new Error("Harem catalog came back empty");
    const refreshed = new Date();
    await client.query("BEGIN");
    await client.query("DELETE FROM harem_catalog");
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await client.query(
        `INSERT INTO harem_catalog
          (mal_id, title, score, type, year, episodes, synopsis, poster, rating, ecchi, genre_ids, position, refreshed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          item.malId,
          item.title,
          item.score,
          item.type,
          item.year,
          item.episodes,
          item.synopsis,
          item.poster,
          item.rating,
          item.ecchi,
          item.genreIds,
          i,
          refreshed
        ]
      );
    }
    await client.query("COMMIT");
    console.log("Cached " + items.length + " harem titles");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // The transaction may not have started.
    }
    throw err;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(354235)");
    } catch (unlockErr) {
      // The connection is closing anyway.
    }
    client.release();
  }
}

function asyncRoute(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function loadUser(req) {
  const signed = readCookie(req, "sid");
  const id = signed ? unsign(signed) : null;
  if (!id) return null;
  const result = await pool.query(
    `SELECT users.id, users.username
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = $1 AND sessions.expires_at > now()`,
    [id]
  );
  return result.rows[0] || null;
}

async function requireUser(req, res, next) {
  req.user = await loadUser(req);
  if (!req.user) {
    res.status(401).json({ error: "Please log in." });
    return;
  }
  next();
}

async function signup(req, res) {
  const username = cleanUsername(req.body && req.body.username);
  const passphrase = req.body && req.body.passphrase;
  const problem = accountProblem(username, passphrase);
  if (problem) return res.status(400).json({ error: problem });

  const hash = await bcrypt.hash(passphrase, BCRYPT_ROUNDS);
  const client = await pool.connect();
  let user;
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      "INSERT INTO users (username, passphrase_hash) VALUES ($1, $2) RETURNING id, username",
      [username, hash]
    );
    user = inserted.rows[0];
    await insertItems(client, user.id, SEED);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      return res.status(409).json({ error: "That username is taken." });
    }
    throw err;
  } finally {
    client.release();
  }

  await startSession(res, user.id);
  res.status(201).json({ username: user.username });
}

async function login(req, res) {
  const username = cleanUsername(req.body && req.body.username);
  const passphrase = typeof (req.body && req.body.passphrase) === "string" ? req.body.passphrase : "";
  const found = await pool.query("SELECT id, username, passphrase_hash FROM users WHERE username = $1", [
    username || ""
  ]);
  const user = found.rows[0];
  const ok = await bcrypt.compare(passphrase, user ? user.passphrase_hash : dummyHash);
  if (!user || !ok) {
    return res.status(401).json({ error: "Username or passphrase is wrong." });
  }
  await startSession(res, user.id);
  res.json({ username: user.username });
}

async function logout(req, res) {
  const signed = readCookie(req, "sid");
  const id = signed ? unsign(signed) : null;
  if (id) await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  clearSessionCookie(res);
  res.json({ ok: true });
}

async function me(req, res) {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  res.json({ username: user.username });
}

async function getAnime(req, res) {
  res.json({ items: await listFor(req.user.id) });
}

async function addAnime(req, res) {
  const item = normalizeItem(req.body || {}, true);
  if (item.error) return res.status(400).json({ error: item.error });
  const next = await pool.query(
    "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM anime_items WHERE user_id = $1",
    [req.user.id]
  );
  try {
    await pool.query(
      `INSERT INTO anime_items (id, user_id, title, year, category, note, poster, mal_id, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        item.id,
        req.user.id,
        item.title,
        item.year,
        item.category,
        item.note,
        item.poster,
        item.malId,
        next.rows[0].next
      ]
    );
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That title is already on your shelf." });
    throw err;
  }
  res.status(201).json({ items: await listFor(req.user.id) });
}

async function deleteAnime(req, res) {
  await pool.query("DELETE FROM anime_items WHERE user_id = $1 AND id = $2", [req.user.id, req.params.id]);
  res.json({ items: await listFor(req.user.id) });
}

async function resetAnime(req, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM anime_items WHERE user_id = $1", [req.user.id]);
    await insertItems(client, req.user.id, SEED);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json({ items: await listFor(req.user.id) });
}

async function replaceAnime(req, res) {
  const incoming = req.body && req.body.items;
  if (!Array.isArray(incoming) || incoming.length === 0 || incoming.length > 200) {
    return res.status(400).json({ error: "Send a list of 1 to 200 titles to import." });
  }
  const items = [];
  const seen = new Set();
  incoming.forEach(function (raw) {
    const item = normalizeItem(raw, false);
    if (item.error || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  });
  if (!items.length) return res.status(400).json({ error: "None of those titles could be imported." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM anime_items WHERE user_id = $1", [req.user.id]);
    await insertItems(client, req.user.id, items);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json({ items: await listFor(req.user.id) });
}

async function listFor(userId) {
  const result = await pool.query(
    `SELECT id, title, year, category, note, poster, mal_id
     FROM anime_items
     WHERE user_id = $1
     ORDER BY position ASC, title ASC`,
    [userId]
  );
  return result.rows.map(function (row) {
    return {
      id: row.id,
      title: row.title,
      year: row.year,
      category: row.category,
      note: row.note,
      poster: row.poster,
      malId: row.mal_id
    };
  });
}

async function insertItems(client, userId, items) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    await client.query(
      `INSERT INTO anime_items (id, user_id, title, year, category, note, poster, mal_id, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [item.id, userId, item.title, item.year, item.category, item.note || "", item.poster || null, item.malId || null, i]
    );
  }
}

async function startSession(res, userId) {
  const id = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [id, userId, expires]);
  setSessionCookie(res, sign(id));
}

function sign(id) {
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update(id).digest("hex");
  return id + "." + mac;
}

function unsign(value) {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(id).digest("hex");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  return id;
}

function setSessionCookie(res, value) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader("Set-Cookie", "sid=" + value + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + maxAge + secure);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" + secure);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i].trim();
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    if (piece.slice(0, eq) === name) return decodeURIComponent(piece.slice(eq + 1));
  }
  return "";
}

function cleanUsername(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function accountProblem(username, passphrase) {
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return "Username should be 3 to 24 letters, numbers, or underscores.";
  }
  if (typeof passphrase !== "string" || passphrase.length < 8) {
    return "Passphrase should be at least 8 characters.";
  }
  if (passphrase.length > 72) {
    return "Passphrase should be 72 characters or fewer.";
  }
  return "";
}

function normalizeItem(raw, makeId) {
  if (!raw || typeof raw !== "object") return { error: "Title and category are required." };
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title || title.length > 180) return { error: "Title is required." };
  if (CATEGORIES.indexOf(raw.category) === -1) return { error: "Choose a category." };
  let year = null;
  if (raw.year !== null && raw.year !== undefined && raw.year !== "") {
    year = Number(raw.year);
    if (!Number.isInteger(year) || year < 1910 || year > 2035) {
      return { error: "Year should be a four-digit year, like 2016." };
    }
  }
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 500) : "";
  const poster = safePoster(raw.poster);
  const malId = cleanMalId(raw.malId);
  let id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    if (!makeId) return { error: "That title could not be saved." };
    id = crypto.randomBytes(12).toString("hex");
  }
  return { id: id, title: title, year: year, category: raw.category, note: note, poster: poster, malId: malId };
}

function safePoster(url) {
  if (typeof url !== "string" || !url || url.length > 500) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.href;
  } catch (err) {
    return null;
  }
}

function cleanMalId(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (parsed > 0) return parsed;
  }
  return null;
}
