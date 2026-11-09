// Signs up two people against a real Postgres database and checks their lists stay separate.

const { spawn } = require("child_process");
const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "postgres://anime:anime@localhost:5432/romance_anime";
const SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-please-change";
const PORT = process.env.PORT || "3456";
const BASE = "http://127.0.0.1:" + PORT;

const stamp = Date.now().toString(36);
const ada = "ada_" + stamp;
const grace = "grace_" + stamp;
const phrase = "correct-horse";
const onlyAda = "Only Ada " + stamp;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options) {
  const settings = options || {};
  const response = await fetch(BASE + path, {
    method: settings.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Cookie: settings.cookie || ""
    },
    body: settings.body ? JSON.stringify(settings.body) : undefined
  });
  const setCookie = response.headers.get("set-cookie") || "";
  const text = await response.text();
  let data = {};
  if (text) data = JSON.parse(text);
  return { status: response.status, data: data, cookie: setCookie };
}

function sid(setCookie) {
  const match = /sid=([^;]+)/.exec(setCookie);
  assert(match, "missing session cookie");
  assert(/HttpOnly/i.test(setCookie), "cookie should be HttpOnly");
  assert(/SameSite=Lax/i.test(setCookie), "cookie should be SameSite=Lax");
  return "sid=" + match[1];
}

function titles(items) {
  return items.map(function (item) {
    return item.title;
  });
}

async function main() {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: require("path").join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      DATABASE_URL: DATABASE_URL,
      SESSION_SECRET: SESSION_SECRET,
      PORT: PORT,
      AUTH_RATE_LIMIT: "40",
      NODE_ENV: "test"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  server.stdout.on("data", function (chunk) { logs += chunk; });
  server.stderr.on("data", function (chunk) { logs += chunk; });

  try {
    await waitForHealth();

    const health = await request("/health");
    assert(health.status === 200 && health.data.ok === true, "health check failed");

    const guest = await request("/api/anime");
    assert(guest.status === 401, "guests should not see a list");

    const short = await request("/api/signup", {
      method: "POST",
      body: { username: ada, passphrase: "short" }
    });
    assert(short.status === 400, "short passphrase should be rejected");

    const adaSignup = await request("/api/signup", {
      method: "POST",
      body: { username: ada, passphrase: phrase }
    });
    assert(adaSignup.status === 201, "Ada signup failed: " + JSON.stringify(adaSignup.data));
    const adaCookie = sid(adaSignup.cookie);

    const graceSignup = await request("/api/signup", {
      method: "POST",
      body: { username: grace, passphrase: phrase + "-other" }
    });
    assert(graceSignup.status === 201, "Grace signup failed");
    const graceCookie = sid(graceSignup.cookie);

    const taken = await request("/api/signup", {
      method: "POST",
      body: { username: ada.toUpperCase(), passphrase: phrase }
    });
    assert(taken.status === 409, "duplicate username should be rejected");

    const adaList = await request("/api/anime", { cookie: adaCookie });
    const graceList = await request("/api/anime", { cookie: graceCookie });
    assert(adaList.status === 200 && adaList.data.items.length === 20, "Ada should start with 20 titles");
    assert(graceList.status === 200 && graceList.data.items.length === 20, "Grace should start with 20 titles");
    assert(titles(adaList.data.items).indexOf("Horimiya") !== -1, "seed is missing");

    const added = await request("/api/anime", {
      method: "POST",
      cookie: adaCookie,
      body: { title: onlyAda, category: "Movies", year: 2024, note: "Ada's private note" }
    });
    assert(added.status === 201, "add failed");
    assert(titles(added.data.items).indexOf(onlyAda) !== -1, "Ada's new title is missing");
    assert(added.data.items.length === 21, "Ada should have 21 titles");

    const graceAfter = await request("/api/anime", { cookie: graceCookie });
    assert(titles(graceAfter.data.items).indexOf(onlyAda) === -1, "Grace can see Ada's title");
    assert(graceAfter.data.items.length === 20, "Grace's list changed");

    const db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
    const users = await db.query(
      "SELECT id, username, passphrase_hash FROM users WHERE username = ANY($1::text[])",
      [[ada, grace]]
    );
    assert(users.rows.length === 2, "both users should be stored");
    users.rows.forEach(function (row) {
      assert(row.passphrase_hash.indexOf("$2") === 0, "passphrase should be a bcrypt hash");
      assert(row.passphrase_hash.indexOf(phrase) === -1, "passphrase was stored in plain text");
    });
    const privateRows = await db.query(
      `SELECT users.username
       FROM anime_items
       JOIN users ON users.id = anime_items.user_id
       WHERE anime_items.title = $1`,
      [onlyAda]
    );
    assert(privateRows.rows.length === 1 && privateRows.rows[0].username === ada, "title is not private to Ada");
    await db.end();

    const removed = await request("/api/anime/" + encodeURIComponent(added.data.items[added.data.items.length - 1].id), {
      method: "DELETE",
      cookie: adaCookie
    });
    assert(removed.status === 200 && titles(removed.data.items).indexOf(onlyAda) === -1, "delete failed");

    const reset = await request("/api/anime/reset", { method: "POST", cookie: adaCookie });
    assert(reset.status === 200 && reset.data.items.length === 20, "reset failed");
    assert(titles(reset.data.items).indexOf("Toradora!") !== -1, "reset did not restore the seed");

    const loggedOut = await request("/api/logout", { method: "POST", cookie: adaCookie });
    assert(loggedOut.status === 200, "logout failed");
    const afterLogout = await request("/api/me", { cookie: adaCookie });
    assert(afterLogout.status === 401, "old session should stop working");
    const graceStill = await request("/api/me", { cookie: graceCookie });
    assert(graceStill.status === 200 && graceStill.data.username === grace, "Grace was logged out too");

    const badLogin = await request("/api/login", {
      method: "POST",
      body: { username: ada, passphrase: "wrong-passphrase" }
    });
    assert(badLogin.status === 401, "wrong passphrase should fail");

    const goodLogin = await request("/api/login", {
      method: "POST",
      body: { username: ada, passphrase: phrase }
    });
    assert(goodLogin.status === 200, "login failed");
    const adaAgain = await request("/api/anime", { cookie: sid(goodLogin.cookie) });
    assert(adaAgain.data.items.length === 20, "Ada's list did not survive a new login");
    assert(titles(adaAgain.data.items).indexOf(onlyAda) === -1, "deleted title came back without reset");

    let limited = 0;
    for (let i = 0; i < 45; i++) {
      const attempt = await request("/api/login", {
        method: "POST",
        body: { username: "nobody", passphrase: "wrong-passphrase" }
      });
      if (attempt.status === 429) {
        limited = attempt.status;
        assert(attempt.data.error && attempt.data.error.indexOf("Too many") !== -1, "rate limit message missing");
        break;
      }
    }
    assert(limited === 429, "auth routes should rate limit");

    console.log("privacy tests passed");
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

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
