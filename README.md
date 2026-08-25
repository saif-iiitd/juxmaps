# JuxMaps — prototype

An interactive, mobile-friendly tool for laying **georeferenced historical maps** over the
present-day map of a city. Built for researchers, journalists and curious readers.

Eight cities, 41 historical sheets, 1550–1966.

---

## Run it

No build step and no dependencies to install. Any static server works:

```bash
python -m http.server 8123
```

Then open <http://localhost:8123>. A `.claude/launch.json` is included so the
Claude Code preview can start the same server by name (`juxmaps`).

Leaflet is vendored in `assets/vendor/leaflet/`, so the only network traffic at
runtime is map tiles and the Google Fonts stylesheet.

## What it does

- **Eight cities** — London, Paris, Rome, Istanbul, Jerusalem, Cape Town, Mumbai, Mexico City.
- **Fade** an old map in and out over the modern one, or **Swipe** a draggable
  curtain across the screen (`Then` on the left, `Now` on the right).
- **Seven base maps** — Voyager, light, dark, OpenStreetMap, satellite imagery,
  topographic, and *None*, which shows the historical sheet on its own.
- **Zoom, pan, pinch**, plus a scale bar and a live centre-coordinate readout.
- **Reference points** — long-lived landmarks you can fly to in order to judge
  how well the overlay is aligned. Markers warn you when a landmark postdates
  the selected sheet, or sits on ground that later moved — a reclaimed
  shoreline, a rebuilt riverbank.
- **Gallery** of the city's sheets, each previewed from its own warped tiles.
- **Deep links** — the URL carries the city and the sheet, e.g.
  `#paris/79748`, so a particular juxtaposition can be shared.

## Layout

```
index.html                  markup: menubar, map, gallery, methodology, sources, footer
assets/css/juxmaps.css      design tokens, layout, light + dark themes
assets/js/catalogue.js      GENERATED — cities, overlays, anchors, base maps
assets/js/app.js            map logic, comparison modes, gallery, routing
assets/vendor/leaflet/      Leaflet 1.9.4, vendored
tools/gen_catalogue.py      regenerates catalogue.js from source APIs
```

### Regenerating the catalogue

`assets/js/catalogue.js` is generated, not hand-written, so that no coordinate
is ever transcribed by hand. Measured fields (bounding boxes, centres, scan
dimensions, thumbnails, usable zoom ranges) come from the archives' APIs;
anchor coordinates come from OpenStreetMap Nominatim. Titles, notes and the
choice of anchors are editorial and live in the `ED`, `CITY` and `ANOTE`
dictionaries inside the generator.

## Where the maps come from

Historical overlays come from two open georeferencing platforms, where
contributors upload scans of old maps and align them by hand:

- **[Map Warper](https://mapwarper.net/)** — 38 of the 41 sheets.
- **[Wikimaps Warper](https://warper.wmflabs.org/)** — the three British
  Admiralty charts of Table Bay, scanned by Wikimedia Commons.

Each overlay carries its own `archive`, `tiles` and `page` fields, so the
gallery card, the map attribution and the Sources row all name the right
platform. Adding a third archive needs no code change.

Base maps and services: OpenStreetMap, CARTO, Esri/Maxar, OpenTopoMap,
Nominatim, Leaflet.

## Known limits

These are stated on the page itself, in the Methodology section, and they are
the honest boundary of what this prototype supports:

- **Alignment is approximate and unmeasured.** Each sheet was warped by a
  volunteer contributor. Fit quality varies, and this project has not
  independently measured error on any sheet.
- **Dates come from the source record.** Where a record carries no date, the
  gallery badge reads *undated* and the Sources list says so. Dates were not
  verified against library catalogues.
- **Control points are not published here.** Map Warper's `gcps.csv` export is
  behind a bot check, so control-point counts and residuals could not be read
  programmatically and are deliberately not shown. The Sources links go to the
  records so you can inspect them directly.
- **Anchor coordinates are measured; anchor choice is editorial.** Positions
  were resolved via Nominatim. Which landmarks appear, and the approximate
  founding years shown in their popups, are editorial judgements.
- **Do not measure off these overlays.** Use them to see change and raise
  questions, then go to the archival source before publishing a claim.
- **Cape Town is the thinnest set, and depends on volunteer infrastructure.**
  Only four usable sheets exist across the platforms searched, and three are
  nautical charts rather than street maps. They are served by
  `warper.wmflabs.org`, which runs on Wikimedia Cloud Services — less
  guaranteed uptime than `mapwarper.net`. If Cape Town goes blank, check that
  host first.

## Verification performed

- All 41 overlays were probed for real tile bytes at real viewing zooms before
  being added; every one returned a non-empty PNG. Candidate maps that returned
  empty tiles were dropped rather than shipped.
- Two Istanbul sheets only serve tiles to zoom 14 and 15; their
  `maxNativeZoom` is set accordingly so Leaflet upscales instead of showing
  blanks. The four Cape Town sheets are capped at the zoom where their scan
  actually runs out of detail (z14–z18), so deep zooms upscale rather than
  fetch tiles that hold no more information.
- Verified in-browser over `http://localhost`: routing, all seven base maps,
  both comparison modes, the swipe clip geometry under pan, theme toggle,
  and the mobile layout at 375×812. Not yet verified opening `index.html`
  directly from disk, or on a physical touch device.
