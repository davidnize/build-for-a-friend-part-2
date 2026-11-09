(function () {
  "use strict";

  var STORAGE_KEY = "romance-anime-shelf-v1";
  var IMPORT_SKIP_KEY = "romance-anime-import-skipped";
  var CATEGORIES = ["Slice of Life", "Harem", "Love Triangle", "Movies"];
  // Jikan's public host stopped answering in October 2026. Tenrai returns the same search shape, with no key.
  var JIKAN_URL = "https://api.jikan.moe/v4/anime";
  var TENRAI_URL = "https://api.tenrai.org/v1/anime";

  var state = {
    items: [],
    category: "Harem",
    query: "",
    username: ""
  };

  var onlineState = { phase: "idle", query: "", results: [], mode: "search", page: 0, hasMore: false, total: 0, loadingMore: false };
  var spotlightItem = null;
  var onlineTimer = null;
  var onlineAbort = null;
  var skipJikan = false;

  var filtersEl = document.getElementById("filters");
  var listEl = document.getElementById("list");
  var statusEl = document.getElementById("status");
  var searchEl = document.getElementById("search");
  var formEl = document.getElementById("add-form");
  var errorEl = document.getElementById("form-error");
  var resetEl = document.getElementById("reset-shelf");
  var onlineButton = document.getElementById("search-online");
  var onlineStatusEl = document.getElementById("online-status");
  var onlineResultsEl = document.getElementById("online-results");

  filtersEl.addEventListener("click", onFilterClick);
  searchEl.addEventListener("input", onSearchInput);
  onlineButton.addEventListener("click", function () {
    state.query = searchEl.value;
    renderShelf();
    scheduleOnline(true);
  });
  formEl.addEventListener("submit", onAdd);
  resetEl.addEventListener("click", onReset);
  listEl.addEventListener("click", onListClick);
  onlineResultsEl.addEventListener("click", onOnlineAdd);
  document.getElementById("browse-harem").addEventListener("click", onBrowseHarem);
  document.getElementById("browse-romance").addEventListener("click", onBrowseRomance);
  document.getElementById("load-more").addEventListener("click", function () {
    loadMoreHarem();
  });
  document.getElementById("spotlight").addEventListener("click", onSpotlightAdd);
  if (window.IntersectionObserver) {
    var moreObserver = new IntersectionObserver(function (entries) {
      if (entries.some(function (entry) { return entry.isIntersecting; })) loadMoreHarem();
    }, { rootMargin: "300px" });
    moreObserver.observe(document.getElementById("load-more"));
  }
  document.getElementById("logout").addEventListener("click", onLogout);
  document.getElementById("auth-form").addEventListener("submit", onAuthSubmit);
  document.getElementById("show-login").addEventListener("click", function () {
    setAuthMode("login");
  });
  document.getElementById("show-signup").addEventListener("click", function () {
    setAuthMode("signup");
  });
  document.getElementById("import-yes").addEventListener("click", onImport);
  document.getElementById("import-no").addEventListener("click", function () {
    localStorage.setItem(IMPORT_SKIP_KEY, state.username);
    document.getElementById("import-banner").hidden = true;
  });

  boot();

  function boot() {
    api("/api/me")
      .then(function (me) {
        return openShelf(me.username);
      })
      .catch(function (err) {
        if (err.status === 401) showAuth();
        else showAuthError(err.message || "The shelf could not be reached.");
      });
  }

  function api(path, options) {
    var settings = options || {};
    return fetch(path, {
      method: settings.method || "GET",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: settings.body
    }).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || "Request failed.");
          error.status = response.status;
          throw error;
        }
        return data;
      });
    });
  }

  function openShelf(username) {
    state.username = username;
    return api("/api/anime").then(function (data) {
      state.items = data.items || [];
      document.getElementById("current-user").textContent = username;
      document.getElementById("boot").hidden = true;
      document.getElementById("auth-screen").hidden = true;
      document.getElementById("shelf").hidden = false;
      state.category = "Harem";
      renderShelf();
      offerImport();
      loadSpotlight();
      startHaremBrowse();
    });
  }

  function showAuth() {
    document.getElementById("boot").hidden = true;
    document.getElementById("shelf").hidden = true;
    document.getElementById("auth-screen").hidden = false;
  }

  function showAuthError(message) {
    showAuth();
    var el = document.getElementById("auth-error");
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = message;
  }

  function setAuthMode(mode) {
    var signup = mode === "signup";
    document.getElementById("auth-form").setAttribute("data-mode", mode);
    document.getElementById("show-login").setAttribute("aria-pressed", signup ? "false" : "true");
    document.getElementById("show-signup").setAttribute("aria-pressed", signup ? "true" : "false");
    document.getElementById("auth-submit").textContent = signup ? "Create account" : "Log in";
    document.getElementById("auth-passphrase").setAttribute("autocomplete", signup ? "new-password" : "current-password");
    showAuthError("");
  }

  function onAuthSubmit(event) {
    event.preventDefault();
    var username = document.getElementById("auth-username").value.trim();
    var passphrase = document.getElementById("auth-passphrase").value;
    var mode = document.getElementById("auth-form").getAttribute("data-mode") || "login";
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      showAuthError("Username should be 3 to 24 letters, numbers, or underscores.");
      return;
    }
    if (passphrase.length < 8) {
      showAuthError("Passphrase should be at least 8 characters.");
      return;
    }
    api(mode === "signup" ? "/api/signup" : "/api/login", {
      method: "POST",
      body: JSON.stringify({ username: username, passphrase: passphrase })
    })
      .then(function (me) {
        document.getElementById("auth-passphrase").value = "";
        state.category = "Harem";
        state.query = "";
        searchEl.value = "";
        return openShelf(me.username);
      })
      .catch(function (err) {
        showAuthError(err.message || "Could not sign in.");
      });
  }

  function onLogout() {
    api("/api/logout", { method: "POST" })
      .catch(function () {})
      .then(function () {
        state.items = [];
        state.username = "";
        state.category = "Harem";
        state.query = "";
        searchEl.value = "";
        showIdleOnline();
        showAuthError("");
      });
  }

  function offerImport() {
    var banner = document.getElementById("import-banner");
    if (!guestList() || localStorage.getItem(IMPORT_SKIP_KEY) === state.username) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
  }

  function guestList() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!Array.isArray(parsed) || !parsed.length) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function onImport() {
    var items = guestList();
    if (!items) return;
    api("/api/anime", { method: "PUT", body: JSON.stringify({ items: items }) })
      .then(function (data) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(IMPORT_SKIP_KEY);
        state.items = data.items;
        document.getElementById("import-banner").hidden = true;
        renderShelf();
        renderOnline();
      })
      .catch(function (err) {
        showError(err.message || "Could not import that shelf.");
      });
  }

  function applyList(data) {
    state.items = data.items || [];
    renderShelf();
    renderOnline();
  }

  function isFourDigitYear(year) {
    return Number.isInteger(year) && year >= 1910 && year <= 2035;
  }

  function onFilterClick(event) {
    var button = event.target.closest("button[data-category]");
    if (!button) return;
    state.category = button.getAttribute("data-category");
    renderShelf();
  }

  function onSearchInput() {
    state.query = searchEl.value;
    renderShelf();
    scheduleOnline(false);
  }

  function onAdd(event) {
    event.preventDefault();
    var title = document.getElementById("title").value.trim();
    var category = document.getElementById("category").value;
    var yearText = document.getElementById("year").value.trim();
    var note = document.getElementById("note").value.trim();

    if (!title) {
      showError("Title is required.");
      document.getElementById("title").focus();
      return;
    }
    if (CATEGORIES.indexOf(category) === -1) {
      showError("Choose a category.");
      return;
    }
    var year = null;
    if (yearText) {
      if (!/^\d{4}$/.test(yearText) || !isFourDigitYear(Number(yearText))) {
        showError("Year should be a four-digit year, like 2016.");
        document.getElementById("year").focus();
        return;
      }
      year = Number(yearText);
    }

    api("/api/anime", {
      method: "POST",
      body: JSON.stringify({ title: title, year: year, category: category, note: note })
    })
      .then(function (data) {
        state.category = category;
        state.query = "";
        searchEl.value = "";
        formEl.reset();
        showError("");
        showIdleOnline();
        applyList(data);
        var added = state.items[state.items.length - 1];
        var card = added && listEl.querySelector('[data-id="' + cssEscape(added.id) + '"]');
        if (card && card.scrollIntoView) card.scrollIntoView({ block: "nearest" });
      })
      .catch(function (err) {
        if (err.status === 401) showAuth();
        else showError(err.message || "Could not add that title.");
      });
  }

  function onReset() {
    api("/api/anime/reset", { method: "POST" })
      .then(function (data) {
        state.category = "Harem";
        state.query = "";
        searchEl.value = "";
        formEl.reset();
        showError("");
        applyList(data);
      })
      .catch(function (err) {
        if (err.status === 401) showAuth();
        else showError(err.message || "Could not reset the shelf.");
      });
  }

  function onListClick(event) {
    var button = event.target.closest("button[data-delete]");
    if (!button) return;
    var id = button.getAttribute("data-delete");
    api("/api/anime/" + encodeURIComponent(id), { method: "DELETE" })
      .then(applyList)
      .catch(function (err) {
        if (err.status === 401) showAuth();
        else showError(err.message || "Could not delete that title.");
      });
  }

  function renderShelf() {
    renderFilters();
    var visible = visibleItems();
    statusEl.textContent = statusText(visible.length);
    listEl.replaceChildren();
    if (!visible.length) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No titles match that filter.";
      listEl.appendChild(empty);
      return;
    }
    visible.forEach(function (item) {
      listEl.appendChild(renderCard(item));
    });
  }

  function renderFilters() {
    var counts = countByCategory();
    filtersEl.replaceChildren();
    [{ name: "All", count: state.items.length }]
      .concat(
        CATEGORIES.map(function (name) {
          return { name: name, count: counts[name] || 0 };
        })
      )
      .forEach(function (entry) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "filter";
        button.setAttribute("data-category", entry.name);
        button.setAttribute("aria-pressed", state.category === entry.name ? "true" : "false");
        var label = document.createElement("span");
        label.textContent = entry.name;
        var count = document.createElement("span");
        count.className = "filter-count";
        count.textContent = String(entry.count);
        button.append(label, count);
        filtersEl.appendChild(button);
      });
  }

  function renderCard(item) {
    var card = document.createElement("article");
    card.className = "card";
    card.setAttribute("data-id", item.id);

    if (item.poster) {
      card.classList.add("has-poster");
      card.appendChild(posterImage(item.poster));
    }

    var body = document.createElement("div");
    body.className = "card-body";

    var tag = document.createElement("p");
    tag.className = "tag";
    tag.textContent = item.category;

    var title = document.createElement("h3");
    title.textContent = item.title;

    body.append(tag, title);

    if (item.year) {
      var year = document.createElement("p");
      year.className = "year";
      year.textContent = String(item.year);
      body.appendChild(year);
    }

    if (item.note) {
      var note = document.createElement("p");
      note.className = "note";
      note.textContent = item.note;
      body.appendChild(note);
    }

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.setAttribute("data-delete", item.id);
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", "Delete " + item.title);
    body.appendChild(remove);
    card.appendChild(body);
    return card;
  }

  function posterImage(url) {
    var img = document.createElement("img");
    img.className = "poster";
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.src = url;
    img.addEventListener("error", function () {
      var card = img.closest(".card, .online-card, .spotlight-card");
      if (card) card.classList.remove("has-poster");
      img.remove();
    });
    return img;
  }

  function scheduleOnline(immediate) {
    if (onlineTimer) {
      clearTimeout(onlineTimer);
      onlineTimer = null;
    }
    state.query = searchEl.value;
    var query = state.query.trim();
    if (isHaremQuery(query)) {
      state.category = "Harem";
      renderShelf();
      startHaremBrowse();
      return;
    }
    if (query.length < 2) {
      if (immediate && query.length > 0) {
        abortOnline();
        onlineState = { phase: "short", query: query, results: [] };
        renderOnline();
        return;
      }
      showIdleOnline();
      return;
    }
    if (immediate) {
      startTitleSearch(query);
      return;
    }
    onlineTimer = setTimeout(function () {
      onlineTimer = null;
      if (state.query.trim() === query) startTitleSearch(query);
    }, 600);
  }

  function showIdleOnline() {
    abortOnline();
    onlineState = { phase: "idle", query: "", results: [], mode: "search", page: 0, hasMore: false, total: 0, loadingMore: false };
    renderOnline();
  }

  function onBrowseHarem() {
    searchEl.value = "Harem";
    state.query = "Harem";
    state.category = "Harem";
    renderShelf();
    startCatalog("harem", "Harem");
    var section = document.getElementById("online");
    if (section && section.scrollIntoView) section.scrollIntoView({ block: "start" });
  }

  function onBrowseRomance() {
    searchEl.value = "";
    state.query = "";
    state.category = "All";
    renderShelf();
    startCatalog("romance", "");
    var section = document.getElementById("online");
    if (section && section.scrollIntoView) section.scrollIntoView({ block: "start" });
  }

  function startHaremBrowse() {
    startCatalog("harem", "Harem");
  }

  function startTitleSearch(query) {
    startCatalog("search", query);
  }

  function catalogPageUrl(page) {
    var limit = 100;
    if (onlineState.mode === "harem") return "/api/harem?page=" + page + "&limit=" + limit;
    if (onlineState.mode === "romance") return "/api/romance?page=" + page + "&limit=" + limit;
    return "/api/catalog/search?q=" + encodeURIComponent(onlineState.query) + "&page=" + page + "&limit=" + limit;
  }

  function startCatalog(mode, query) {
    abortOnline();
    onlineState = {
      phase: "loading",
      query: query,
      results: [],
      mode: mode,
      page: 0,
      hasMore: false,
      total: 0,
      loadingMore: true
    };
    renderOnline();
    api(catalogPageUrl(1))
      .then(function (data) {
        if (onlineState.mode !== mode) return;
        onlineState.phase = data.items && data.items.length ? "results" : "empty";
        onlineState.results = data.items || [];
        onlineState.page = data.page || 1;
        onlineState.hasMore = !!data.hasMore;
        onlineState.total = data.total || onlineState.results.length;
        onlineState.loadingMore = false;
        renderOnline();
      })
      .catch(function () {
        if (onlineState.mode !== mode) return;
        onlineState.phase = "error";
        onlineState.loadingMore = false;
        onlineState.results = [];
        renderOnline();
      });
  }

  function loadMoreHarem() {
    if (!onlineState.hasMore || onlineState.loadingMore) return;
    if (onlineState.mode !== "harem" && onlineState.mode !== "romance" && onlineState.mode !== "search") return;
    var mode = onlineState.mode;
    onlineState.loadingMore = true;
    var button = document.getElementById("load-more");
    button.textContent = "Loading…";
    var next = onlineState.page + 1;
    api(catalogPageUrl(next))
      .then(function (data) {
        if (onlineState.mode !== mode) return;
        var start = onlineState.results.length;
        var items = data.items || [];
        onlineState.results = onlineState.results.concat(items);
        onlineState.page = data.page || next;
        onlineState.hasMore = !!data.hasMore;
        onlineState.total = data.total || onlineState.total;
        onlineState.loadingMore = false;
        items.forEach(function (item, index) {
          onlineResultsEl.appendChild(renderOnlineCard(item, start + index));
        });
        updateCatalogChrome();
      })
      .catch(function () {
        onlineState.loadingMore = false;
        button.textContent = "Load 100 more";
      });
  }

  function loadSpotlight() {
    api("/api/harem/spotlight")
      .then(function (data) {
        spotlightItem = data.item;
        renderSpotlight(data.week, data.item);
      })
      .catch(function () {
        document.getElementById("spotlight").hidden = true;
      });
  }

  function renderSpotlight(week, item) {
    var root = document.getElementById("spotlight");
    root.hidden = false;
    root.replaceChildren();
    var card = document.createElement("article");
    card.className = "spotlight-card";
    if (item.poster) card.appendChild(posterImage(item.poster));
    var body = document.createElement("div");
    var kicker = document.createElement("p");
    kicker.className = "spotlight-kicker";
    kicker.textContent = "Best harem of the week";
    var title = document.createElement("h2");
    title.textContent = item.title;
    if (item.harem) title.appendChild(haremBadge());
    if (item.ecchi) title.appendChild(ecchiBadge());
    var meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = metaLine(item);
    var synopsis = document.createElement("p");
    synopsis.className = "synopsis";
    synopsis.textContent = item.synopsis || "No synopsis yet.";
    var row = document.createElement("div");
    row.className = "add-row";
    var saved = alreadySaved(item);
    var add = document.createElement("button");
    add.type = "button";
    add.id = "spotlight-add";
    add.textContent = saved ? "On your shelf" : "Add to my list";
    add.disabled = saved;
    row.appendChild(add);
    body.append(kicker, title, meta, synopsis, row);
    card.appendChild(body);
    root.appendChild(card);
  }

  function onSpotlightAdd(event) {
    var button = event.target.closest("#spotlight-add");
    if (!button || button.disabled || !spotlightItem || alreadySaved(spotlightItem)) return;
    api("/api/anime", {
      method: "POST",
      body: JSON.stringify({
        id: "mal-" + spotlightItem.malId,
        malId: spotlightItem.malId,
        title: spotlightItem.title,
        year: spotlightItem.year,
        category: "Harem",
        note: spotlightItem.synopsis || "",
        poster: spotlightItem.poster
      })
    })
      .then(function (data) {
        applyList(data);
        renderSpotlight(isoWeekNow(), spotlightItem);
      })
      .catch(function (err) {
        if (err.status === 401) showAuth();
        else showError(err.message || "Could not add that title.");
      });
  }

  function isoWeekNow() {
    var date = new Date();
    var d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    var day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  }

  function ecchiBadge() {
    var badge = document.createElement("span");
    badge.className = "badge-ecchi";
    badge.textContent = "Ecchi";
    return badge;
  }

  function haremBadge() {
    var badge = document.createElement("span");
    badge.className = "badge-harem";
    badge.textContent = "Harem";
    return badge;
  }

  function catalogLabel() {
    if (onlineState.mode === "harem") return "harem titles";
    if (onlineState.mode === "romance") return "romance titles";
    return "matches";
  }

  function updateCatalogChrome() {
    document.getElementById("online-heading").textContent =
      onlineState.mode === "harem" ? "Every harem anime" : onlineState.mode === "romance" ? "Every romance anime" : "Search";
    onlineStatusEl.textContent =
      "Showing " + onlineState.results.length + " of " + onlineState.total + " " + catalogLabel() + ", best to worst.";
    var button = document.getElementById("load-more");
    button.hidden = !onlineState.hasMore;
    button.textContent = "Load 100 more";
  }

  function abortOnline() {
    if (onlineAbort) {
      onlineAbort.abort();
      onlineAbort = null;
    }
  }

  function runOnline(query) {
    abortOnline();
    var controller = new AbortController();
    onlineAbort = controller;
    onlineState = { phase: "loading", query: query, results: [] };
    renderOnline();
    var params = "q=" + encodeURIComponent(query) + "&limit=10&sfw=true";
    var hosts = skipJikan ? [TENRAI_URL] : [JIKAN_URL, TENRAI_URL];
    attempt(0);

    function attempt(index) {
      if (controller.signal.aborted) return;
      if (index >= hosts.length) {
        finish("error", []);
        return;
      }
      var host = hosts[index];
      var timeoutMs = host === JIKAN_URL ? 4000 : 12000;
      fetchJson(host + "?" + params, controller.signal, timeoutMs)
        .then(function (response) {
          if (controller.signal.aborted) return null;
          if (response.status === 429) {
            finish("limited", []);
            return null;
          }
          if (!response.ok) {
            if (host === JIKAN_URL) {
              skipJikan = true;
              attempt(index + 1);
              return null;
            }
            finish("error", []);
            return null;
          }
          return response.json();
        })
        .then(function (payload) {
          if (!payload || controller.signal.aborted) return;
          var results = normalizeResults(payload);
          finish(results.length ? "results" : "empty", results);
        })
        .catch(function () {
          if (controller.signal.aborted) return;
          if (host === JIKAN_URL) {
            skipJikan = true;
            attempt(index + 1);
            return;
          }
          finish("error", []);
        });
    }

    function finish(phase, results) {
      if (controller.signal.aborted) return;
      onlineState = { phase: phase, query: query, results: results };
      renderOnline();
    }
  }

  function fetchJson(url, userSignal, timeoutMs) {
    var controller = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    var onUserAbort = function () {
      controller.abort();
    };
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener("abort", onUserAbort);
    return fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    }).then(
      function (response) {
        clearTimeout(timer);
        userSignal.removeEventListener("abort", onUserAbort);
        return response;
      },
      function (err) {
        clearTimeout(timer);
        userSignal.removeEventListener("abort", onUserAbort);
        if (timedOut && !userSignal.aborted) err.timedOut = true;
        throw err;
      }
    );
  }

  function normalizeResults(payload) {
    var rows = payload && Array.isArray(payload.data) ? payload.data : [];
    return rows.map(normalizeAnime).filter(Boolean);
  }

  function normalizeAnime(anime) {
    if (!anime || typeof anime !== "object") return null;
    var title = textValue(anime.title_english) || textValue(anime.title);
    if (!title) return null;
    var year = null;
    if (isFourDigitYear(Number(anime.year))) year = Number(anime.year);
    else {
      var from = anime.aired && anime.aired.prop && anime.aired.prop.from;
      if (from && isFourDigitYear(Number(from.year))) year = Number(from.year);
    }
    var images = anime.images && (anime.images.jpg || anime.images.webp);
    var poster = images
      ? safePoster(images.image_url || images.large_image_url || images.small_image_url)
      : null;
    return {
      malId: cleanMalId(anime.mal_id),
      title: title.slice(0, 180),
      year: year,
      type: textValue(anime.type) || "Anime",
      score: typeof anime.score === "number" && isFinite(anime.score) ? anime.score : null,
      synopsis: shortSynopsis(anime.synopsis),
      poster: poster
    };
  }

  function renderOnline() {
    var query = onlineState.query;
    var heading = document.getElementById("online-heading");
    var more = document.getElementById("load-more");
    heading.textContent =
      onlineState.mode === "harem" ? "Every harem anime" : onlineState.mode === "romance" ? "Every romance anime" : "Search";
    if ((onlineState.mode === "harem" || onlineState.mode === "romance" || onlineState.mode === "search") && onlineState.phase === "loading") {
      onlineStatusEl.textContent = onlineState.mode === "harem"
        ? "Loading every harem title, best to worst\u2026"
        : onlineState.mode === "romance"
          ? "Loading every romance title, best to worst\u2026"
          : "Searching the romance catalog\u2026";
    } else if ((onlineState.mode === "harem" || onlineState.mode === "romance" || onlineState.mode === "search") && onlineState.phase === "results") {
      updateCatalogChrome();
    } else if (onlineState.mode === "harem" && onlineState.phase === "empty") {
      onlineStatusEl.textContent = "No harem titles came back.";
    } else if (onlineState.mode === "romance" && onlineState.phase === "empty") {
      onlineStatusEl.textContent = "No romance titles came back.";
    } else if (onlineState.phase === "loading") {
      onlineStatusEl.textContent = "Looking up \u201c" + query + "\u201d\u2026";
    } else if (onlineState.phase === "empty") {
      onlineStatusEl.textContent = "No titles found online for \u201c" + query + "\u201d.";
    } else if (onlineState.phase === "limited") {
      onlineStatusEl.textContent = "The anime search is busy right now. Wait a moment, then try again.";
    } else if (onlineState.phase === "error") {
      onlineStatusEl.textContent = "Couldn\u2019t reach the anime search. Check your connection and try again.";
    } else if (onlineState.phase === "short") {
      onlineStatusEl.textContent = "Type at least 2 letters to search online.";
    } else if (onlineState.phase === "results") {
      var count = onlineState.results.length;
      onlineStatusEl.textContent =
        count + " online " + (count === 1 ? "result" : "results") + " for \u201c" + query + "\u201d.";
    } else {
      onlineStatusEl.textContent =
        "Browse all harem, or search a title on MyAnimeList. The shelf below is your list.";
    }

    more.hidden = !((onlineState.mode === "harem" || onlineState.mode === "romance" || onlineState.mode === "search") && onlineState.phase === "results" && onlineState.hasMore);
    onlineResultsEl.replaceChildren();
    if (onlineState.phase !== "results") return;
    onlineState.results.forEach(function (result, index) {
      onlineResultsEl.appendChild(renderOnlineCard(result, index));
    });
  }

  function renderOnlineCard(result, index) {
    var card = document.createElement("article");
    card.className = "online-card";
    if (result.poster) card.appendChild(posterImage(result.poster));

    var body = document.createElement("div");
    var title = document.createElement("h3");
    title.textContent = result.title;
    if (result.harem) title.appendChild(haremBadge());
    if (result.ecchi) title.appendChild(ecchiBadge());

    var meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = metaLine(result);

    var synopsis = document.createElement("p");
    synopsis.className = "synopsis";
    synopsis.textContent = shortSynopsis(result.synopsis);

    var row = document.createElement("div");
    row.className = "add-row";
    var saved = alreadySaved(result);
    var label = document.createElement("label");
    label.appendChild(document.createTextNode("Add to"));
    var select = document.createElement("select");
    select.setAttribute("aria-label", "Add " + result.title + " to");
    CATEGORIES.forEach(function (category) {
      var option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      if (category === preferredCategory(result)) option.selected = true;
      select.appendChild(option);
    });
    if (saved) select.disabled = true;
    label.appendChild(select);

    var add = document.createElement("button");
    add.type = "button";
    add.setAttribute("data-add-online", String(index));
    add.textContent = saved ? "On your shelf" : "Add";
    add.disabled = saved;
    row.append(label, add);
    body.append(title, meta, synopsis, row);
    card.appendChild(body);
    return card;
  }

  function onOnlineAdd(event) {
    var button = event.target.closest("button[data-add-online]");
    if (!button || button.disabled) return;
    var index = Number(button.getAttribute("data-add-online"));
    var result = onlineState.results[index];
    if (!result || alreadySaved(result)) return;
    var card = button.closest(".online-card");
    var select = card ? card.querySelector("select") : null;
    var category = select ? select.value : CATEGORIES[0];
    if (CATEGORIES.indexOf(category) === -1) return;
    api("/api/anime", {
      method: "POST",
      body: JSON.stringify({
        id: result.malId ? "mal-" + result.malId : createId(),
        malId: result.malId,
        title: result.title,
        year: result.year,
        category: category,
        note: result.synopsis === "No synopsis yet." ? "" : result.synopsis,
        poster: result.poster
      })
    })
      .then(applyList)
      .catch(function (err) {
        if (err.status === 401) showAuth();
        else showError(err.message || "Could not add that title.");
      });
  }

  function preferredCategory(result) {
    if (result.harem || onlineState.mode === "harem") return "Harem";
    if (result.type === "Movie") return "Movies";
    return "Slice of Life";
  }

  function alreadySaved(result) {
    var title = result.title.toLowerCase();
    return state.items.some(function (item) {
      if (result.malId && item.malId === result.malId) return true;
      return item.title.toLowerCase() === title;
    });
  }

  function metaLine(result) {
    var bits = [];
    if (result.score != null) bits.push("Score " + formatScore(result.score));
    else if (result.malId) bits.push("No score");
    if (result.type) bits.push(result.type);
    if (result.year) bits.push(String(result.year));
    if (result.episodes) bits.push(result.episodes + (result.episodes === 1 ? " episode" : " episodes"));
    return bits.join(" \u00b7 ");
  }

  function formatScore(score) {
    return (Math.round(score * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  }

  function shortSynopsis(text) {
    var clean = textValue(text).replace(/\s+/g, " ");
    clean = clean.replace(/\s*\[Written by MAL Rewrite\]\s*$/i, "");
    if (!clean) return "No synopsis yet.";
    if (clean.length <= 180) return clean;
    var cut = clean.slice(0, 180);
    var space = cut.lastIndexOf(" ");
    if (space > 120) cut = cut.slice(0, space);
    return cut + "\u2026";
  }

  function textValue(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function safePoster(url) {
    if (typeof url !== "string" || !url || url.length > 500) return null;
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      return parsed.href;
    } catch (err) {
      return null;
    }
  }

  function cleanMalId(value) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) {
      var parsed = Number(value);
      if (parsed > 0) return parsed;
    }
    return null;
  }

  function isHaremQuery(query) {
    return query.trim().toLowerCase() === "harem";
  }

  function visibleItems() {
    var query = state.query.trim().toLowerCase();
    var browsing = isHaremQuery(query);
    return state.items.filter(function (item) {
      if (state.category !== "All" && item.category !== state.category) return false;
      if (!query || browsing) return true;
      var haystack = [item.title, item.year ? String(item.year) : "", item.note]
        .join(" ")
        .toLowerCase();
      return haystack.indexOf(query) !== -1;
    });
  }

  function countByCategory() {
    return state.items.reduce(function (counts, item) {
      counts[item.category] = (counts[item.category] || 0) + 1;
      return counts;
    }, {});
  }

  function statusText(count) {
    var noun = count === 1 ? "title" : "titles";
    var searching = state.query.trim().length > 0;
    if (!searching && state.category === "All") return "Showing all " + count + " " + noun + ".";
    if (!searching) return "Showing " + count + " " + state.category + " " + noun + ".";
    if (state.category === "All") return "Showing " + count + " " + noun + ".";
    return "Showing " + count + " " + state.category + " " + noun + ".";
  }

  function showError(message) {
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function createId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "title-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }
})();
