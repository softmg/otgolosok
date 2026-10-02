# Plan: Unified style for map markers and the route line

Status: implemented 2026-10-02 in branch `feat/promo-walks-stories-only`. Caveat: 6 pre-existing `layout-invariants` "footer … обрезано" failures in the walk panel (also failing on the base commit) are not addressed here.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

Story markers on the Leaflet map currently mix three shapes and two colours with no shared logic:

- clusters — dark green (`--map-green`) 48 px circles with a white count;
- single catalog places — terracotta (`--map-orange`) teardrop pins with a white fill and a `♪` glyph;
- numbered walk stops — the same teardrop with a number;
- walk start/finish and background catalog points in walk-creation mode — filled terracotta 24 px dots;
- the route line and spider legs — dark green (`--route-line`).

The user finds the green/orange mix inconsistent and dislikes the music note. Goal: one visual system — circles everywhere, terracotta for all story markers, the route line stays green, single places become plain circles without any symbol.

## Approved decisions

1. **Colour.** All story markers (clusters, single places, numbered stops, pending, start/finish, background dots) use terracotta `--map-orange`. The route line and cluster spider legs stay dark green (`--route-line` → `--map-green`) so markers read on top of the line.
2. **Shape.** Every marker is a circle; the teardrop pin shape is removed entirely.
3. **Single place.** A filled terracotta circle with a light rim (`--surface-island`), no glyph at all (the `♪` is removed, no replacement symbol).
4. **Selected single place.** The same circle, larger, with the same light rim — no shape change on selection. (Revised during implementation at the user's request: the originally planned outer terracotta ring produced a double outline and was dropped.)
5. **Numbered walk stops.** Circle with the number: light fill (`--surface-island`), terracotta border and terracotta number — visually distinct from clusters (terracotta fill, white count). The current/selected stop inverts: terracotta fill, light number, light rim (no outer ring — see decision 4).
6. **Walk start/finish.** A distinct small hollow circle: light fill, thick terracotta ring, smaller than a single place — reads as an end of the line, not as a story.
7. **Clusters.** Recoloured to terracotta fill, light rim, white count; size and behaviour unchanged.
8. Implementer's call (not discussed, keep minimal): the route line gets a light casing (a wider `--surface-island` polyline under the green one) and round caps/joins, so it shares the "light rim" motif with markers and stays legible over the basemap. Pending ("story is being prepared") marker = light circle with a dashed terracotta border, no `…` glyph.

## Key codebase facts

- All marker rendering is in `src/features/explore/explore-map.tsx`, the effect "Markers are updated by id" (~lines 355–455). Label choice is at ~366–370: `item.number ? String(item.number) : item.pending ? "…" : "♪"`. Icons: `item.compact` → `L.divIcon({ className: styles.dot, iconSize: [32,32], iconAnchor: [16,16] })`; otherwise `styles.pin` (+ `styles.selected`, `styles.pending`) with `html: <span><b>${label}</b></span>`, `iconSize: [44,52]`, `iconAnchor: [22,48]` (tip-anchored teardrop).
- `look` (JSON of title, label, compact, pending, active) decides whether `setIcon` is called; it must include every field that changes the icon (add the new variant).
- `data-marker` attribute: `"dot"` for compact, `"pin"` otherwise; clusters set `"cluster"` in `src/features/explore/map-clusters.ts` (`iconCreateFunction`, `className: styles.cluster`). Tests and e2e select by these values — keep `"pin"` for single places and numbered stops, `"dot"` for compact; add `"endpoint"` for start/finish.
- `MapItem` type: `src/features/explore/explore-map.tsx` ~lines 87–96 (`number`, `pending`, `compact`, `clusterable`).
- `compact: true` is used for two different things: walk start/finish (`src/features/tour/walk-session.tsx:48,50`) and background catalog points during walk creation (`src/features/explore/around-screen.tsx:120`). These must be separated.
- Styles: `src/features/explore/explore-map.module.css` (`.pin`, `.pending`, `.selected`, `.dot`, `.cluster`, `.userPosition`). The file header says it is the only CSS that may reach into Leaflet.
- Tokens: `src/styles/tokens.css` — `--map-green: #203e38`, `--map-orange: #b64b28`, `--surface-island: #fffaf0`, `--raised`, `--on-dark: #fff`, `--route-line: var(--map-green)` (line 104), `--user-position: var(--focus)`, `--text-map-pin`. White on `#b64b28` ≈ 5:1 contrast — OK for numbers.
- Route colours are read once via `getComputedStyle` (~lines 293–305) into `rt.colors`; the polyline is drawn at ~line 471 (`weight: 5, opacity: 0.9`), its element gets `data-route`. Spider legs use `routeColor` (stay green).
- `src/features/explore/map-view.ts:10` — `const PIN = { top: 48, side: 24 }`: extra room for a teardrop rising 48 px above its point, used in focus/fit insets (line 43). With centre-anchored circles the room becomes symmetric.
- User position marker (`.userPosition`, blue `--user-position`) is not a story marker — out of scope.
- DESIGN.md has no section about map markers; palette section lists `cinnabar` for the walk dark theme only.
- Tests touching markers: `src/features/explore/explore-map-markers.test.ts` (selects `[data-marker="pin"]`, `cluster`), `src/features/explore/explore-map.test.ts`, `map-clusters.test.ts`, `map-view.test.ts`; e2e: `e2e/interface.spec.ts:482-497` (creation background dot: `data-marker="dot"`, inner span width 24–28 px), `e2e/map-catalog.spec.ts`, `e2e/walk-session.spec.ts` (`.walk-session-map [data-marker="pin"]`, titles `Остановка N:`).
- Checks: `pnpm check` (lint, typecheck, vitest + node tests, Python, build); e2e `pnpm test:e2e` (Playwright).

## Implementation

### 0. Marker variants in the model

In `explore-map.tsx`:
- Extend `MapItem` with `endpoint?: boolean` — "walk start or finish: a small hollow ring, not a story". Keep `compact` with the narrowed meaning "background catalog point in a mode where it is secondary" (document it in the JSDoc).
- Introduce a pure helper (exported for tests, e.g. in a new `src/features/explore/map-marker-look.ts`) `markerLook(item: MapItem, active: boolean): { kind: "place" | "stop" | "pending" | "endpoint" | "background"; label: string; size: number; dataMarker: "pin" | "dot" | "endpoint"; zIndex: number }` (as built: no class list — CSS-module classes stay in the component, mapped from `kind` via `MARKER_CLASS`; z-index lives in the helper). Rules: `endpoint` → endpoint; `compact` → background; `number` → stop (label = number); `pending` → pending (label = ""); otherwise place (label = ""). No `♪` and no `…` anywhere.
- The effect uses the helper for icon creation, `look` (must include `kind`), `data-marker`, and z-index (active 1000, background/endpoint −1000, others 0 — endpoints stay under stops).

### 1. Icons

Replace the teardrop divIcon with centre-anchored circle icons:
- Every icon's `iconSize` is square, `iconAnchor` is its centre; the clickable box stays ≥ 44×44 (`--control-min`) for place, pending, stop, endpoint; background keeps 32×32 (it is secondary, matches today).
- HTML stays a fixed template: `<span>${label}</span>` where label is only a number or empty — never upstream HTML (keep the existing comment).
- Remove `styles.pin`'s rotation markup (`<b>` inside rotated span).

### 2. Styles (`explore-map.module.css`)

Rewrite marker rules (class names may be renamed: `.place`, `.stop`, `.pending`, `.endpoint`, `.background`, `.selected`, `.cluster`); the transparent Leaflet box is the hit area, the inner `span` is the visible circle:
- `.place > span`: 24 px, fill `--map-orange`, 3 px `--surface-island` border, soft shadow (`color-mix` of `--map-orange`/`--map-green`, as today). Hover/focus-visible: 28 px.
- `.place.selected > span`: 32 px, same fill and light border (no outer ring, see decision 4).
- `.pending > span`: 24 px, fill `--surface-island`, 3 px dashed `--map-orange` border; selected: 32 px.
- `.stop > span`: 34 px, fill `--surface-island`, 3 px solid `--map-orange` border, number in `--map-orange`, bold, `--text-map-pin`, `--font-body`. `.stop.selected > span`: fill `--map-orange`, number `--surface-island`, light border.
- `.endpoint > span`: 16 px, fill `--surface-island`, 4 px `--map-orange` border, small shadow.
- `.background > span`: same as `.place` at 24 px (keeps `e2e/interface.spec.ts` 24–28 px assertion), no selection styles needed.
- `.cluster`: background `--map-orange`, border 3 px `--surface-island`, text `--on-dark`; hover `color-mix(in srgb, var(--map-orange) 88%, var(--on-dark))`; shadow in terracotta. Size unchanged (48 px, set in `map-clusters.ts`).
- Focus rings: keep `outline: var(--focus-ring)` with `border-radius: 50%` on all circle variants.
- Delete `.pin` / `.pin > span > b` rules once unused; stylelint must pass.

### 3. Route line

In the geometry effect (~line 465): draw two polylines into `rt.route` — a casing (`color: --surface-island` read once into `rt.colors.casing`, `weight: 9`, `opacity: 0.9`) then the line (`--route-line`, `weight: 5`, `opacity: 0.95`), both `lineCap: "round"`, `lineJoin: "round"`, `interactive: false`. Only the green line keeps `data-route` (existing selectors/tests). Fit uses the green line's bounds as now.

### 4. Callers

- `src/features/tour/walk-session.tsx:48,50`: start/finish `compact: true` → `endpoint: true`.
- `src/features/explore/around-screen.tsx:120`: background points keep `compact: true` (no change in meaning).
- `src/features/walk-builder/walk-creation-panel.tsx:47` and `src/features/tour/walk-map.tsx` already pass `number` → become stop circles automatically.

### 5. View insets

`src/features/explore/map-view.ts:10`: change `PIN` to the room a centred circle needs (largest is the selected stop ≈ 34 px + 3 px ring → `{ top: 24, side: 24 }`), update the doc comment and `map-view.test.ts` expectations if they encode 48.

### 6. Docs

- `DESIGN.md`: add a short "Метки на карте" section (Russian): terracotta for all story markers, green line with light casing, circle variants (место, выбранное место, остановка с номером, текущая остановка, готовится, старт/финиш, группа), no glyphs.
- `docs/agents/map-clustering.md`: checked — it does not mention marker shapes or colours, no change needed.

## Testing & verification

- Unit (vitest, table-driven): `markerLook` — place / selected place / pending / selected pending / stop / selected stop / endpoint / background → kind, label (`""` for place and pending, never `♪`/`…`), `dataMarker`, class list. Boundary: `number` together with `pending` → stop wins; `endpoint` with `number` → endpoint.
- `explore-map-markers.test.ts`: update to assert single catalog places render an empty label (no `♪`), stops render their number, start/finish get `data-marker="endpoint"`, toggling selection updates classes on the same element (focus preserved — existing tests). Remove/adjust assertions that depend on the teardrop markup.
- `explore-map.test.ts` (or existing route test): route layer contains a casing and a `data-route` line.
- `map-view.test.ts`: new `PIN` room.
- e2e: run `e2e/interface.spec.ts`, `e2e/map-catalog.spec.ts`, `e2e/walk-session.spec.ts`; update selectors only where `data-marker` for start/finish changed. Add one assertion in `walk-session.spec.ts` that start/finish carry `data-marker="endpoint"`. As built: route-line selectors `.leaflet-overlay-pane path` became `path[data-route]` (the casing is a second path); `layout-invariants.spec.ts` known `focus` failures for the selected place at 320×568 were removed where centred circles now pass (only `карта / выбранный дом` webkit 320×568 remains).
- `pnpm check` must pass.
- Browser verification (dev server via preview): home map at overview and street zoom (clusters + single places same terracotta, no notes), select a place (larger circle with ring), walk creation (background dots + numbered stops + green line with casing), walk session (current stop inverted, start/finish hollow rings), mobile width 375 px. Take screenshots for the report.

## Out of scope

- Basemap POI icons drawn by MapLibre (`src/features/explore/map-icons.ts`) — they are basemap symbols, not story markers.
- User position marker and accuracy circle.
- Changing cluster radius/behaviour, marker data, or adding category-specific colours/icons for places.
- Dark-theme variants of map markers (the map has no dark theme today).

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
