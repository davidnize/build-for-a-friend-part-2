// After Browse all, category tabs must change the list the user is looking at.

const { spawn } = require("child_process");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "postgres://anime:anime@127.0.0.1:5432/romance_anime";
const PORT = "3461";
const BASE = "http://127.0.0.1:" + PORT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function withPage(width, height, fn) {
  const debugPort = width === 375 ? 9345 : 9346;
  const browserProc = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=" + debugPort,
    "--window-size=" + width + "," + height,
    "--user-data-dir=/tmp/chrome-tabs-" + width + "-" + Date.now()
  ], { stdio: "ignore" });
  let version;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + debugPort + "/json/version");
      if (res.ok) {
        version = await res.json();
        break;
      }
    } catch (err) {
      await sleep(120);
    }
  }
  if (!version) {
    browserProc.kill();
    throw new Error("Chrome did not start");
  }
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  function send(method, params, sessionId) {
    const id = ++seq;
    const payload = { id: id, method: method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    socket.send(JSON.stringify(payload));
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
    });
  }
  await new Promise(function (resolve, reject) {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  socket.addEventListener("message", function (event) {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    }
  });
  const created = await send("Target.createTarget", { url: "about:blank" });
  const attached = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width: width,
    height: height,
    deviceScaleFactor: width < 500 ? 2 : 1,
    mobile: width < 500
  }, sessionId);
  await send("Page.navigate", { url: BASE + "/" }, sessionId);
  await sleep(400);
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression: expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  try {
    return await fn(evaluate, sessionId, send);
  } finally {
    socket.close();
    browserProc.kill();
  }
}

async function runFlow(width, height) {
  return withPage(width, height, async function (evaluate, sessionId, send) {
    const user = "tabs" + Date.now().toString(36);
    await evaluate(`(async () => {
      const start = Date.now();
      while (!document.getElementById("auth-username") && Date.now() - start < 5000) {
        await new Promise(r => setTimeout(r, 50));
      }
      document.getElementById("show-signup").click();
      document.getElementById("auth-username").value = ${JSON.stringify(user)};
      document.getElementById("auth-passphrase").value = "tabs-secret";
      document.getElementById("auth-form").requestSubmit();
      const start2 = Date.now();
      while (document.querySelectorAll(".online-card").length < 20 && Date.now() - start2 < 20000) {
        await new Promise(r => setTimeout(r, 100));
      }
    })()`);

    let shelfShot = null;
    if (width <= 430) {
      const shelf = await evaluate(`(() => {
        document.getElementById("filters").scrollIntoView({block:"start"});
        const input = document.querySelector(".search input");
        const button = document.getElementById("search-online");
        const gap = Math.round(button.getBoundingClientRect().top - input.getBoundingClientRect().bottom);
        const cards = [...document.querySelectorAll("#list .card")];
        return {
          gap: gap,
          shelf: cards.length,
          cardH: cards[0] ? Math.round(cards[0].getBoundingClientRect().height) : 0,
          status: document.getElementById("status").textContent,
          pressed: document.querySelector('.filter[aria-pressed="true"]').getAttribute("data-category")
        };
      })()`);
      assert(shelf.pressed === "Harem", "Harem tab should be selected, got " + shelf.pressed);
      assert(shelf.shelf === 5, "Harem tab should render 5 shelf titles, got " + shelf.shelf);
      assert(shelf.cardH > 40, "Harem shelf card has no height");
      assert(shelf.gap < 40, "search box and buttons should sit together, gap was " + shelf.gap);
      assert(shelf.status.indexOf("5") !== -1, "status should mention the 5 titles, got " + shelf.status);
      shelfShot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    }

    await evaluate(`document.getElementById("browse-harem").click()`);
    const harem = await waitFor(evaluate, functionBody('document.getElementById("online-heading").textContent === "Every harem anime" && document.querySelectorAll(".online-card").length === 100'));
    assert(harem.heading === "Every harem anime", "browse harem heading");
    assert(harem.cards === 100, "browse harem should show 100 cards, got " + harem.cards);

    await evaluate(`document.querySelector('[data-category="Movies"]').click()`);
    const movies = await waitFor(evaluate, functionBody('document.getElementById("online-heading").textContent === "Romance movies" && document.querySelectorAll(".online-card").length >= 20'));
    assert(movies.heading === "Romance movies", "Movies tab should retitle the browse list, got " + movies.heading);
    assert(movies.search === "", "Movies tab should clear the search box");
    assert(movies.pressed === "Movies", "Movies tab should look selected");
    assert(movies.sample.indexOf("Movie") !== -1, "Movies tab should show movie-type titles, got " + movies.sample);
    assert(movies.cards === 100, "Movies tab should show 100 cards, got " + movies.cards);
    await evaluate(`document.getElementById("online").scrollIntoView({block:"start"})`);
    const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);

    await evaluate(`document.querySelector('[data-category="Slice of Life"]').click()`);
    const slice = await waitFor(evaluate, functionBody('document.querySelectorAll(".online-card").length === 0 && document.getElementById("status").textContent.indexOf("Slice of Life") !== -1'));
    assert(slice.cards === 0, "Slice of Life should close the browse list");
    assert(slice.shelf.indexOf("Slice of Life") !== -1, "Slice of Life should filter the shelf, got " + slice.shelf);
    assert(slice.pressed === "Slice of Life", "Slice of Life tab should look selected");

    await evaluate(`document.getElementById("browse-romance").click()`);
    const romance = await waitFor(evaluate, functionBody('document.getElementById("online-heading").textContent === "Every romance anime" && document.querySelectorAll(".online-card").length === 100'));
    assert(romance.heading === "Every romance anime", "browse romance heading");
    assert(romance.cards === 100, "browse romance should show 100 cards");

    await evaluate(`document.querySelector('[data-category="Harem"]').click()`);
    const back = await waitFor(evaluate, functionBody('document.getElementById("online-heading").textContent === "Every harem anime" && document.querySelectorAll(".online-card").length === 100'));
    assert(back.heading === "Every harem anime", "Harem tab after romance should show harem titles");
    assert(back.pressed === "Harem", "Harem tab should look selected");
    assert(back.search === "", "Harem tab should clear the search box");

    await evaluate(`document.querySelector('[data-category="All"]').click()`);
    const all = await waitFor(evaluate, functionBody('document.getElementById("online-heading").textContent === "Every romance anime"'));
    assert(all.heading === "Every romance anime", "All tab should show the full romance list");
    assert(all.pressed === "All", "All tab should look selected");

    return { user: user, shot: (shelfShot || shot).data, summary: movies };
  });
}

function functionBody(condition) {
  return `(async () => {
    const start = Date.now();
    while (!(${condition}) && Date.now() - start < 15000) await new Promise(r => setTimeout(r, 100));
    const sample = document.querySelector(".online-card .meta");
    return {
      heading: document.getElementById("online-heading").textContent,
      status: document.getElementById("online-status").textContent,
      cards: document.querySelectorAll(".online-card").length,
      search: document.getElementById("search").value,
      pressed: (document.querySelector('.filter[aria-pressed="true"]') || {}).getAttribute ? document.querySelector('.filter[aria-pressed="true"]').getAttribute("data-category") : "",
      shelf: document.getElementById("status").textContent,
      sample: sample ? sample.textContent : ""
    };
  })()`;
}

async function waitFor(evaluate, expression) {
  return evaluate(expression);
}

async function main() {
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
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(BASE + "/health");
        if (res.ok) break;
      } catch (err) {
        await sleep(150);
      }
      if (i === 39) throw new Error("server did not start");
    }
    const phone = await runFlow(390, 812);
    require("fs").writeFileSync("/tmp/tab-after-browse-phone.png", Buffer.from(phone.shot, "base64"));
    const desktop = await runFlow(1280, 900);
    require("fs").writeFileSync("/tmp/tab-after-browse-desktop.png", Buffer.from(desktop.shot, "base64"));
    console.log("tab tests passed");
  } catch (err) {
    console.error(logs);
    throw err;
  } finally {
    server.kill();
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
