// Checks the harem catalog: ecchi stays, hentai and erotica do not, and the weekly pick is stable.

const { spawn } = require("child_process");
const path = require("path");
const { Client } = require("pg");
const { isBlocked, isEcchi, sortCatalog, pickSpotlight, isoWeek } = require("../harem");

const DATABASE_URL = process.env.DATABASE_URL || "postgres://anime:anime@127.0.0.1:5432/romance_anime";
const PORT = "3457";
const BASE = "http://127.0.0.1:" + PORT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function unit() {
  assert(isBlocked({ genres: [{ mal_id: 12, name: "Hentai" }], rating: "Rx - Hentai" }), "hentai should be blocked");
  assert(isBlocked({ themes: [{ mal_id: 35, name: "Harem" }], explicit_genres: [{ mal_id: 49, name: "Erotica" }] }), "erotica should be blocked");
  assert(isBlocked({ genres: [{ mal_id: 35, name: "Harem" }], rating: "Rx - Hentai" }), "Rx should be blocked");
  assert(!isBlocked({ genres: [{ mal_id: 35, name: "Harem" }, { mal_id: 9, name: "Ecchi" }], rating: "R+ - Mild Nudity" }), "ecchi should stay");
  assert(isEcchi({ themes: [{ mal_id: 9, name: "Ecchi" }] }), "ecchi badge source");

  const sorted = sortCatalog([
    { title: "No Score", score: null },
    { title: "Low", score: 6 },
    { title: "High", score: 8.2 }
  ]);
  assert(sorted.map(function (item) { return item.title; }).join(",") === "High,Low,No Score", "null scores should sort last");

  const week = isoWeek(new Date(Date.UTC(2026, 0, 5)));
  const first = pickSpotlight(
    [{ title: "A", score: 9 }, { title: "B", score: 8 }, { title: "C", score: null }],
    new Date(Date.UTC(2026, 0, 5))
  );
  const again = pickSpotlight(
    [{ title: "A", score: 9 }, { title: "B", score: 8 }],
    new Date(Date.UTC(2026, 0, 5))
  );
  assert(first.item.title === again.item.title, "spotlight should be deterministic");
  assert(first.week === week, "spotlight week should be the ISO week");
  assert(first.item.title !== "C", "unscored titles are not the weekly pick when scored ones exist");
}

async function request(path) {
  const response = await fetch(BASE + path);
  const data = await response.json();
  return { status: response.status, data: data };
}

async function live() {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      DATABASE_URL: DATABASE_URL,
      SESSION_SECRET: "test-session-secret-please-change",
      PORT: PORT,
      NODE_ENV: "test"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  server.stdout.on("data", function (chunk) { logs += chunk; });
  server.stderr.on("data", function (chunk) { logs += chunk; });
  try {
    await waitForHealth();
    const first = await request("/api/harem?page=1&limit=20");
    assert(first.status === 200, "harem page failed: " + JSON.stringify(first.data));
    assert(first.data.total > 200, "expected a broad harem catalog, got " + first.data.total);
    assert(first.data.hasMore, "first page should offer more");
    assert(first.data.items[0].score >= first.data.items[first.data.items.length - 1].score, "page should be best to worst");

    const spotlight = await request("/api/harem/spotlight");
    const spotlightAgain = await request("/api/harem/spotlight");
    assert(spotlight.status === 200 && spotlight.data.item && spotlight.data.item.title, "missing spotlight");
    assert(spotlight.data.item.malId === spotlightAgain.data.item.malId, "spotlight changed between requests");
    assert(spotlight.data.item.score != null, "spotlight should be a scored title");

    const db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
    const rows = await db.query("SELECT title, rating, genre_ids, ecchi, score, position FROM harem_catalog ORDER BY position ASC");
    await db.end();
    assert(rows.rows.length === first.data.total, "page total should match the cache");
    rows.rows.forEach(function (row) {
      const ids = row.genre_ids || [];
      assert(ids.indexOf(12) === -1 && ids.indexOf(49) === -1, "blocked genre slipped in: " + row.title);
      assert(!/^rx\b/i.test(row.rating || ""), "Rx title slipped in: " + row.title);
    });
    assert(rows.rows.some(function (row) { return row.ecchi; }), "ecchi titles should be included");
    const blob = rows.rows.map(function (row) { return row.title.toLowerCase(); }).join("\n");
    ["nisekoi", "quintessential quintuplets", "high school dxd", "to love", "rosario", "shuffle!", "world god only knows", "love hina", "date a live"].forEach(function (name) {
      assert(blob.indexOf(name) !== -1, "missing harem title: " + name);
    });
    let previous = Infinity;
    let seenNull = false;
    rows.rows.forEach(function (row) {
      if (row.score == null) {
        seenNull = true;
        return;
      }
      assert(!seenNull, "a scored title came after an unscored one");
      assert(Number(row.score) <= previous + 0.001, "scores are not descending");
      previous = Number(row.score);
    });
    console.log("harem tests passed (" + rows.rows.length + " titles, spotlight " + spotlight.data.item.title + ")");
  } catch (err) {
    console.error(logs);
    throw err;
  } finally {
    server.kill();
  }
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(BASE + "/health");
      if (response.ok) return;
    } catch (err) {
      await new Promise(function (resolve) { setTimeout(resolve, 150); });
    }
  }
  throw new Error("server did not start");
}

unit();
live().catch(function (err) {
  console.error(err);
  process.exit(1);
});
