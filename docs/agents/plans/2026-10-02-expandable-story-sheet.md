# Plan: Expandable story card on the map (peek ↔ full-screen reading)

Status: implemented 2026-10-02 in branch `feat/promo-walks-stories-only`. Divergences are listed under "Implementation notes" at the end.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

The story card on the home map (`StorySheet`) is a shared `Sheet` with one scrolling body squeezed between a fixed photo/header and a fixed footer (player + main action). On phones the dock leaves the text a small window: `docs/agents/story-card-scroll.md` (measured 2026-09-28, before the `Sheet` refactor) reports 86–146 px of visible text on 360×640–390×700, i.e. 3–4 lines, with a fade mask and a custom scrollbar on top. Reading a long story in that window is poor, and on 390×844 a long card rises to ~150 px from the top and covers the map controls and the selected marker (listed under "Найденные дефекты" in the same doc).

The user wants the Yandex Maps pattern: the card itself never scrolls; tapping it (or swiping its handle up) slides it up to a full-screen reading view over the map, where the whole card scrolls like a page; swiping/tapping the handle down or pressing Back returns to the peek.

No external services or APIs are involved.

## Approved decisions

1. **Interaction model (user's choice, "option 3").** Exactly two states: *collapsed* (peek) and *expanded* (full-screen reading). Toggled by a tap on the handle, a tap on the peek text, and a vertical swipe on the handle (up expands, down collapses). No intermediate snap point, no live finger-following drag, no swipe on the text itself.
2. **Scope.** Only `StorySheet` on the home map, and only for *expandable* stories: catalog places and stories that have text (`paragraphs`). Walk-chapter cards, stories still being prepared, `PlaceSheet`, `NearbySheet`, `LocationPromptSheet`, `WalkCreationPanel` and the walk session panel (`/walk`) keep today's behaviour. (Recommended in chat and accepted with "пиши план".)
3. **Portrait phones.** The expanded card covers the whole screen, including the header, the map controls, the notices and the bottom navigation. The player and the main action stay pinned at the bottom of the card.
4. **Peek content.** Collapsed: photo, title, address, status/error lines, a teaser (the first paragraph, at most 3 lines), player and main action. "Создать прогулку отсюда", sources, attribution and the editorial note are shown only when expanded.
5. **Back button.** Expanding adds a browser history entry *without changing the URL*; Back (including the Android system back) collapses the card instead of leaving the page. Escape collapses too. A link or a reload never opens the card expanded.
6. **Wide screens and landscape phones.** Instead of covering the whole screen, the card takes the full height of its usual column (right column in the side layout, centered column on tall wide screens). The rest of the map is dimmed by a scrim; a click on the scrim collapses the card.
7. **Animation.** View Transitions API (`document.startViewTransition`) so the card visibly slides up and down. With no support or with `prefers-reduced-motion: reduce`, the state switches instantly.

## Key codebase facts

- `src/features/explore/around-sheets.tsx` — `StorySheet` (around line 33). A catalog pin is `placeId !== undefined && chapter === undefined && jobId === undefined`; its text, sources and audio come from `usePlaceStory(placeId)` (`place-story.ts`). The current layout: `media` = `PlacePhotoBanner` (catalog only), a label row in `header` when a label exists (walk part / job progress), otherwise the close button goes to `corner` and the title scrolls in the body; `footer` = `StoryAudioPlayer` + action ("Слушать эту часть" or retry); the body holds title, address, status lines, paragraphs (`styles.story`), attribution, sources `<details>`, the "verified text is on the place card" note, and `WalkFromHere` (body action).
- `StoryAudioPlayer` (`src/features/tour/story-audio-player.tsx`) owns a hidden `<audio>` and pauses it on unmount; it is keyed by `content.audioUrl`. **Any approach that remounts the footer (portal, `<dialog>`, a separate expanded component) stops playback.** Expansion must be the same React elements with a different layout.
- `src/features/explore/story-pin.ts` — `StoryPin` type (fields `placeId`, `jobId`, `chapter`, `paragraphs`, `progress`, `pending`, …). Walk-chapter pins built in `around-screen.tsx` (`pins` memo) have no `paragraphs` and no `audioUrl`.
- `src/features/shell/sheet.tsx` — generic `Sheet`: slots `media`, `corner`, `header`, body (`children`), `footer`; `data-sheet={name}`, `data-region="sheet"`, `data-sheet-part` on each part; body gets `tabIndex=0` only when it actually scrolls (ResizeObserver). Only `StorySheet` uses `corner` (verified by grep).
- `src/features/shell/sheet.module.css` — `.sheet` is a flex column with `overflow:hidden`, `max-height:100%`; `.body` is the only scroller (thin scrollbar, `::-webkit-scrollbar` styling under `(hover:hover) and (pointer:fine)`, scroll-driven fade mask written with longhand animation properties because LightningCSS expands the shorthand with `animation-duration:0s` — see `story-card-scroll.md`). With media present, `.body` has `flex-shrink:1000; min-height:6rem` so text yields before the photo. `.corner` is absolutely positioned and raised with `--z-raise`.
- `src/features/shell/map-shell.tsx` + `map-shell.module.css` — "the only place that knows the screen size". Grid `.frame` (`container: shell / size`, `pointer-events:none`) with areas `top`, `free`, `dock`; `.attribution` absolute at the top-right; `.dock` is a bottom-anchored flex column with notices + the sheet. Three modes: stack (default, phones), side column (`(width >= 700px), (width >= 568px) and (height <= 560px)`), centered column (`(width >= 700px) and (height > 560px)`). Frame bottom padding is `--nav-clearance` (tokens.css). Short screens (`height <= 560px`) get denser `--sheet-pad`/`--sheet-gap`.
- `src/features/shell/use-map-insets.ts` — measures the `.free` cell with a ResizeObserver + window resize and returns `MapInsets`; `explore-map.tsx` passes them to `view.setInsets()` (`map-view.ts`), which **re-applies the requested view whenever the insets change, unless the user moved the map**. Hiding/collapsing the free cell during expansion would therefore re-centre the map — insets must be frozen while expanded.
- `src/features/navigation/navigation-visibility.ts` — `useHideNavigation(hidden)` hides the bottom navigation (counter-based, layout effect); `AppNavigation` (rendered `embedded` by `AroundScreen` on `/`) returns `null` while hidden. Reuse it; do not add another mechanism.
- Tokens (`src/styles/tokens.css`): `--z-map:0`, `--z-map-ui:10`, `--z-sheet:20`, `--z-nav:30`, `--z-overlay:40`; `--safe-*` insets; `--control-min: 2.75rem` (44 px, the minimum hit target enforced by the layout matrix).
- `src/features/explore/around-screen.tsx` — owns `selected`, builds `sheet` with the precedence: `creating` → `WalkCreationPanel`; geo prompt (only without `active`) → `LocationPromptSheet`; `active` → `StorySheet`; then place/nearby. `onClose` of the story sets `selected` to `undefined`. `WalkFromHere` is a `next/link` to `/?walk=create…` with `onClick={rememberOpener}`; the screen stays mounted when `?walk=create` toggles.
- Next 16 history integration (`node_modules/next/dist/client/components/app-router.js`, ~lines 84–300; docs: `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`, "Native History API"): the patched `history.pushState(data, "", url?)` copies Next's internal `__NA` and tree into `data` when `data` lacks `__NA`, and only touches the router URL when `url` is given. Its `popstate` handler **reloads the page if `event.state` lacks `__NA`**, so always push a fresh object (e.g. `{ [KEY]: id }`) and let Next copy its internals; never push `null` or a hand-built state without them. When stripping a key with `replaceState`, pass the rest of the current state (it still has `__NA`, so Next passes it through unchanged).
- `src/features/explore/place-photo.tsx` — the photo banner is a button that opens a modal `<dialog>` viewer with its own Escape handling; Escape handling for the sheet must ignore events coming from inside an open `<dialog>`.
- `src/features/walk-builder/walk-creation-panel.tsx:41` registers its own window `keydown` Escape handler; the two never coexist (different sheets), but keep the sheet handler active only while expanded.
- React 19.2 types support the boolean `inert` prop; TypeScript 5.9 `lib.dom` has `document.startViewTransition`. `flushSync` comes from `react-dom`.
- E2E that depend on the current inner scroll and must be rewritten: `e2e/interface.spec.ts` "длинная история прокручивается внутри карточки…" (fade `--fade-top/--fade-bottom`, End key on the body) and "длинная история не заходит на кнопки карты …" (asserts the body scrolls). Tests that locate text via `getByRole("region", { name: "Текст истории" })` (`map-catalog.spec.ts`, `place-photo.spec.ts`, `e2e/support/scenarios.ts` `openLongStory`) must keep working — keep the body region name in both states. `place-photo.spec.ts` "фото и заголовок помещаются в экран …" requires the photo ≥ 44 px tall inside the sheet on 320×568, 844×390, 1440×900.
- Layout matrix: `e2e/layout-invariants.spec.ts` + `e2e/support/layout.ts` (`SCREEN_STATES` in `e2e/support/scenarios.ts`, state "карта / длинная история" with `{ map: true, focus: "marker" }`). Invariants include `footer` (sheet footer fully visible), `target` (≥44×44, hit-testable), `overlap`, `viewport`, `hscroll`. `KNOWN_LAYOUT_FAILURES` must only shrink.
- Commands: `pnpm check` (lint incl. stylelint/prettier for CSS, typecheck, vitest + backend tests, Python tests, build) and `pnpm test:e2e`. `next dev` cannot run twice in one folder — stop the preview server or use a separate worktree (see `story-card-scroll.md`, "Особенности окружения"). Playwright Chromium needs `hasTouch: true` for `pointer:coarse` rules.
- This branch is shared with parallel sessions: the working tree may contain other sessions' uncommitted changes (e.g. `walk-session.*`, `e2e/support/scenarios.ts`). Commit only your own hunks.

## Implementation

### 0. Preparation

- Read the Next 16 "Native History API" section named above and re-verify the `app-router.js` pushState/popstate facts against the installed version.
- Run `git status`; note foreign changes and leave them alone.

### 1. Swipe recognition — `src/features/shell/sheet-swipe.ts` (new, pure)

- `export type Swipe = "up" | "down" | null;`
- `export function readSwipe(move: { dx: number; dy: number; ms: number }): Swipe` — vertical intent of a finished pointer gesture on the handle:
  - `null` when `|dx| > |dy|` (horizontal) or `|dy| < 12`;
  - a swipe when `|dy| >= 32`, or when `|dy| >= 12` and `|dy| / max(ms, 1) >= 0.4` px/ms (flick);
  - direction by the sign of `dy` (negative = up).
- `export const TAP_SLOP_PX = 10;` — movement beyond this in any direction is a gesture, never a tap.
- Constants live in this file only.

### 2. Handle control — `src/features/shell/sheet-handle.tsx` + `sheet-handle.module.css` (new)

- `export function SheetHandle(props: { expanded: boolean; onExpand: () => void; onCollapse: () => void; controls: string; expandLabel: string; collapseLabel: string })`.
- Renders one `<button type="button">` with `aria-expanded`, `aria-controls={controls}`, `aria-label` = expand/collapse label. Visual: a pill (~36×4 px, `--map-muted`-ish, drawn with `::before`) inside a hit area of at least `--control-min` tall and ~6rem wide. Over a photo the pill needs contrast (light pill with a shadow) — style via the sheet's media presence (`:has`) or a prop-free CSS rule in the sheet.
- Pointer logic: `pointerdown` → `setPointerCapture`, remember `{x, y, t}`; `pointerup` → if the movement exceeded `TAP_SLOP_PX`, mark the following `click` as suppressed and apply `readSwipe` (up → `onExpand` only when collapsed; down → `onCollapse` only when expanded); `pointercancel` → reset. `click` (also from Enter/Space) toggles unless suppressed.
- CSS: `touch-action: none` on the button so the browser does not pan/scroll during the swipe; focus ring via `--focus-ring`; `cursor: pointer`.

### 3. Sheet: handle slot and expanded layout — `src/features/shell/sheet.tsx`, `sheet.module.css`

- New props: `handle?: ReactNode` (the expand/collapse control) and `expanded?: boolean`. Add `id?: string` on the section if `aria-controls` needs it (or let `StorySheet` pass an id).
- Data attributes: `data-expandable` when `handle` is given, `data-expanded` when `expanded`.
- Chrome row: when `corner` or `handle` is present, render first a `<div className={styles.chrome} data-sheet-part="chrome">` containing `<div data-sheet-part="handle">` (top center) and the existing `<div data-sheet-part="corner">` (keep this attribute — `e2e/support/layout.ts` checks it). `.chrome` is `position: sticky; top: 0; height: 0; z-index: var(--z-raise)` with `margin-bottom: calc(-1 * var(--sheet-gap, 0.75rem))` so it takes no room; handle and corner are absolutely positioned inside it (re-base the current `.corner` offsets from the sheet edge to the chrome). Without `corner`/`handle` nothing is rendered (the existing "header, body, footer" order test must still pass).
- **Collapsed expandable** (`[data-expandable]:not([data-expanded])`): the body never scrolls — `overflow: hidden`, `min-height: 0`, a static bottom fade (`mask-image` linear gradient, no scroll-driven animation) and it yields first (`flex-shrink` high); the media yields second (`flex-shrink: 1; min-height: 0`). Override the existing `.sheet:has(> .media) > .body { flex-shrink:1000; min-height:6rem }` for this state. Header and footer never shrink. Result: the card can only lose teaser lines and then photo height, never the title or the footer, and never shows a scrollbar.
- **Expanded** (`[data-expanded]`): the sheet itself becomes the scroller — `overflow-y: auto; overscroll-behavior: contain`, same thin scrollbar styling as `.body` (extract the scrollbar rules so both selectors share them; keep the `(hover:hover) and (pointer:fine)` + `@supports selector(::-webkit-scrollbar)` guard and the longhand-animation rule); `.body` gets `flex: none; overflow: visible; mask: none; animation-name: none` and no scrollbar gutter offsets; `.media` gets `flex: none` (full height, scrolls away); `.footer` becomes `position: sticky; bottom: calc(-1 * var(--sheet-pad))` with the card background, a top border (`--border-island`) and bottom padding `max(var(--sheet-pad), var(--sheet-inset-bottom, 0px))`; the sheet's top padding adds `var(--sheet-inset-top, 0px)` and side paddings respect `--sheet-inset-left/right`. Border radius/border/shadow come from `--sheet-radius` etc. set by the shell (see step 5), defaulting to today's island look.
- `view-transition-name: map-sheet` on `[data-expandable]` (MapShell shows at most one sheet, so the name is unique).
- The `scrollable` measurement keeps watching the body; in the expanded state the body does not scroll, so it drops out of the tab order — the sheet scroller is reached by keyboard through its focusable children (handle, links, buttons) and arrow keys scroll the nearest scrollable ancestor.

### 4. Expansion state and history — `src/features/shell/use-expandable-sheet.ts` (new)

- `export function useExpandableSheet(key: string | undefined): { expanded: boolean; expand(): void; collapse(): void; dismiss(options?: { keepHistoryEntry?: boolean }): void }`.
  - `key` identifies the expandable content (the story id) or is `undefined` when nothing expandable is shown; when it changes, `expanded` resets to `false` without touching history (a programmatic change of the selected story while expanded is not reachable from the UI — the scrim blocks the map and the navigation is hidden; the leftover entry would cost one no-op Back press, documented, not handled).
  - `expand()`: `history.pushState({ [HISTORY_KEY]: key }, "")` (no URL argument; `HISTORY_KEY = "otgolosokSheet"`), then sets `expanded` inside the transition helper.
  - `collapse()` (animated): if `history.state?.[HISTORY_KEY] === key`, call `history.back()` and let `popstate` collapse; otherwise collapse locally.
  - `dismiss()` (instant, used right before the card closes): same history rule as `collapse()` but without animation; `dismiss({ keepHistoryEntry: true })` only resets local state (used before following an in-app link that pushes its own entry — calling `history.back()` there would race with the navigation).
  - `popstate` listener: `expanded = event.state?.[HISTORY_KEY] === key` (animated). This makes Back collapse and Forward re-expand; returning from `/?walk=create` to the marker entry re-opens the card expanded, which is intended.
  - On mount: if `history.state` carries `HISTORY_KEY` (reload of an expanded entry), strip it with `history.replaceState(rest, "")` — a fresh screen never starts expanded.
  - Escape: a window `keydown` listener active only while expanded; ignores `event.defaultPrevented` and events whose target is inside `dialog[open]` (photo viewer); calls `collapse()`.
  - Transition helper (module-private): if `document.startViewTransition` is missing or `matchMedia("(prefers-reduced-motion: reduce)").matches`, apply the update directly; otherwise `document.startViewTransition(() => flushSync(update))`. If it throws (e.g. `InvalidStateError` for a hidden document) apply the update directly; attach no-op handlers to `transition.ready`/`finished` so expected "skipped" rejections do not surface as unhandled.
- CSS for the animation in `sheet.module.css` (global pseudo-elements via `:global` if CSS Modules require it): `::view-transition-group(map-sheet)` ~250 ms ease-out; the root keeps the default cross-fade.

### 5. Map shell: expanded mode — `src/features/shell/map-shell.tsx`, `map-shell.module.css`, `use-map-insets.ts`

- `MapShell` props: add `sheetExpanded?: boolean` and `onCollapseSheet?: () => void`.
- When `sheetExpanded`:
  - `.frame` gets `data-sheet-mode="expanded"`; the map cell, the top row and the notices get `inert` (keyboard and screen readers stay in the card); the attribution stays interactive where the map is visible.
  - A scrim `<div className={styles.scrim} aria-hidden="true" onClick={onCollapseSheet} />` is rendered between the map and the frame (`position:absolute; inset:0`, z-index between `--z-map` and `--z-map-ui`, `background: color-mix(in srgb, var(--map-green) 35%, transparent)`, `pointer-events:auto`). The frame stays `pointer-events:none`, so clicks outside the sheet reach the scrim.
  - `useMapInsets(mapCell, free, frozen)` — new third parameter `frozen = false`: while frozen the hook neither measures nor updates; when it turns `false` it measures once (the effect re-runs). Pass `sheetExpanded`. The layout returns to the same geometry, `sameInsets` keeps the state, and the map is not re-applied; a real resize during expansion is picked up on unfreeze.
- CSS per mode (all in `map-shell.module.css`, the only file that knows screen sizes):
  - Stack (default): grid becomes a single `"dock" minmax(0, 1fr)` area with `padding: 0`; `.top`, `.free`, `.attribution`, `.notices` → `display: none`; `.dock` full width and its sheet `flex: 1 1 auto`; set on the frame `--sheet-inset-top/right/bottom/left: var(--safe-*)` and the edge-to-edge look (`--sheet-radius: 0`, no border/shadow).
  - Side column (`(width >= 700px), (width >= 568px) and (height <= 560px)`): keep the `"top dock" / "free dock"` grid; hide `.top` and `.notices`; bottom padding becomes `max(var(--shell-gutter), var(--safe-bottom))` because the navigation is hidden; the sheet fills the column height; island look unchanged.
  - Centered column (`(width >= 700px) and (height > 560px)`): grid `"dock" minmax(0, 1fr)`, centered `--island-max` column from the top padding to the bottom gutter; `.top`, `.notices` hidden; attribution stays visible over the scrim.
- Remove nothing from the collapsed layouts; all new rules are scoped to `[data-sheet-mode="expanded"]`.

### 6. StorySheet: peek vs full — `src/features/explore/around-sheets.tsx`, `around-sheets.module.css`, `story-pin.ts`

- `story-pin.ts`: `export function isExpandableStory(pin: StoryPin): boolean` — `true` for a catalog pin (`placeId` set, no `chapter`, no `jobId`) or any pin with non-empty `paragraphs`; `false` otherwise (walk chapters, pending/failed jobs without text).
- `StorySheet` new props: `expanded?: boolean`, `onExpand?: () => void`, `onCollapse?: () => void`. When `isExpandableStory(story)` and the callbacks are given, pass `handle={<SheetHandle … expandLabel="Читать историю полностью" collapseLabel="Свернуть историю" />}` and `expanded` to `Sheet`; otherwise render exactly as today.
- Collapsed expandable:
  - `header`: the label (if any) as plain text plus the title and address (`styles.titleRow` padding when the corner close is used); the close button always goes to `corner` for expandable cards (so it stays reachable in both states).
  - body (`bodyLabel="Текст истории"` kept in both states so tests and screen readers find the text): status/alert lines (loading, load error with «Повторить», missing, progress pending/error, `retryError`) and a teaser = the first paragraph with `line-clamp: 3` (`-webkit-line-clamp` + `display:-webkit-box` fallback). No sources, attribution, note or `WalkFromHere`.
  - Tapping the header heading or the teaser calls `onExpand`, except when the click target is inside `a, button, summary` (e.g. «Повторить», the photo button); `cursor: pointer` on those areas. Keyboard users expand via the handle.
- Expanded: `header` holds only the label text (if any); the body is today's content (heading, status lines, all paragraphs, attribution, sources, note, `WalkFromHere`); footer unchanged; close in the corner.
- The footer element and `StoryAudioPlayer` must be the same elements in both states (same position in the tree, same `key`) — verify by the e2e identity check below.
- Short shells: if the matrix shows the collapsed footer or title clipped on the smallest landscape sizes, add a container query on the shell container (`@container shell (height <= …)`) in `around-sheets.module.css` that hides the address and then the teaser in the collapsed state. Pick the threshold from measurements, not guesses.

### 7. Wiring — `src/features/explore/around-screen.tsx`

- `const storyShown = !creating && Boolean(active);` (mirrors the `sheet` precedence: the geo prompt is only shown without `active`).
- `const reading = useExpandableSheet(storyShown && active && isExpandableStory(active) ? active.id : undefined);`
- `useHideNavigation(reading.expanded);`
- `StorySheet` gets `expanded={reading.expanded}`, `onExpand={reading.expand}`, `onCollapse={reading.collapse}`; its `onClose` becomes `reading.dismiss()` then the current close logic; its `onWalk` becomes `reading.dismiss({ keepHistoryEntry: true })` then `rememberOpener()`.
- `MapShell` gets `sheetExpanded={reading.expanded && storyShown}` and `onCollapseSheet={reading.collapse}`.

### 8. Documentation

- New `docs/agents/story-sheet-expansion.md` (Russian): the two states, history-entry contract (no URL change, Next `__NA` requirement), insets freeze and why, the scrim per mode, swipe thresholds, measured collapsed-card sizes on the matrix, any container-query thresholds chosen. List it in `docs/agents/README.md` with a two-sentence description.
- `docs/agents/story-card-scroll.md`: add a short note at the top that the inner-scroll card now applies only to non-expandable sheets (nearby list, place card, prepared-job progress, walk-creation panel) and link the new doc; update the "Найденные дефекты" bullet about the 390×844 card covering the map controls if the collapsed card fixes it (state the measured numbers).

## Testing & verification

Unit (Vitest):
- `src/features/shell/sheet-swipe.test.ts` — table-driven `readSwipe`: long up, long down, short slow (null), short fast flick, horizontal-dominant (null), exactly at 12/32 px and 0.4 px/ms boundaries, `ms = 0`.
- `src/features/shell/use-expandable-sheet.test.ts` (jsdom; dispatch `PopStateEvent` manually; stub `matchMedia`, leave `startViewTransition` undefined): `expand()` pushes an entry with the key and the URL is unchanged; popstate to a state without the key collapses; popstate to the key re-expands; `collapse()` calls `history.back()` only when the current entry is ours (otherwise collapses locally); `dismiss({ keepHistoryEntry: true })` does not navigate; a key change resets `expanded`; a stale key in `history.state` on mount is stripped via `replaceState`; Escape collapses; Escape from inside an open `<dialog>` does not.
- `src/features/shell/sheet.test.ts` — chrome renders handle and corner parts with their `data-sheet-part`; `data-expandable`/`data-expanded` reflect props; the existing "header, body, footer" order test stays green without corner/handle.
- `src/features/explore/around-sheets.test.ts` — table-driven `isExpandableStory` (catalog → true, ready job with text → true, pending job → false, walk chapter → false); collapsed `StorySheet` renders only the first paragraph and no "Создать прогулку отсюда"/sources, the handle has `aria-expanded="false"` and the expand label, a click on the teaser expands but a click on «Повторить» does not; expanded renders all paragraphs, sources and the walk link with `aria-expanded="true"`; a non-expandable pin renders no handle and keeps today's structure.
- `use-map-insets` frozen behaviour (jsdom, stubbed ResizeObserver and rects): while frozen a resize callback does not change insets; after unfreezing one measurement happens.

E2E (Playwright, Chromium + WebKit where the suite runs both):
- Rewrite `e2e/interface.spec.ts` "длинная история прокручивается внутри карточки…" into "длинная история раскрывается на весь экран" (390×844): collapsed sheet and body have no scroll (`scrollHeight - clientHeight <= 1`), footer fully visible, handle `aria-expanded=false`; the `<audio>` element handle taken before expanding is still connected after expanding and collapsing (no remount); tap on the handle → sheet box equals the viewport, header and navigation are gone, `aria-expanded=true`; scrolling the sheet to the end (keyboard End or `scrollTop`) keeps the close button and the player boxes unchanged; `page.goBack()` collapses the card, the URL is still `/` and the card is still open; Escape collapses; closing with × while expanded and then `goBack()` does not re-open anything (history entry was consumed).
- Swipe: with `page.mouse` (down on the handle, move 80 px up, up) the card expands; 80 px down collapses; a 60 px horizontal drag changes nothing; a short tap toggles. Repeat one swipe case in a `test.use({ hasTouch: true, isMobile: true })` block.
- Rewrite "длинная история не заходит на кнопки карты …" (`shortPortraits`): assert the collapsed body does **not** scroll, and keep the ≥ 8 px gap to «Моё местоположение» and the zoom group.
- New loop over `VIEWPORTS` + safe-area cases: the collapsed long story has no scroll in sheet/body, the title and the whole footer are visible.
- Wide modes: at 1440×900 and 844×390 the expanded card fills its column height, the scrim is visible beside it, a click on the scrim collapses, and the navigation is hidden.
- Map stability: the selected marker's bounding box is the same before expanding and after collapsing.
- Layout matrix: keep "карта / длинная история" (collapsed) and add "карта / развёрнутая история" in `SCREEN_STATES` with options `{}` (the map is intentionally covered). Do not add entries to `KNOWN_LAYOUT_FAILURES` for the new state; fix violations instead.
- Re-run and adapt `map-catalog.spec.ts`, `map-story-job.spec.ts`, `place-photo.spec.ts` (photo ≥ 44 px in the collapsed card on 320×568, 844×390, 1440×900; the photo viewer's Escape must not collapse the card).

Run before committing: `pnpm check`, then the full `pnpm test:e2e` (stop the preview `next dev` first or use a separate worktree). Visual check in the browser pane on 390×844 and 844×390: peek, expand animation, sticky player, Back, swipe; screenshots of both states for the report. No paid external APIs are involved.

## Out of scope

- The walk session panel on `/walk` and its story drawer, `NearbySheet`, `PlaceSheet`, `LocationPromptSheet`, `WalkCreationPanel`.
- Live finger-following drag, an intermediate (half-screen) snap point, swiping on the text to collapse, momentum physics.
- Deep links that open a story expanded; a separate place page/route.
- Removing the fade-mask/scrollbar machinery from `Sheet` — other sheets still use it.
- A wider reading column on desktop.

## Implementation notes (divergences from the steps above)

- **Safe areas (step 3/5).** No `--sheet-inset-*` variables: the layout matrix forbids regions inside safe-area insets, so in the stack mode the expanded frame gets `padding: var(--safe-*)` and `background: var(--surface-island)` (the notch strips look like the card), and the sheet stays inside the safe area. The expanded sheet has `padding-bottom: 0`; the footer is `position: sticky; bottom: 0` as a full-width bar with its own padding.
- **Scrim (step 5).** Marked `data-scrim`, not `data-region` (the layout matrix treats regions as islands and reported scrim/sheet overlap). It uses `z-index: var(--z-map)` and is painted after the map (the stylelint z-index allow-list only accepts `--z-*` tokens).
- **Collapsed body (step 3).** Instead of a static mask the body keeps the existing scroll-driven fade with `overflow: hidden` (still a scroll container), so the fade appears only when the teaser is actually clipped. E2E therefore assert `overflow-y: hidden` on the body and no overflow on the sheet, not `scrollHeight - clientHeight <= 1` on the body. The body is never in the tab order for an expandable sheet.
- **`isExpandableStory` (step 6).** Walk chapters are excluded even if they carry `paragraphs`.
- **Re-expanding after Back from `/?walk=create` (step 4).** Implemented on a key change during render: content that appears while `history.state` carries its key starts expanded; the mount effect strips the key first, so reloads still start collapsed.
- **Photo (user request during implementation).** In the expanded card the place photo is shown whole in its original aspect ratio, capped at 4:5 for portrait photos (cropped around the middle; `--photo-ratio` from `PlacePhotoBanner`, `[data-expanded] .banner` in `place-photo.module.css`).
- **Peek contents (user requests after implementation).** A tap on the photo in the peek expands the story instead of opening the viewer (`PlacePhotoBanner` `onPreview`: a plain picture, not a control); the viewer with the photo credit opens from the expanded card. The peek shows the title without the address; the address appears in the expanded card, whose title block is set off from the text by `--sheet-gap`. Over a photo the title takes the full width (the close sits in the photo's corner).
- **Grip and footer (user feedback).** The sticky chrome uses `top: 0` (sticky offsets count from the content edge; `top: var(--sheet-pad)` pushed the grip onto the title). Without a photo an expandable sheet gets a top strip one control tall (`--sheet-top`), so the 44×44 grip never covers the title. Expanded, the body grows (`flex: 1 0 auto`): a short story keeps the player at the bottom edge with the free room under the text.
- **Container queries (step 6)** were not needed: on the whole matrix the collapsed title and footer are fully visible.
- **E2E.** New tests live in `e2e/story-sheet.spec.ts` (the old inner-scroll test was removed from `interface.spec.ts`); tests that used «Создать прогулку отсюда» or «Источники» now expand the card first. Interactions right after a state change wait for the view transition to end (`:active-view-transition`): taps during it go to the transition overlay.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
