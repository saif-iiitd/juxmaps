/* JuxMaps — application logic.
   Depends on Leaflet (assets/vendor/leaflet) and JUX_CITIES / JUX_BASEMAPS
   from assets/js/catalogue.js. No build step; plain script, no modules. */
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var el = function (tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  var TRANSPARENT_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  var state = {
    city: null,
    overlay: null,     // active overlay object, or null
    mode: "fade",      // 'fade' | 'swipe'
    opacity: 0.75,
    basemap: "carto-voyager",
    anchorsOn: true,
    splitFrac: 0.5,    // swipe divider, 0..1 of map width
    baseLayer: null,
    histLayer: null,
    anchorGroup: null,
    userOverlays: {}   // cityId -> [overlay, ...] added this session via "Add a map"
  };

  var map, shell, dock, curtain, loadingEl, toastEl;

  /* Leaflet's bottom-corner controls are positioned above the dock, whose
     height changes with content and viewport. Keep the CSS variable current. */
  function syncDockH() {
    if (shell && dock) shell.style.setProperty("--dock-h", dock.offsetHeight + "px");
  }

  /* ------------------------------------------------------------------ util */

  function cityById(id) {
    for (var i = 0; i < JUX_CITIES.length; i++) if (JUX_CITIES[i].id === id) return JUX_CITIES[i];
    return null;
  }
  function overlayById(city, id) {
    for (var i = 0; i < city.overlays.length; i++) if (city.overlays[i].id === id) return city.overlays[i];
    return null;
  }
  /* Same lookup, but also checks maps a reader added this session. */
  function findOverlay(city, id) {
    var o = overlayById(city, id);
    if (o) return o;
    var user = state.userOverlays[city.id] || [];
    for (var i = 0; i < user.length; i++) if (user[i].id === id) return user[i];
    return null;
  }
  function mergedOverlays(city) {
    var all = city.overlays.concat(state.userOverlays[city.id] || []);
    all.sort(function (a, b) {
      return (a.year == null ? 9999 : a.year) - (b.year == null ? 9999 : b.year);
    });
    return all;
  }
  /* Catalogue overlays don't carry an "mw:"/"wm:" prefix on their id — only
     reader-added ones do — so identifying "is this the same map?" across
     both needs the archive read off the tile URL instead of the id string. */
  function archiveKeyForOverlay(ov) {
    if (ov.archiveKey) return ov.archiveKey;
    if (/mapwarper\.net/.test(ov.tiles)) return "mw";
    if (/warper\.wmflabs\.org/.test(ov.tiles)) return "wm";
    return null;
  }
  function bareIdForOverlay(ov) {
    var i = ov.id.indexOf(":");
    return i === -1 ? ov.id : ov.id.slice(i + 1);
  }
  /* Finds an existing overlay (curated or reader-added) for this city that
     is the same archive record as (archiveKey, id) — regardless of which id
     form it's stored under — so "add" never creates a duplicate of a map
     that's already in the curated gallery. */
  function findSameRecord(city, archiveKey, id) {
    var match = null;
    mergedOverlays(city).some(function (o) {
      if (archiveKeyForOverlay(o) === archiveKey && bareIdForOverlay(o) === id) { match = o; return true; }
      return false;
    });
    return match;
  }
  function basemapById(id) {
    for (var i = 0; i < JUX_BASEMAPS.length; i++) if (JUX_BASEMAPS[i].id === id) return JUX_BASEMAPS[i];
    return JUX_BASEMAPS[0];
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("on"); }, 2600);
  }
  function lonToTileX(lon, z) { return Math.floor(((lon + 180) / 360) * Math.pow(2, z)); }
  function latToTileY(lat, z) {
    var r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
  }
  /* Card previews are built from the warped map's own tiles: Map Warper only
     publishes a 100px archive thumbnail, which is far too small for a card.
     Pick the zoom at which the sheet spans about 1.4 tiles, then take the 2x2
     block around its centre — that frames the whole sheet, sharp. */
  function tileMosaic(ov) {
    var lonSpan = Math.abs(ov.bounds[1][1] - ov.bounds[0][1]);
    var z = Math.round(Math.log2((360 * 1.4) / Math.max(lonSpan, 1e-6)));
    z = Math.max(11, Math.min(ov.maxNativeZoom, z));
    var n = Math.pow(2, z);
    var cx = ((ov.center[1] + 180) / 360) * n;
    var rad = (ov.center[0] * Math.PI) / 180;
    var cy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    var x0 = Math.floor(cx - 0.5), y0 = Math.floor(cy - 0.5);
    var urls = [];
    for (var dy = 0; dy < 2; dy++) {
      for (var dx = 0; dx < 2; dx++) {
        urls.push(ov.tiles.replace("{z}", z).replace("{x}", x0 + dx).replace("{y}", y0 + dy));
      }
    }
    return urls;
  }

  /* --------------------------------------------------------- user-added maps
     "Add a map" lets a reader paste a link to a record already georeferenced
     on Map Warper or Wikimaps Warper. Nothing is uploaded: the app calls that
     record's public API, confirms it actually serves tiles — a meaningful
     share of "warped" records on these archives serve none, as documented in
     README.md — and adds it to this browsing session. Session-only by
     design: reload the page and it's gone, unless the URL still names it
     (#city/mw:12345), in which case it's fetched fresh on load. */

  var ARCHIVES = {
    mw: { label: "Map Warper", api: "https://mapwarper.net/api/v1/maps/",
          tileBase: "https://mapwarper.net/maps/tile/", pageBase: "https://mapwarper.net/maps/",
          host: "mapwarper.net" },
    wm: { label: "Wikimaps Warper", api: "https://warper.wmflabs.org/api/v1/maps/",
          tileBase: "https://warper.wmflabs.org/maps/tile/", pageBase: "https://warper.wmflabs.org/maps/",
          host: "warper.wmflabs.org" }
  };

  function parseMapInput(raw, fallbackArchive) {
    raw = (raw || "").trim();
    var m = /^(mw|wm):(\d+)$/.exec(raw);
    if (m) return { archive: m[1], id: m[2] };
    if (/^\d+$/.test(raw)) return { archive: fallbackArchive, id: raw };
    var u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); }
    catch (e) { return null; }
    var idm = /\/maps\/(\d+)/.exec(u.pathname);
    if (!idm) return null;
    if (/(^|\.)mapwarper\.net$/i.test(u.hostname)) return { archive: "mw", id: idm[1] };
    if (/(^|\.)warper\.wmflabs\.org$/i.test(u.hostname)) return { archive: "wm", id: idm[1] };
    return null;
  }

  function parseYear(dateStr) {
    var m = /(1[3-9]\d\d|20[0-2]\d)/.exec(dateStr || "");
    return m ? parseInt(m[1], 10) : null;
  }

  function absUrl(host, path) {
    return /^https?:\/\//i.test(path) ? path : "https://" + host + path;
  }

  function approxKm(a, b) {
    var dLat = (a[0] - b[0]) * 111;
    var dLon = (a[1] - b[1]) * 111 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  function probeTile(template, center, z) {
    return new Promise(function (resolve) {
      var n = Math.pow(2, z);
      var x = Math.floor(((center[1] + 180) / 360) * n);
      var rad = (center[0] * Math.PI) / 180;
      var y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
      var url = template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
      var im = new Image();
      var done = false;
      function finish(ok) { if (!done) { done = true; resolve(ok); } }
      im.onload = function () { finish(im.naturalWidth > 0); };
      im.onerror = function () { finish(false); };
      setTimeout(function () { finish(false); }, 9000);
      im.src = url;
    });
  }

  /* Looks up a record, then proves it serves real tiles before we ever show
     it — see the comment above. statusCb reports progress to the UI. */
  async function fetchAndVerifyMap(archiveKey, id, statusCb) {
    var arc = ARCHIVES[archiveKey];
    if (!arc) throw new Error("Unknown archive.");
    statusCb("Looking up record #" + id + " on " + arc.label + "…");

    var res;
    try {
      res = await fetch(arc.api + id, { mode: "cors" });
    } catch (e) {
      throw new Error("Couldn’t reach " + arc.label + ". Check your connection and try again.");
    }
    if (res.status === 404) throw new Error("No record #" + id + " found on " + arc.label + ".");
    if (!res.ok) throw new Error(arc.label + " returned an error (status " + res.status + ").");

    var json;
    try { json = await res.json(); }
    catch (e) { throw new Error("Unexpected response from " + arc.label + "."); }

    var a = (json.data && json.data.attributes) || {};
    if (a.status !== "warped") {
      throw new Error("This record hasn’t finished being georeferenced on " + arc.label +
        " (status: " + (a.status || "unknown") + "). It can’t be placed on a modern map until that’s done there.");
    }
    var bbox = (a.bbox || "").split(",").map(Number);
    if (bbox.length !== 4 || bbox.some(function (v) { return isNaN(v); })) {
      throw new Error("This record has no usable coordinates yet.");
    }
    var w = bbox[0], s = bbox[1], e = bbox[2], n = bbox[3];
    var center = [(s + n) / 2, (w + e) / 2];
    var px = [a.width || 0, a.height || 0];
    var nativeZoom = 17;
    if (px[0] > 0 && (e - w) > 0) {
      nativeZoom = Math.round(Math.log2((px[0] * 360) / ((e - w) * 256)));
    }
    nativeZoom = Math.max(9, Math.min(19, nativeZoom));
    var tiles = arc.tileBase + id + "/{z}/{x}/{y}.png";

    statusCb("Checking that " + arc.label + " is serving tiles for this map…");
    var probeZooms = [Math.min(nativeZoom, 15), 12, nativeZoom];
    var verified = false;
    for (var i = 0; i < probeZooms.length; i++) {
      if (await probeTile(tiles, center, probeZooms[i])) { verified = true; break; }
    }
    if (!verified) {
      throw new Error("This record exists on " + arc.label + " but isn’t serving map tiles right now " +
        "(this happens to a real share of records there). Open it on " + arc.label + " to check, or try again later.");
    }

    var links = json.data.links || {};
    return {
      id: archiveKey + ":" + id, archiveKey: archiveKey, archive: arc.label,
      year: parseYear(a.date_depicted), label: a.date_depicted || "undated", dated: !!a.date_depicted,
      title: a.title || ("Record #" + id), by: "Added by you · " + arc.label,
      recordTitle: a.title || "", note: (a.description || "").replace(/\s+/g, " ").trim().slice(0, 160),
      tiles: tiles, page: arc.pageBase + id,
      thumb: links.thumb ? absUrl(arc.host, links.thumb) : "",
      bounds: [[s, w], [n, e]], center: center, maxNativeZoom: nativeZoom, px: px,
      userAdded: true
    };
  }

  /* ------------------------------------------------------------------ theme */

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem("jux-theme"); } catch (e) {}
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    $("#themeBtn").addEventListener("click", function () {
      var now = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", now);
      try { localStorage.setItem("jux-theme", now); } catch (e) {}
    });
  }

  /* ------------------------------------------------------------------ chrome */

  function initNav() {
    var nav = $("#nav");
    $("#burger").addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $$("#nav a").forEach(function (a) {
      a.addEventListener("click", function () {
        nav.classList.remove("open");
        $("#burger").setAttribute("aria-expanded", "false");
      });
    });
  }

  function buildCityRail() {
    var rail = $("#cityRail");
    rail.innerHTML = "";
    JUX_CITIES.forEach(function (c) {
      var b = el("button", "jm-city");
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      b.dataset.city = c.id;
      var span = c.country ? c.country + " · " + c.overlays.length + " maps"
                           : c.overlays.length + " maps";
      b.innerHTML = "<b>" + esc(c.name) + "</b><span>" + esc(span) + "</span>";
      b.addEventListener("click", function () { selectCity(c.id, true); });
      rail.appendChild(b);
    });
  }

  /* ------------------------------------------------------------------ map */

  function initMap() {
    shell = $("#mapShell");
    dock = $("#dock");
    curtain = $("#curtain");
    loadingEl = $("#loading");

    map = L.map("map", {
      zoomControl: false,
      minZoom: 3,
      maxZoom: 19,
      worldCopyJump: true
    });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ position: "bottomleft", imperial: true, metric: true }).addTo(map);

    map.createPane("hist");
    map.getPane("hist").style.zIndex = 450;

    setBasemap(state.basemap);

    map.on("move zoom viewreset zoomend resize", applyClip);
    map.on("moveend zoomend", updateCoords);

    // keep Leaflet's bottom controls clear of the overlay dock
    syncDockH();
    window.addEventListener("resize", syncDockH);
    if (window.ResizeObserver) {
      new ResizeObserver(syncDockH).observe(dock);
      // If the map is laid out while hidden (zero width), Leaflet caches a bad
      // size and the swipe clip collapses. Recover as soon as it gains size.
      new ResizeObserver(function () {
        if (!map) return;
        syncDockH();
        var w = map.getContainer().clientWidth;
        if (w && w !== map.getSize().x) {
          map.invalidateSize({ animate: false });
          positionCurtain();
          applyClip();
        }
      }).observe($("#map"));
    }

    initCurtain();
    initMapButtons();
  }

  function setBasemap(id) {
    state.basemap = id;
    var bm = basemapById(id);
    if (state.baseLayer) { map.removeLayer(state.baseLayer); state.baseLayer = null; }
    if (bm.url) {
      var opts = { attribution: bm.attribution, maxZoom: 19, maxNativeZoom: bm.maxZoom, detectRetina: true };
      if (bm.subdomains) opts.subdomains = bm.subdomains;
      state.baseLayer = L.tileLayer(bm.url, opts).addTo(map);
      state.baseLayer.setZIndex(1);
    }
    var sel = $("#basemapSel");
    if (sel.value !== id) sel.value = id;
  }

  function updateCoords() {
    if (!map) return;
    var c = map.getCenter();
    $("#coords").textContent =
      c.lat.toFixed(4) + ", " + c.lng.toFixed(4) + "  ·  z" + map.getZoom();
  }

  /* ------------------------------------------------- historical overlay */

  function setOverlay(ov, fly) {
    if (state.histLayer) { map.removeLayer(state.histLayer); state.histLayer = null; }
    state.overlay = ov || null;

    if (!ov) {
      updateDock();
      updateGallerySelection();
      syncHash();
      return;
    }

    var bounds = L.latLngBounds(ov.bounds);
    state.histLayer = L.tileLayer(ov.tiles, {
      pane: "hist",
      opacity: state.mode === "swipe" ? 1 : state.opacity,
      bounds: bounds,
      maxNativeZoom: ov.maxNativeZoom,
      maxZoom: 19,
      minZoom: 10,
      errorTileUrl: TRANSPARENT_PNG,
      attribution: 'Historical overlay: <a href="' + ov.page + '" target="_blank" rel="noopener">' +
        esc(ov.archive) + " #" + esc(bareIdForOverlay(ov)) + "</a>",
      className: "jm-histpane"
    });

    state.histLayer.on("loading", function () { loadingEl.classList.add("on"); });
    state.histLayer.on("load", function () { loadingEl.classList.remove("on"); });
    state.histLayer.addTo(map);

    if (fly) {
      // Only reframe when the current view does not already see the sheet.
      if (!map.getBounds().intersects(bounds)) {
        map.fitBounds(bounds, { padding: [24, 24] });
      }
    }
    applyClip();
    updateDock();
    updateGallerySelection();
    updateAnchorValidity();
    syncHash();
  }

  function updateDock() {
    var ov = state.overlay;
    var idEl = $("#dockId");
    if (!ov) {
      idEl.innerHTML = "<b>No old map selected</b><span>Pick a sheet from the gallery below</span>";
    } else {
      idEl.innerHTML =
        "<b><span class='jm-year'>" + esc(ov.label) + "</span>" + esc(ov.title) + "</b>" +
        "<span>" + esc(ov.by) + "</span>";
    }
    $("#opacityRange").disabled = !ov;
    $$(".jm-mode").forEach(function (b) { b.disabled = !ov; });
    syncDockH();
  }

  function setMode(mode) {
    state.mode = mode;
    shell.dataset.mode = mode;
    $$(".jm-mode").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.mode === mode ? "true" : "false");
    });
    if (state.histLayer) {
      state.histLayer.setOpacity(mode === "swipe" ? 1 : state.opacity);
    }
    if (mode === "swipe") positionCurtain();
    applyClip();
  }

  function setOpacity(v) {
    state.opacity = v;
    $("#opacityPct").textContent = Math.round(v * 100) + "%";
    var r = $("#opacityRange");
    r.style.setProperty("--p", Math.round(v * 100) + "%");
    if (state.histLayer && state.mode === "fade") state.histLayer.setOpacity(v);
  }

  /* --------------------------------------------------------- swipe curtain */

  function positionCurtain() {
    var w = shell.clientWidth;
    curtain.style.left = Math.round(state.splitFrac * w) + "px";
    curtain.setAttribute("aria-valuenow", Math.round(state.splitFrac * 100));
  }

  /* Clip the historical tile container in *layer* pixel space, which is the
     coordinate system the tile container itself is laid out in. */
  function applyClip() {
    if (!state.histLayer) return;
    var c = state.histLayer.getContainer();
    if (!c) return;
    if (state.mode !== "swipe") { c.style.clipPath = ""; return; }

    var size = map.getSize();
    if (!size.x || !size.y) { c.style.clipPath = ""; return; }
    var nw = map.containerPointToLayerPoint([0, 0]);
    var se = map.containerPointToLayerPoint([size.x, size.y]);
    var x = map.containerPointToLayerPoint([state.splitFrac * size.x, 0]).x;
    var t = nw.y - 2, b = se.y + 2, l = nw.x - 2;
    c.style.clipPath =
      "polygon(" + l + "px " + t + "px," + x + "px " + t + "px," +
      x + "px " + b + "px," + l + "px " + b + "px)";
  }

  function initCurtain() {
    var dragging = false;

    function moveTo(clientX) {
      var r = shell.getBoundingClientRect();
      var f = (clientX - r.left) / r.width;
      state.splitFrac = Math.max(0.02, Math.min(0.98, f));
      positionCurtain();
      applyClip();
    }

    curtain.addEventListener("pointerdown", function (e) {
      dragging = true;
      curtain.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    curtain.addEventListener("pointermove", function (e) {
      if (dragging) { moveTo(e.clientX); e.preventDefault(); }
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      try { curtain.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    curtain.addEventListener("pointerup", end);
    curtain.addEventListener("pointercancel", end);

    curtain.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === "ArrowLeft") { state.splitFrac = Math.max(0.02, state.splitFrac - step); }
      else if (e.key === "ArrowRight") { state.splitFrac = Math.min(0.98, state.splitFrac + step); }
      else return;
      e.preventDefault();
      positionCurtain();
      applyClip();
    });

    window.addEventListener("resize", function () { positionCurtain(); applyClip(); });
  }

  /* ------------------------------------------------------------- anchors */

  function buildAnchors(city) {
    if (state.anchorGroup) { map.removeLayer(state.anchorGroup); state.anchorGroup = null; }
    state.anchorGroup = L.layerGroup();

    city.anchors.forEach(function (a) {
      var icon = L.divIcon({
        className: "jm-amark k-" + a.kind,
        html: "<i></i>",
        iconSize: [13, 13],
        iconAnchor: [6.5, 6.5]
      });
      var m = L.marker([a.lat, a.lon], { icon: icon, title: a.name, keyboard: true });
      m.bindPopup(anchorPopup(a));
      m._jux = a;
      state.anchorGroup.addLayer(m);
    });

    if (state.anchorsOn) state.anchorGroup.addTo(map);

    var list = $("#anchorList");
    list.innerHTML = "";
    city.anchors.forEach(function (a) {
      var b = el("button", "jm-anchor k-" + a.kind);
      b.type = "button";
      b.innerHTML = "<i></i>" + esc(a.name);
      b.addEventListener("click", function () {
        if (!state.anchorsOn) toggleAnchors(true);
        map.flyTo([a.lat, a.lon], Math.max(map.getZoom(), 16), { duration: 0.7 });
        state.anchorGroup.eachLayer(function (m) {
          if (m._jux === a) setTimeout(function () { m.openPopup(); }, 720);
        });
        $("#mapShell").scrollIntoView({ block: "center", behavior: "smooth" });
      });
      list.appendChild(b);
    });
    $("#anchorCity").textContent = city.name;
  }

  function anchorPopup(a) {
    var kindLabel = { built: "Built landmark", water: "Water / shoreline", relief: "Terrain" }[a.kind] || a.kind;
    var warn = "";
    var ov = state.overlay;
    if (ov && a.since > 0 && ov.year != null && a.since > ov.year) {
      warn = "<em class='jm-warn'>Postdates the " + esc(ov.label) +
             " sheet (built c." + a.since + ") — it will not appear on it.</em>";
    }
    if (a.caution) {
      warn += "<em class='jm-warn'>" + esc(a.caution) + "</em>";
    }
    return "<b>" + esc(a.name) + "</b>" + esc(a.note) +
      "<em>" + kindLabel + " · " + a.lat.toFixed(5) + ", " + a.lon.toFixed(5) + "</em>" + warn;
  }

  function updateAnchorValidity() {
    if (!state.anchorGroup) return;
    state.anchorGroup.eachLayer(function (m) {
      if (m._jux) m.setPopupContent(anchorPopup(m._jux));
    });
  }

  function toggleAnchors(on) {
    state.anchorsOn = on == null ? !state.anchorsOn : on;
    var btn = $("#anchorBtn");
    btn.setAttribute("aria-pressed", state.anchorsOn ? "true" : "false");
    if (!state.anchorGroup) return;
    if (state.anchorsOn) state.anchorGroup.addTo(map);
    else map.removeLayer(state.anchorGroup);
  }

  /* ------------------------------------------------------------- gallery */

  function buildGallery(city) {
    var g = $("#gallery");
    g.innerHTML = "";
    mergedOverlays(city).forEach(function (ov) {
      var card = el("button", "jm-card" + (ov.userAdded ? " is-user" : ""));
      card.type = "button";
      card.dataset.id = ov.id;
      card.setAttribute("aria-pressed", "false");

      var mosaic = tileMosaic(ov).map(function (u) {
        return "<img loading='lazy' alt='' src='" + esc(u) + "'>";
      }).join("");

      var mine = ov.userAdded
        ? "<span class='jm-card-mine'>Yours<button type='button' class='jm-card-rm' data-remove='" +
          esc(ov.id) + "' aria-label='Remove this map'>&times;</button></span>"
        : "";

      card.innerHTML =
        "<span class='jm-card-img'>" +
          "<span class='jm-mosaic'>" + mosaic + "</span>" +
          "<span class='jm-card-yr'>" + esc(ov.label) + "</span>" +
          "<span class='jm-card-on'><svg viewBox='0 0 24 24'><path d='M20 6 9 17l-5-5'/></svg></span>" +
          mine +
        "</span>" +
        "<span class='jm-card-b'>" +
          "<h4>" + esc(ov.title) + "</h4>" +
          "<p>" + esc(ov.note || "") + "</p>" +
          "<span class='jm-card-meta'>" + esc(ov.by) + "</span>" +
        "</span>";

      // If every tile of the mosaic fails, fall back to the archive thumbnail,
      // then to a text placeholder.
      var holder = card.querySelector(".jm-mosaic");
      var failed = 0, tiles = card.querySelectorAll(".jm-mosaic img");
      Array.prototype.forEach.call(tiles, function (im) {
        im.addEventListener("error", function () {
          this.style.visibility = "hidden";
          if (++failed === tiles.length) {
            if (!ov.thumb) {   // some archives publish no thumbnail at all
              holder.parentNode.replaceChild(el("span", "jm-noimg", "no preview"), holder);
              return;
            }
            var f = el("img");
            f.loading = "lazy";
            f.alt = "";
            f.className = "jm-thumb-fallback";
            f.src = ov.thumb;
            f.addEventListener("error", function () {
              holder.parentNode.replaceChild(el("span", "jm-noimg", "no preview"), holder);
            });
            holder.parentNode.replaceChild(f, holder);
          }
        });
      });

      var rmBtn = card.querySelector(".jm-card-rm");
      if (rmBtn) {
        rmBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          removeUserOverlay(city, ov.id);
        });
      }

      card.addEventListener("click", function () {
        if (state.overlay && state.overlay.id === ov.id) setOverlay(null);
        else { setOverlay(ov, true); toast(ov.label + " · " + ov.title); }
      });
      g.appendChild(card);
    });
    updateGallerySelection();
  }

  function updateGallerySelection() {
    $$(".jm-card").forEach(function (c) {
      c.setAttribute("aria-pressed", state.overlay && c.dataset.id === state.overlay.id ? "true" : "false");
    });
  }

  /* ------------------------------------------------------------- sources */

  var sourceBlocks = {};   // cityId -> its .jm-src-city element, for appendSourceRow

  function buildSources() {
    var wrap = $("#sourceList");
    wrap.innerHTML = "";
    sourceBlocks = {};
    JUX_CITIES.forEach(function (c) {
      var block = el("div", "jm-src-city");
      block.appendChild(el("h3", null, esc(c.name)));
      c.overlays.forEach(function (ov) {
        var row = el("div", "jm-src");
        var dateNote = ov.dated
          ? "Date from the source record"
          : "Date not stated in the source record";
        row.innerHTML =
          "<div class='jm-src-yr'>" + esc(ov.label) + "</div>" +
          "<div class='jm-src-t'><b>" + esc(ov.title) + "</b>" +
            "<span>" + esc(ov.by) + " · record title: “" + esc(ov.recordTitle) + "” · " +
            esc(dateNote) + " · scan " + ov.px[0] + "×" + ov.px[1] + " px</span></div>" +
          "<div class='jm-src-l'>" +
            "<button class='jm-lnk' data-city='" + esc(c.id) + "' data-map='" + esc(ov.id) + "'>Open on map</button>" +
            "<a class='jm-lnk' href='" + esc(ov.page) + "' target='_blank' rel='noopener'>" +
              esc(ov.archive) + " #" + esc(ov.id) +
              " <svg viewBox='0 0 24 24'><path d='M7 17 17 7M9 7h8v8'/></svg></a>" +
          "</div>";
        block.appendChild(row);
      });
      sourceBlocks[c.id] = block;
      wrap.appendChild(block);
    });

    wrap.addEventListener("click", function (e) {
      var rm = e.target.closest("button[data-remove]");
      if (rm) {
        var rc = cityById(rm.dataset.removeCity);
        if (rc) removeUserOverlay(rc, rm.dataset.remove);
        return;
      }
      var b = e.target.closest("button[data-map]");
      if (!b) return;
      selectCity(b.dataset.city, false);
      var c = cityById(b.dataset.city);
      var ov = findOverlay(c, b.dataset.map);
      if (ov) setOverlay(ov, true);
      $("#explore").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* A reader-added map gets its own row here too, so "everything links to
     its record" stays true for maps we didn't curate ourselves. */
  function appendSourceRow(city, ov) {
    var block = sourceBlocks[city.id];
    if (!block) return;
    var row = el("div", "jm-src jm-src-user");
    row.dataset.userRow = ov.id;
    row.innerHTML =
      "<div class='jm-src-yr'>" + esc(ov.label) + "</div>" +
      "<div class='jm-src-t'><b>" + esc(ov.title) + "</b>" +
        "<span>Added by you, this session · " + esc(ov.archive) + " · not part of the curated set</span></div>" +
      "<div class='jm-src-l'>" +
        "<button class='jm-lnk' data-city='" + esc(city.id) + "' data-map='" + esc(ov.id) + "'>Open on map</button>" +
        "<a class='jm-lnk' href='" + esc(ov.page) + "' target='_blank' rel='noopener'>" +
          esc(ov.archive) + " #" + esc(ov.id.split(":")[1]) +
          " <svg viewBox='0 0 24 24'><path d='M7 17 17 7M9 7h8v8'/></svg></a>" +
        "<button class='jm-lnk jm-lnk-remove' data-remove='" + esc(ov.id) + "' data-remove-city='" + esc(city.id) + "'>Remove</button>" +
      "</div>";
    block.appendChild(row);
  }

  function removeSourceRow(cityId, ovId) {
    var block = sourceBlocks[cityId];
    if (!block) return;
    Array.prototype.forEach.call(block.querySelectorAll(".jm-src-user"), function (row) {
      if (row.dataset.userRow === ovId) row.remove();
    });
  }

  function addUserOverlayToState(city, ov) {
    if (!state.userOverlays[city.id]) state.userOverlays[city.id] = [];
    state.userOverlays[city.id].push(ov);
    if (state.city && state.city.id === city.id) buildGallery(city);
    appendSourceRow(city, ov);
  }

  function removeUserOverlay(city, ovId) {
    var list = state.userOverlays[city.id];
    if (!list) return;
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === ovId) { idx = i; break; }
    if (idx === -1) return;
    var wasActive = state.overlay && state.overlay.id === ovId;
    list.splice(idx, 1);
    removeSourceRow(city.id, ovId);
    if (state.city && state.city.id === city.id) buildGallery(city);
    if (wasActive) setOverlay(null);
    toast("Removed from " + city.name + ".");
  }

  /* ------------------------------------------------------------- routing */

  function syncHash() {
    var h = "#" + state.city.id + (state.overlay ? "/" + state.overlay.id : "");
    if (location.hash !== h) history.replaceState(null, "", h);
  }

  /* City ids are always plain letters. A catalogue overlay id is plain
     digits; a reader-added one is "mw:12345" or "wm:12345" — the colon can
     never appear in a catalogue id, so the two never collide. */
  function readHash() {
    var m = /^#([a-z]+)(?:\/([A-Za-z0-9:]+))?/.exec(location.hash || "");
    if (!m) return null;
    var c = cityById(m[1]);
    if (!c) return null;
    return { city: c, overlayId: m[2] || null };
  }

  /* Resolves a hash's overlay id to an object — fetching it live from its
     archive, and re-verifying its tiles, if it's a reader-added map not
     already loaded into this session. */
  function resolveOverlayId(city, id) {
    if (!id) return Promise.resolve(null);
    var found = findOverlay(city, id);
    if (found) return Promise.resolve(found);
    var parts = id.split(":");
    if (parts.length !== 2 || !ARCHIVES[parts[0]]) return Promise.resolve(null);
    var already = findSameRecord(city, parts[0], parts[1]);
    if (already) return Promise.resolve(already);
    return fetchAndVerifyMap(parts[0], parts[1], function () {}).then(function (ov) {
      addUserOverlayToState(city, ov);
      return ov;
    }).catch(function (err) {
      toast("Couldn’t load the linked map: " + err.message);
      return null;
    });
  }

  /* ------------------------------------------------------------- city */

  function selectCity(id, resetView) {
    var c = cityById(id);
    if (!c) return;
    state.city = c;

    $$(".jm-city").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.city === id ? "true" : "false");
    });

    $("#stageTitle").textContent = c.name + (c.country ? ", " + c.country : "");
    $("#stageBlurb").textContent = c.blurb;
    $("#cityStory").textContent = c.story;
    $("#galleryCity").textContent = c.name;

    if (state.histLayer) { map.removeLayer(state.histLayer); state.histLayer = null; }
    state.overlay = null;

    if (resetView !== false) map.setView(c.center, c.zoom);

    buildAnchors(c);
    buildGallery(c);
    updateDock();
    updateCoords();
    syncHash();
  }

  /* ------------------------------------------------------- map buttons */

  function initMapButtons() {
    $("#basemapSel").addEventListener("change", function () { setBasemap(this.value); });

    $("#anchorBtn").addEventListener("click", function () { toggleAnchors(); });

    $("#resetBtn").addEventListener("click", function () {
      map.setView(state.city.center, state.city.zoom);
      toast("View reset to " + state.city.name);
    });

    $("#fullBtn").addEventListener("click", function () {
      var full = shell.classList.toggle("is-full");
      this.setAttribute("aria-pressed", full ? "true" : "false");
      document.body.style.overflow = full ? "hidden" : "";
      setTimeout(function () { map.invalidateSize(); positionCurtain(); applyClip(); }, 60);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && shell.classList.contains("is-full")) $("#fullBtn").click();
    });

    $$(".jm-mode").forEach(function (b) {
      b.addEventListener("click", function () { setMode(this.dataset.mode); });
    });

    var r = $("#opacityRange");
    r.addEventListener("input", function () {
      setOpacity(parseInt(this.value, 10) / 100);
      if (state.mode === "swipe") setMode("fade");
    });
  }

  /* --------------------------------------------------------- add-a-map ui */

  function initAddMap() {
    var toggle = $("#addMapToggle");
    var form = $("#addMapForm");
    toggle.addEventListener("click", function () {
      var opening = form.hasAttribute("hidden");
      if (opening) form.removeAttribute("hidden"); else form.setAttribute("hidden", "");
      toggle.setAttribute("aria-expanded", opening ? "true" : "false");
      if (opening) $("#addMapInput").focus();
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      handleAddMapSubmit();
    });
  }

  function handleAddMapSubmit() {
    var input = $("#addMapInput");
    var statusEl = $("#addMapStatus");
    var go = $("#addMapGo");
    var parsed = parseMapInput(input.value, $("#addMapArchive").value);

    if (!parsed) {
      statusEl.textContent = "That doesn’t look like a Map Warper or Wikimaps Warper link or ID.";
      statusEl.className = "jm-addmap-status is-error";
      return;
    }
    var existing = findSameRecord(state.city, parsed.archive, parsed.id);
    if (existing) {
      statusEl.textContent = existing.userAdded
        ? "Already added — showing it now."
        : "That map is already in the curated gallery below — showing it now.";
      statusEl.className = "jm-addmap-status is-success";
      setOverlay(existing, true);
      return;
    }

    go.disabled = true;
    statusEl.className = "jm-addmap-status is-pending";
    var city = state.city;
    fetchAndVerifyMap(parsed.archive, parsed.id, function (msg) {
      statusEl.textContent = msg;
    }).then(function (ov) {
      addUserOverlayToState(city, ov);
      setOverlay(ov, true);
      var far = approxKm(ov.center, city.center) > 300;
      statusEl.textContent = "Added — showing “" + ov.title + "” now." +
        (far ? " It’s well outside " + city.name + ", so the map has jumped to where it actually is." : "");
      statusEl.className = "jm-addmap-status is-success";
      input.value = "";
      $("#gallery-sec").scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (err) {
      statusEl.textContent = err.message;
      statusEl.className = "jm-addmap-status is-error";
    }).then(function () {
      go.disabled = false;
    });
  }

  /* ------------------------------------------------------------- boot */

  function boot() {
    toastEl = $("#toast");
    initTheme();
    initNav();
    buildCityRail();

    var sel = $("#basemapSel");
    JUX_BASEMAPS.forEach(function (b) {
      var o = el("option");
      o.value = b.id; o.textContent = b.name;
      sel.appendChild(o);
    });

    initMap();
    buildSources();
    initAddMap();

    var route = readHash();
    var startCity = route ? route.city : JUX_CITIES[0];
    selectCity(startCity.id, true);
    setMode("fade");
    setOpacity(state.opacity);
    toggleAnchors(true);

    var initialOverlay = route && route.overlayId
      ? resolveOverlayId(startCity, route.overlayId)
      : Promise.resolve(startCity.overlays[Math.min(2, startCity.overlays.length - 1)]);
    initialOverlay.then(function (ov) { setOverlay(ov, true); });

    // Real user navigation only — syncHash uses replaceState, which does not fire this.
    window.addEventListener("hashchange", function () {
      var r = readHash();
      if (!r) return;
      var changed = r.city.id !== state.city.id;
      if (changed) selectCity(r.city.id, true);
      resolveOverlayId(r.city, r.overlayId).then(function (ov) {
        if (ov !== state.overlay) setOverlay(ov, true);
      });
      if (changed) $("#explore").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    $("#year").textContent = new Date().getFullYear();

    // Small handle for debugging and for embedding elsewhere.
    window.JuxMaps = {
      getMap: function () { return map; },
      state: state,
      applyClip: applyClip,
      setOverlay: setOverlay,
      selectCity: selectCity,
      fetchAndVerifyMap: fetchAndVerifyMap,
      parseMapInput: parseMapInput
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
