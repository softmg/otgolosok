# Plan: Layout architecture — one map shell, CSS Modules, enforced layout invariants

Status: in progress since 2026-09-30, phases 0–4 done (phases 3 and 4 merged into one commit); next: phase 5 (walk session on MapShell).

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

The product owner reports that the layout "breaks too often". The numbers confirm it: of 292 commits since 2026-09-04, 92 touch CSS; the four map-layout stylesheets (`explore.css`, `walk-session.css`, `walk-creation-panel.css`, `app-navigation.css`) received 58 commits, 42 of them `fix`. `docs/agents/story-card-scroll.md` still lists unresolved layout defects. The cause is structural, not a set of individual bugs:

1. **No shared frame for map screens.** Three screens (home map, walk creation, walk session) each position header, map buttons, bottom panel, attribution and navigation with `position: absolute/fixed` and hand-computed offsets. The navigation height (78px) is re-encoded in neighbours as 94, 98, 102, 104, 108, 110, 112, 122, 180 and 212. Nothing makes two elements aware of each other, so any change in one moves it onto another.
2. **Overlapping media queries.** 13 distinct media conditions; `min-width:700px` and the low-landscape blocks apply at the same time and have to undo each other (this exact conflict was "fixed" three times).
3. **JS duplicates CSS.** `walk-creation-panel.tsx` and `walk-session.tsx` re-implement breakpoints and offsets in JS to compute map padding; the two drift apart.
4. **Unmaintainable CSS form.** Minified one-line rules, append-only "override" sections, global class names shared across features, 42 raw hex colors and 313 px literals in `explore.css` alone. Unit tests assert layout by regex over CSS text, so they pass while the screen is broken.
5. **Safe areas are not real.** `layout.tsx` has no `viewport-fit=cover`, so every `env(safe-area-inset-*)` is 0 in real browsers while the PWA uses `statusBarStyle: "black-translucent"`. The safe-area math is only ever exercised by CDP emulation in e2e.

Goal: make overlap and drift impossible **by construction** (one layout owner, content-sized regions, scoped styles) and **by enforcement** (Stylelint rules plus an e2e matrix of geometric invariants), then migrate the whole app onto it. This is a refactor: product behavior and copy stay the same except where listed in "Approved decisions".

Constraints: static export (`output: "export"`), Next.js 16.3.4 with Turbopack + LightningCSS (read `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md` and `.../08-turbopack.md` before writing code), React 19, Leaflet 1.9.4 + maplibre-gl-leaflet, CSP `style-src 'self' 'unsafe-inline'`. UI text and docs are Russian. No new runtime dependencies.

## Approved decisions

Decisions 1–6 were answered by the user directly. For 7–16 the user delegated the choice ("decide yourself, I want a production-ready, correct approach; technologies and architecture may be revised") — they are the planning agent's decisions and the user may veto any of them before implementation starts.

1. **Scope: the whole application.** Map screens get the new architecture; content pages, legacy editorial walk view, generator and admin are migrated to the same CSS system.
2. **Map buttons sit in one row directly under the header on every map screen and in every mode.** They never float beside or under the bottom panel.
3. **Exactly two layout modes for map screens:** *stack* (header → controls → map → panel, default) and *side* (panel as a right column, header top-left, navigation at the bottom). No third "low landscape" variant.
4. **The primary action is always visible.** A panel has a fixed header, a fixed footer with the primary action, and exactly one scroll area between them. No nested scroll areas, no whole-panel scrolling.
5. **Enable `viewport-fit=cover`** and make safe-area insets real, defined once as tokens.
6. **Add Stylelint and Prettier (CSS only)** as dev dependencies and wire them into `pnpm lint`.
7. **CSS Modules, not Tailwind/CSS-in-JS.** Next docs recommend CSS Modules for scoped CSS and warn that global CSS imported from components is never unloaded and is order-dependent. Modules fix scoping with zero new runtime and work natively in Turbopack. Tailwind would be a second full rewrite of markup for no additional safety.
8. **Global CSS is limited to three layered files** (`tokens`, `base`, `ui`) imported only from the root layout, inside `@layer reset, base, ui`. Component modules are unlayered, so a module rule always beats a global one regardless of specificity or import order.
9. **Side mode condition (single source of truth):** `(min-width: 700px), (min-width: 568px) and (max-height: 560px)`. Columns: main `minmax(17.5rem, 1fr)`, panel `minmax(0, 26.25rem)`; the panel is bottom-anchored in its column.
10. **Attribution lives in the controls row** (left side, links stacked) in both modes — the walk session already does this; it costs no extra vertical space.
11. **Navigation is one fixed island for both render sites**, sized by the same rule as the panel in stack mode (`min(26.875rem, 100% − 2·gutter)`, centered). Safe-area bottom is counted once.
12. **Own zoom buttons** (React, in the controls region) replace the Leaflet zoom control, so no feature CSS ever targets `.leaflet-*` for positioning.
13. **The map never re-fits after the user has panned or zoomed it.** Inset changes re-apply the last fit/focus only until the first user gesture; a new route or a new focus resets this.
14. **Tests never read CSS text and never select by CSS class.** The regex-on-CSS unit tests are deleted; layout is verified by the e2e invariants matrix, conventions by Stylelint. Hooks are roles, accessible names and `data-*` attributes.
15. **The invariants spec also runs on WebKit** (reduced viewport subset); everything else stays Chromium-only.
16. **No mass reformat of legacy CSS.** Legacy files are excluded from Prettier/Stylelint through an explicit ignore list that shrinks as each file is replaced by a module; the list must be empty at the end.

## Key codebase facts

Stack and tooling
- `package.json` scripts: `lint: eslint`, `typecheck`, `test: vitest run && node --test backend/*.test.mjs`, `check: pnpm lint && pnpm typecheck && pnpm test && pnpm test:py && pnpm build`, `test:e2e: playwright test`. No Stylelint/Prettier, no CI config.
- `playwright.config.ts`: one default (Chromium) project, viewport 390×844, `webServer: pnpm dev --port 3217` with `reuseExistingServer`, `fullyParallel`. Locally installed browsers: chromium and webkit. E2E runs against `next dev`, not the production export.
- `vitest.config.ts`: `environment: "node"`, `include: ["src/**/*.test.ts"]`, alias `@`; some tests opt into jsdom via `@vitest-environment jsdom`. Vitest 5.0.0 exposes `test.css.modules.classNameStrategy`.
- Other agent sessions work in the same branch in parallel and may hold uncommitted edits (see the repo memory note): commit only your own files, run e2e in a separate worktree if another dev server is running, never touch the shared stash.

CSS inventory (15 files in `src`, 2174 lines; all global, imported from components)
- `src/app/globals.css` (1131 lines): tokens in `:root` (`--paper`, `--ink`, `--accent`, `--map-green`, `--map-orange`, `--focus`; type scale `--text-meta … --text-page`; `--space-xs … --space-3xl`; radii; `--control-min: 2.75rem`, `--control-primary-min: 3.5rem`), reset, legacy editorial styles, dark classic walk mode (`.shell[data-mode="walk"]`, `--walk-*`), generator styles (`.generator-*`), inset map overrides for `.walk-map-canvas` (~lines 837–849), reduced-motion block with `!important`.
- `src/features/explore/explore.css` (213 lines, minified): `.around-shell` with `--around-nav-height`, `--around-sheet-top`, `--around-sheet-bottom`; Leaflet zoom control repositioned by `.explore-map .leaflet-bottom.leaflet-right{top:290px}` (line 24) and again in three media blocks (lines 139, 147, 164); `.map-attribution` absolute at `bottom: calc(94px + safe-bottom)` (line 25); `.around-locate{top:234px}` (line 39); `.around-bottom` with `max-height: calc(100% − top − bottom)`; story scroll fade via `@property --around-fade-top/bottom` and `animation-timeline: scroll(self)` written in longhand (LightningCSS expands the `animation` shorthand with `animation-duration: 0s`); an appended typography override section (lines ~183–211); line 213 hides the bottom panel through `:has(.creation-panel)`.
- `src/features/tour/walk-session.css` (70 lines): `.walk-session{position:fixed; inset:0}`, `--walk-header-top`, `--walk-controls-top`; zoom control and attribution placed on `--walk-controls-top` (lines 4–5); `.walk-session-panel` scrolls as a whole with `bottom: calc(104px + 2 * env(safe-area-inset-bottom))`; nested `.walk-session-drawer{max-height:26dvh; overflow-y:auto}`; landscape block sets `--walk-panel-dock: right`, read by JS.
- `src/features/walk-builder/walk-creation-panel.css` (31 lines): `.creation-panel{position:fixed; z-index:950; top:100px; left:50%; transform:translateX(-50%); width:420px; max-height:calc(100dvh − 212px)}` with header / scrolling body / footer; 7 unused classes (`creation-intro`, `creation-segments`, `creation-letter`, `creation-search`, `creation-resume`, `creation-suggestions`, `creation-address-hint`).
- `src/features/navigation/app-navigation.css` (10 lines): height `calc(78px + safe-bottom)` with bottom padding including safe-bottom, and the standalone variant adds `bottom: calc(12px + safe-bottom)` — safe-bottom is counted twice, which is why neighbours use `2 * env(...)`.
- `src/features/ui/surfaces.css`: shared primitives `.app-header`, `.ui-page{max-width:1040px; padding:0 28px 140px}`, `.ui-button`, `.ui-field`, `.ui-notice`, `.ui-row`, `.ui-eyebrow`, `.ui-muted`. Imported from `app-header.tsx` and `walk-creation-panel.tsx`.
- Others: `walks/walks.css` (108; `.walk-offline-notice--map{position:fixed; top:12px; left:76px; right:100px}` overlaps header/panel; 5 unused `.walk-library*` classes), `walks/history.css`, `account/account.css`, `auth/auth.css` (7 unused `.account-*` classes), `admin/admin.css` (169), `admin/content-admin.css` (114), `admin/walk-admin.css` (286; rem breakpoints 70/68/60/45/44rem), `explore/place-heading.css`, `explore/map-dots.css`.
- `public/update.css` + `public/update.html`: standalone page outside the bundle that mirrors tokens by hand.
- CSS import sites: `app/layout.tsx` (globals), `app/admin/page.tsx` (admin.css), `account.tsx`, `content-admin.tsx`, `walk-admin.tsx`, `login.tsx`, `around-screen.tsx` (place-heading, explore), `explore-map.tsx` (leaflet, maplibre-gl, map-dots), `app-header.tsx` (surfaces), `app-navigation.tsx`, `walk-map.tsx` (explore), `walk-session.tsx` (explore + walk-session), `walk-creation-panel.tsx` (surfaces + own), `walk-library.tsx` (history), `walk-screen.tsx` (walks).

Components
- `src/features/explore/explore-map.tsx`: `ExploreMap({items, selectedId, focus, user, onSelect, onPoint, geometry, mapLabel, viewState, routePadding})`. Creates the Leaflet map with `zoomControl:false` and then adds `L.control.zoom({position:"bottomright"})` (line 94). Focus effect (lines 147–161) centers in the uncovered area when `routePadding` is set, otherwise `panBy([0,80])`. Route effect (lines 163–169) calls `fitBounds` on **every** `routePadding` change, which resets the user's zoom. Renders `.explore-map-layer > .explore-map` plus `.map-loading`, `.map-network-note`, `.map-attribution` (lines 181–186). Marker `divIcon` classes: `explore-dot`, `explore-pin` (+ `selected` / `pending`), `explore-user-position`. Route and accuracy colors are hex literals in JS (`#203e38`, `#246b90`).
- `src/features/explore/around-screen.tsx` (dense, ~235 lines): renders `WalkCreationPanel` when `?walk=create`, `ExploreMap` with `routePadding={creating ? creationMap.padding : undefined}`, `.around-content > header.around-header` (brand, search toggle, search form), `.around-locate`, and `.around-bottom` holding the geo message and one of: location prompt / story card / place card / nearby list / map hint, plus the "Создать прогулку отсюда" link and the update link. Renders `<AppNavigation embedded … />` itself.
- `src/features/walk-builder/walk-creation-panel.tsx`: exports `CreationMap = { items; geometry?; focus; picking; padding? }`; measures its own rect and computes padding with `innerWidth >= 700 || innerHeight <= 560` — a JS copy of the CSS breakpoints.
- `src/features/tour/walk-session.tsx`: measures panel and header with `ResizeObserver`, reads `--walk-panel-dock` through `getComputedStyle`, and builds map padding with literals (`cover.top + 48`, `cover.size + 125`, `160`, `45`). The panel contains heading, player, notices, tools, a drawer (`stops | story | settings`) and footer actions.
- `src/features/tour/tour-experience.tsx` (~line 258): one `<main>` whose class switches between `walk-session`, `shell` and `around-shell`.
- `src/features/tour/walk-map.tsx`: inset map of the classic walk view — `ExploreMap` inside `.walk-map-canvas`, imports `explore.css`.
- `src/features/navigation/app-navigation.tsx`: rendered from `app/layout.tsx` (standalone; returns `null` on `/` and on unknown sections) and from `around-screen.tsx` (`embedded`, to pass `onWalk` / `onNearby`).
- `src/app/layout.tsx`: no `viewport` export; `appleWebApp: { capable: true, statusBarStyle: "black-translucent" }`. `src/app/manifest.ts`: `display: "standalone"`, `orientation: "portrait"`.
- Dynamic class names that need a lookup after migration: `admin-stage-${…}`, `content-batch-state-${…}`, `content-text-${…}`, `identity-tier-${…}`, `signal-status ${signalTone(…)}`, `offline-copy.tsx` `statusClassName`, `creation-panel is-picking | is-preview`.

Tests
- Regex-on-source tests: `src/features/explore/explore-layout.test.ts`, `src/app/design-tokens.test.ts`, `src/features/brand/brand-mark.test.ts` (reads `globals.css`, `explore.css`, `admin.css`, `public/update.css`), `src/features/navigation/app-navigation.test.ts` (reads TSX sources).
- jsdom tests that query by class: `admin-desk.test.ts`, `content-admin.test.ts`, `identity-candidates.test.ts`, `walk-admin.test.ts`, `explore-map-markers.test.ts`, `walk-creation-panel.test.ts`, `walk-library.test.ts`.
- E2E: `e2e/interface.spec.ts` (helper `openLongStory`; creation-panel geometry on 8 viewports asserting the panel is horizontally centered; short-portrait tests using CDP `Emulation.setSafeAreaInsetsOverride`), `e2e/walk-session.spec.ts` (helpers `setup`, `controlsState`, `edges`, `routeIsVisible`, `checkPanelStates`, `expectMapUsable`, `expectBottomPanel`), `e2e/navigation.spec.ts`, `e2e/offline-walk.spec.ts`. They select by class: `.creation-panel`, `.explore-map`, `.map-loading`, `.leaflet-overlay-pane`, `.walk-session-map`, `.around-story-card`, `.around-bottom`, `.explore-pin`, `.walk-session-panel`, `.walk-session-drawer`, `.around-header`, `.app-navigation`, and others.

Docs that describe the current layout and will become stale: `DESIGN.md` (e.g. "creation panel centered at ≥700px"), `docs/agents/story-card-scroll.md`, `docs/agents/walk-map-session.md`, `docs/agents/map-walk-creation.md`.

## Implementation

General rules for every phase
- A phase is done when `pnpm check` and `pnpm test:e2e` are green, the known-failures list (phase 0) has only shrunk, and the work is committed atomically (Conventional Commits, Russian description). Do not start the next phase on red.
- Ask the user before creating a branch. Because other sessions edit the same files, a dedicated branch/worktree is recommended — but it needs the user's explicit confirmation.
- New component CSS is a `*.module.css` next to the component, formatted by Prettier, one declaration per line, camelCase class names. No comments that restate the code; comment only non-obvious constraints (e.g. the LightningCSS `animation` longhand).
- Before deleting an "unused" class, confirm with a repo-wide search (including template-string class names and e2e).
- Every workaround or defect discovered on the way is reported to the user with a proposed proper fix; nothing is silently patched around.

### 0. Baseline: stable hooks and the invariants spec

Purpose: get an objective measure of "layout is broken" before changing layout, and hooks that survive the migration.

- Add `data-region` attributes to the **existing** markup (no visual change): `header` (`.around-header`, walk-session header), `controls` (locate buttons; the Leaflet zoom container via `control.getContainer().setAttribute(...)`), `sheet` (`.around-bottom` cards, `.creation-panel`, `.walk-session-panel`), `notices` (geo message, offline notice, map loading/network notes), `attribution`, `nav` (`.app-navigation`), `map`. Add `data-sheet-part="header|body|footer"` where those parts already exist, and `data-marker="pin|dot|user"` (+ `data-selected`) on marker elements via `marker.getElement()`.
- Create `e2e/support/layout.ts`:
  - `VIEWPORTS`: 320×568, 360×640, 375×667, 390×844, 430×932 (stack portrait); 568×320, 667×375, 844×390, 932×430 (landscape phones); 699×800, 700×800 (mode boundary); 768×1024, 1024×500, 1280×640, 1440×900. `SAFE_AREA_VARIANTS` (portrait notch, landscape notch) applied through CDP on Chromium only. `WEBKIT_VIEWPORTS`: 320×568, 390×844, 667×375, 1024×500.
  - `collectRegions(page)`: returns `{ region, part?, rect }[]` for all visible `[data-region]` elements and sheet parts.
  - `expectLayoutInvariants(page, options)`: (a) every region lies inside the viewport minus safe-area insets; (b) regions with different names do not intersect and keep a gap ≥ 8px (map excluded; nav vs. everything included); (c) every enabled interactive element inside a region (`button`, `a[href]`, `input`, `[role=button]`) is hit-testable at its center (`document.elementFromPoint` returns it or a descendant) and is ≥ 44×44 CSS px — attribution links are exempt from the size rule; (d) `document.scrollingElement.scrollWidth <= clientWidth`, and no horizontal overflow inside the sheet; (e) the sheet footer, when present, is fully visible without scrolling, and the sheet body keeps ≥ 48px of visible height whenever it has overflow; (f) with `expectFreeArea: true`, the uncovered map area (viewport minus regions) contains a rectangle of at least 72px height and 160px width, and the selected marker / route bounding box lies inside it right after selection or route build.
  - `KNOWN_LAYOUT_FAILURES`: explicit list of `{ screen, state, viewport, invariant, reason }`. Matching tests are marked with `test.fail()`, so an entry that starts passing turns the run red until it is removed.
- Create `e2e/layout-invariants.spec.ts` — table-driven over screens × states × viewports, reusing the existing route mocks and helpers (move shared ones from `interface.spec.ts` / `walk-session.spec.ts` into `e2e/support/`):
  - Home: location prompt; selected place with a long story (`openLongStory`); nearby list; search open; map hint only.
  - Walk creation (`/?walk=create`): initial form; point-picking state; route preview (mocked `/api/walk-plan`).
  - Walk session: before start; walking with player; each drawer (`stops`, `story`, `settings`); finished; offline notice visible.
  - Content pages (history, account, login): only (a), (c), (d) plus "the last interactive element is not covered by the navigation after scrolling to the bottom" and "nothing is rendered under the top safe-area inset".
- `playwright.config.ts`: add a `webkit` project restricted to `layout-invariants.spec.ts` (`testMatch`) and keep the default project for everything. Verify the installed WebKit revision matches Playwright 1.63; if not, ask the user before downloading browsers.
- Run against the current UI and fill `KNOWN_LAYOUT_FAILURES` with what actually fails (expected at least: story card over map buttons at 390×844, "Дальше" scrolled out of view, locate overlapping "−", offline notice over header/panel). Do not fix anything in this phase.
- Commit: `test(e2e): матрица инвариантов раскладки и стабильные data-хуки`.

### 1. Tooling and the global CSS foundation

- Dev dependencies (approved): `stylelint`, `stylelint-config-standard`, `stylelint-config-css-modules`, `prettier`. Only built-in Stylelint rules — no custom plugins.
- `stylelint.config.mjs` — rules and their per-file exceptions (`overrides`):
  - `color-no-hex`, `color-named: "never"`, `function-disallowed-list: ["env", "rgb", "rgba", "hsl"]` everywhere except `src/styles/tokens.css` (colors and safe areas exist only as tokens; `color-mix()` on tokens is allowed).
  - `declaration-property-value-allowed-list`: `z-index` only `var(--z-*)` / `auto`; `font-size` only `var(--text-*)`, `inherit`, or `clamp(…)` built from tokens.
  - `declaration-property-value-disallowed-list`: `position: fixed` outside `src/features/shell/**` and `src/features/navigation/**`.
  - `unit-disallowed-list`: `vh`, `svh`, `dvh`, `lvh`, `vw` outside `src/features/shell/**` and `src/styles/base.css`.
  - `media-feature-name-allowed-list`: `prefers-reduced-motion`, `hover`, `pointer` everywhere; width/height/orientation features only in `src/features/shell/map-shell.module.css` and `src/features/admin/**`. Everything else adapts through container queries and intrinsic sizing.
  - `selector-disallowed-list`: `/\.leaflet-/`, `/\.maplibregl-/` outside `src/features/explore/explore-map.module.css`.
  - `declaration-no-important` except the reduced-motion block in `base.css`.
  - `overrides` entry "legacy-unmigrated": the list of current global `.css` files with these rules turned off. The same list goes into `.prettierignore`. Each later phase deletes entries together with the files.
- `.prettierrc.json` (defaults) and `.prettierignore` (everything except `src/**/*.css`, minus the legacy list). `package.json`: `lint` → `eslint && stylelint "src/**/*.css" && prettier --check "src/**/*.css"`; add `format:css`.
- Split `globals.css`:
  - `src/styles/tokens.css` — first line declares `@layer reset, base, ui;`. `:root` tokens: existing color/type/space/radius tokens; new `--safe-top|right|bottom|left` (the only place `env()` appears); layout tokens `--shell-gutter: 0.75rem`, `--shell-gap: 0.5rem`, `--nav-h: 4.875rem`, `--nav-offset: max(var(--shell-gutter), var(--safe-bottom))`, `--nav-clearance: calc(var(--nav-offset) + var(--nav-h) + var(--shell-gap))`, `--sheet-w: 26.25rem`, `--island-w: min(26.875rem, 100% - 2 * var(--shell-gutter))`, `--map-min-free: clamp(4.5rem, 30dvh - 6rem, 12rem)`; z-index scale `--z-map`, `--z-map-ui`, `--z-sheet`, `--z-nav`, `--z-overlay`; semantic map-UI tokens (`--surface-island`, `--border-island`, `--shadow-island`, `--route-line`, `--user-position`) that collapse the near-duplicate hex values of `explore.css`.
  - `src/styles/base.css` — `@layer reset { … }` and `@layer base { … }`: reset, element defaults, focus ring, reduced-motion block, body safe-area side padding for content pages.
  - `src/styles/ui.css` — `@layer ui { … }`: the `.ui-*` primitives and `.app-header` from `surfaces.css` (they are genuinely global). Delete `surfaces.css` and its two imports.
  - `src/styles/legacy.css` — the remaining editorial / classic walk / generator rules moved verbatim and **unlayered**, in the legacy ignore list until phase 7 deletes it.
  - `src/app/layout.tsx` imports `tokens.css`, `base.css`, `ui.css`, `legacy.css` in this order and nothing else imports global CSS. Delete `globals.css`.
- `src/app/layout.tsx`: `export const viewport: Viewport = { viewportFit: "cover" }` (see `node_modules/next/dist/docs/.../generate-viewport.md`; keep existing width/scale defaults).
- `src/features/ui/cx.ts`: `cx(...parts: Array<string | false | null | undefined>): string` with a table-driven unit test.
- Vitest: decide and configure how CSS Modules resolve in tests (`test.css.modules.classNameStrategy`); verify what `styles.x` returns in both `node` and `jsdom` tests. Tests must not depend on the generated names (decision 14).
- Replace the regex tests: delete `explore-layout.test.ts` and `design-tokens.test.ts`; in `brand-mark.test.ts` keep only behavior assertions and a token-parity check between `public/update.css` and `src/styles/tokens.css` (the mirror is manual, so the check is meaningful).
- Verify with `pnpm build` that the emitted CSS keeps the layer order (`reset, base, ui`) and that Leaflet/MapLibre CSS is unaffected.
- Commits: `chore(lint): подключить Stylelint и Prettier для CSS`; `refactor(styles): разнести глобальные стили на слои tokens/base/ui`; `feat(layout): включить viewport-fit=cover и токены безопасных зон`.

### 2. Shell primitives, map refactor, navigation

New directory `src/features/shell/`:

- `map-insets.ts` — pure: `insetsFromRects(map: RectLike, free: RectLike): MapInsets` where `MapInsets = { top: number; right: number; bottom: number; left: number }` (integers, clamped to ≥ 0), and `fitBox(size: {x: number; y: number}, insets: MapInsets, min: {x: number; y: number}): MapInsets` which widens a too-small free box around its center to the minimum so the fit area is never negative. Table-driven tests in `map-insets.test.ts` (normal, zero-size, free box outside the map, free box smaller than minimum).
- `use-map-insets.ts` — `useMapInsets(map: RefObject<HTMLElement | null>, free: RefObject<HTMLElement | null>): MapInsets`. `ResizeObserver` on both elements plus `window` `resize`; updates state only when a value changes by ≥ 1px; disconnects on unmount. No breakpoints, no CSS custom property reads.
- `map-shell.tsx` + `map-shell.module.css` — `MapShell({ label, map, header, controls, notices, sheet }: { label: string; map: ExploreMapProps without insets/ref/onStatus/onZoomLimits; header: ReactNode; controls?: ReactNode; notices?: ReactNode; sheet?: ReactNode })`. Owns `<main>`; renders `ExploreMap` as the full-bleed background and a frame (`pointer-events: none`, islands re-enable them) with regions `header`, `attribution` + `controls` (one row), `free` (empty measuring cell), `dock` (contains `notices` and `sheet`, bottom-anchored). Frame padding: `max(gutter, safe-*)` on top and sides, `--nav-clearance` at the bottom.
  - Stack mode (default): one column; rows `minmax(0, auto)` header, `auto` controls, `minmax(var(--map-min-free), 1fr)` free, `minmax(0, auto)` dock. The dock is a flex column with the sheet as `flex: 0 1 auto; min-height: 0`, so an oversized sheet shrinks and scrolls internally instead of pushing anything. Header and sheet islands use `--island-w`, centered.
  - Side mode: the single media query from decision 9 switches `grid-template-areas`/columns only: header, controls row and free cell in the main column; dock spans all rows in the right column.
  - With no sheet and no notices the dock collapses and the free cell takes the whole remaining area (`data-sheet="none"`).
  - Compact density: the same module sets density tokens (`--sheet-pad`, `--sheet-gap`, `--sheet-title`, control sizes never below 44px) for short heights. Feature modules read tokens; if a structural change is needed they use `@container shell (…)` — the frame is `container-type: size; container-name: shell`, the sheet is `container-type: inline-size; container-name: sheet`.
  - Holds the `ExploreMap` handle and status, renders `MapControls`, `MapAttribution`, and `MapStatusNotice` (first item of the notices region).
- `sheet.tsx` + `sheet.module.css` — `Sheet({ label, header, footer, children, bodyLabel }: { label: string; header?: ReactNode; footer?: ReactNode; children?: ReactNode; bodyLabel?: string })`. `<section data-region="sheet" aria-label>` as a flex column filling at most its track; header and footer `flex: none`; body `flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain` with the existing fade mask and thin scrollbar moved from `.around-story-scroll` (keep the longhand animation properties and the comment explaining why). When the body overflows it is focusable (`tabIndex=0`, `role="region"`, `aria-label={bodyLabel}`) — detect overflow with a `ResizeObserver`. Footer holds one row of primary/secondary actions; anything else belongs to the body. Budget to respect: at 568×320 the sheet track is about 218px tall, so header + footer must fit in roughly 150px at compact density.
- `map-controls.tsx` + module — `MapControls({ zoom, children }: { zoom: { zoomIn(): void; zoomOut(): void; canZoomIn: boolean; canZoomOut: boolean }; children?: ReactNode })` renders the zoom pair (`aria-label` "Приблизить" / "Отдалить", disabled at the limits) and screen-provided buttons; export `MapControlButton` (44×44 minimum, shared island look).
- `map-attribution.tsx`, `map-status-notice.tsx` — the three attribution links and the two existing Russian status texts ("Загружаем карту…" / "Карта не загрузилась…", "Карта требует интернета…"), `role="status"`.

`src/features/explore/explore-map.tsx` + new `explore-map.module.css` (delete `map-dots.css`):
- Props: replace `routePadding` with `insets?: MapInsets`; add `ref?: Ref<MapHandle>` with `MapHandle = { zoomIn(): void; zoomOut(): void }`, `onZoomLimits?(limits: { canZoomIn: boolean; canZoomOut: boolean }): void`, `onStatus?(status: { phase: "loading" | "ready" | "failed"; tilesOffline: boolean }): void`. The component renders only the map container — no loading text, no attribution, no Leaflet zoom control.
- View policy: keep a "user moved the view" flag set by Leaflet user-originated `dragstart` / `zoomstart` (ignore events fired inside the component's own `setView` / `fitBounds` / `panBy` calls). Focus is always centered in the free box (remove `panBy([0, 80])`). Route fit uses `fitBox(...)` plus a constant marker allowance (pin height on top, 24px on the sides). When `insets` change: re-apply the last focus/fit only if the user has not moved the view. A new `geometry` or a new `focus` resets the flag. Existing behaviors stay: `viewState` save/restore, marker reuse by id, WebGL fallback, the `safeBasemapLayer` patch, error handling of failed dynamic imports.
- Styles: marker looks come from the module (`styles.pin`, `styles.dot`, `styles.userPosition`); this is the only file allowed to use `:global(.leaflet-…)`. Route and accuracy colors are read from tokens once at map creation (`getComputedStyle(container).getPropertyValue("--route-line")`) instead of hex literals.
- Update `explore-map.test.ts` / `explore-map-markers.test.ts` to the new props and `data-marker` hooks; add tests for the view policy (fit on new geometry; no refit after a user zoom when insets change; refit when the user has not moved; fit box never negative).

Navigation (`app-navigation.tsx`, new `app-navigation.module.css`, delete `app-navigation.css`):
- Both render sites stay (the embedded one is needed for the `onWalk` / `onNearby` handlers) but share one look: fixed island, `height: var(--nav-h)`, `bottom: var(--nav-offset)`, `width: var(--island-w)`, centered with `margin-inline: auto` (no `transform`), `z-index: var(--z-nav)`. Remove the `embedded` positioning variant, the double safe-area and the landscape transform reset.
- Rewrite `app-navigation.test.ts` to behavior assertions (rendered items / active section through the DOM) instead of source regexes.

Commits: `feat(shell): каркас MapShell, Sheet и расчёт свободной области карты`; `refactor(map): собственные кнопки масштаба и политика вписывания по свободной области`; `refactor(navigation): единый фиксированный остров навигации`.

### 3. Home screen on the shell

- Split `around-screen.tsx` rendering into small components in `src/features/explore/` (state and handlers stay in `AroundScreen`): `around-header.tsx` (brand, search toggle, search form), `location-prompt-sheet.tsx`, `story-sheet.tsx`, `place-sheet.tsx`, `nearby-sheet.tsx`, `map-hint.tsx`, each with its own module and each built on `Sheet` (title block → header; story text / list → body; primary button and the "Создать прогулку отсюда" link → footer). Geo message, map hint and the update link go to the `notices` slot.
- `AroundScreen` returns `<MapShell header=… controls={locate button} notices=… sheet=… />`; the sheet is chosen in React (creation sheet **or** one of the cards), so the `:has(.creation-panel)` hiding rules disappear.
- The search form expands inside the header island; the header track is bounded, so a long form scrolls inside the island rather than covering the sheet.
- Delete `explore.css` and `place-heading.css`; remove their entries from the legacy ignore lists.
- Remove the fixed entries from `KNOWN_LAYOUT_FAILURES`; port the home-related geometry tests of `interface.spec.ts` to roles / `data-*` hooks and delete those now covered by the invariants matrix.
- Commit: `refactor(explore): перевести стартовую карту на MapShell и CSS Modules`.

### 4. Walk creation as a sheet

- `walk-creation-panel.tsx`: render through `Sheet` (header: title + close; body: form / preview; footer: actions), styles in `walk-creation-panel.module.css`. Remove `padding` from `CreationMap`, the rect measurement and the `innerWidth`/`innerHeight` logic; the map gets its insets from the shell. `is-picking` / `is-preview` become module classes selected via `cx`.
- Delete the 7 unused classes (after verification) and `walk-creation-panel.css`.
- Replace the "panel is horizontally centered" e2e geometry tests with the matrix (in side mode the panel is a right column — intended change, decision 3). Update `walk-creation-panel.test.ts` hooks.
- Commit: `refactor(walk-builder): панель создания прогулки как Sheet в MapShell`.

### 5. Walk session on the shell

- `walk-session.tsx` renders `MapShell`: header (brand, search link, close — all still call `onStop()`), locate button in `controls`, offline notice and other notices in `notices`, one `Sheet` with header (stop title, compact player row, tool toggles), body (the open drawer content — the only scroll area), footer ("Начать" / "Дальше" / "Завершить"). At compact density the header collapses to a single row so the body invariant (≥ 48px) holds at 568×320.
- Remove `cover` measurement, the padding literals and `--walk-panel-dock`. `tour-experience.tsx` stops switching `<main>` class names: the universal branch delegates the whole frame to `WalkSession`/`MapShell`.
- `walk-screen.tsx`: `walk-offline-notice--map` is passed into the shell's `notices` slot instead of being `position: fixed`.
- Styles to `walk-session.module.css`; delete `walk-session.css`. Port `e2e/walk-session.spec.ts` helpers to the new hooks; drop geometry checks now covered by the matrix, keep behavior checks (playback, drawers, finish, audio failure).
- Commit: `refactor(tour): прохождение прогулки на MapShell с фиксированным действием`.

### 6. Content pages

- `walks/history.css`, `walks/walks.css`, `account/account.css`, `auth/auth.css` → modules next to `walk-library.tsx`, `walk-screen.tsx`, `account.tsx`, `login.tsx`; `AppHeader` keeps the global `.app-header` primitive from `ui.css`.
- Bottom spacing uses `--nav-clearance` instead of `140px` / `120px` / `5rem` / `8rem`; top and side spacing include the safe-area tokens. Replace width media queries with container queries on the page container (`.ui-page` becomes `container-type: inline-size; container-name: page`) or intrinsic grids.
- Delete unused `.walk-library*` and `.account-*` classes after verification. Update `walk-library.test.ts` hooks.
- Commit: `refactor(pages): страницы истории, профиля и входа на CSS Modules`.

### 7. Legacy editorial and generator

- Move `src/styles/legacy.css` 1:1 into modules next to their components: `classic-walk-view`, `story-generator`, `route-notes`, `story-content`, `audio-player-controls`, `walk-diagnostics`, `offline-copy`, `walk-plan`, `catalog-tour`, `brand-mark`, `walk-map` (inset map: local `MapControls`, `MapAttribution`, `MapStatusNotice` around `ExploreMap` with zero insets; no `.leaflet-*` overrides). The dark walk theme stays a token override block on the classic view root (`--walk-*`), owned by that module.
- This is a mechanical move: no redesign; the only intended visual fixes are leaks that scoping removes (e.g. `.story-text{margin-top}`). Convert raw colors/sizes to tokens as required by Stylelint. `signalTone(...)` and `statusClassName` return keys looked up in the module.
- Delete `legacy.css` and its layout import. Commit: `refactor(tour): классический режим и генератор на CSS Modules`.

### 8. Admin

- `admin.css`, `content-admin.css`, `walk-admin.css` → modules next to `admin-desk.tsx`, `content-admin.tsx`, `walk-admin.tsx`, `identity-candidates.tsx`, `batch-item-detail.tsx`, `table-skeleton.tsx`; remove the import from `app/admin/page.tsx`. Dynamic state classes become explicit lookups (`styles[stageClass[item.stage]]` with a typed map — unknown values fall back to a neutral style, never to `undefined`).
- Admin keeps width media queries (allowed by the Stylelint override) and its desktop-first layout; no redesign.
- Update the four admin jsdom tests to roles / `data-*` hooks (e.g. skeleton rows via `aria-busy` or `data-skeleton-row`).
- Commit: `refactor(admin): стили админки на CSS Modules`.

### 9. Cleanup and documentation

- The legacy ignore lists in `stylelint.config.mjs` and `.prettierignore` are empty and removed; `KNOWN_LAYOUT_FAILURES` and the `test.fail()` mechanism are removed; no global CSS import exists outside `app/layout.tsx` (third-party map CSS in `explore-map.tsx` excepted).
- Rewrite the layout sections of `DESIGN.md` (Russian): the two modes, regions, sheet anatomy, navigation island, tokens, the rule "feature CSS never positions against the viewport".
- Add `docs/agents/layout-architecture.md` (Russian): how to add a screen or a sheet, what Stylelint forbids and why, how to run and extend the invariants matrix; list it in `docs/agents/README.md` with a two-sentence description. Mark the superseded sections of `story-card-scroll.md`, `walk-map-session.md`, `map-walk-creation.md` and strike the defects that are now fixed.
- Update `public/update.css` only if token values changed (it stays a manual mirror, guarded by the parity test).
- Update this plan's `Status:` line. Commit: `docs(layout): описать архитектуру раскладки и обновить DESIGN.md`.

## Testing & verification

- **Unit (Vitest):** `map-insets.test.ts` (table-driven), `cx.test.ts`, `ExploreMap` view-policy tests, sheet overflow/focusability test (jsdom), navigation behavior test, token parity `public/update.css` ↔ `tokens.css`. No test reads CSS text or selects by class.
- **Static:** `pnpm lint` (ESLint + Stylelint + Prettier check) and `pnpm typecheck` on every commit; `pnpm check` (includes `pnpm build`) at the end of every phase.
- **E2E:** `pnpm test:e2e` at the end of every phase. `layout-invariants.spec.ts` is the acceptance gate: all screens × states × viewports on Chromium (plus safe-area variants through CDP) and the reduced set on WebKit, with `KNOWN_LAYOUT_FAILURES` empty at the end. Existing behavior specs (`interface`, `walk-session`, `navigation`, `offline-walk`) keep passing after being ported to stable hooks. If another session's dev server is running, run e2e from a separate worktree.
- **Defects that must be gone by construction** (from `docs/agents/story-card-scroll.md`): story card covering map buttons at 390×844; "Дальше" scrolling out of view; panel covering map buttons on small portrait phones; map re-fitting and resetting the user's zoom on panel resize; negative fit area; locate overlapping "−"; `.walk-offline-notice--map` over the panel; `bottom: 108px` without safe-area.
- **Manual, after phases 3, 5 and 9:** open the dev server via `.claude/launch.json` (`next-dev`) and check home, creation, walk session at 390×844, 667×375 and 1440×900; attach screenshots to the report.
- **Needs the user (cannot be automated here):** a check on a real iPhone, both in Safari and as the installed PWA — `viewport-fit=cover` with `black-translucent` is only verified by emulation math; also the on-screen keyboard with the search field open.
- No paid or external APIs in tests: map tiles, geocoding and `/api/*` stay mocked as in the existing specs.

Risks to report to the user
- The desktop / landscape look changes (panel as a right column instead of a centered card) — intended by decision 3, documented in `DESIGN.md`.
- E2E runs against `next dev`, while Next documents that CSS ordering can differ in a production build. Modules and layers remove most order dependence, but nothing automated checks the export. **Proposal awaiting approval:** make the Playwright `baseURL` configurable and run the invariants spec once against the static export in `pnpm check`.
- Parallel sessions editing `explore.css`, `explore-map.tsx` or `package.json` will conflict with phases 1–3; coordinate or use a dedicated worktree.
- CSS Modules behavior in Vitest and `@layer` output under Turbopack must be verified in phase 1 before building on them.

## Out of scope

- A draggable / snap-point bottom sheet, gestures, sheet animations.
- Tailwind, CSS-in-JS, a component library, design changes to colors or typography.
- Moving the demo walk from the classic dark view to `WalkSession`; redesigning admin or the generator.
- Screenshot-baseline (pixel) regression infrastructure — screenshots stay test attachments only.
- Running e2e against the production export and any CI setup (proposed above, not approved).
- Migrating `public/update.html` / `update.css` into the bundle.
- The Next.js warning about `scroll-behavior: smooth`, privacy text, and other non-layout defects listed in `docs/agents/story-card-scroll.md`.
- New AGENTS.md gotchas (propose wording to the user separately if one turns out to be necessary).

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
