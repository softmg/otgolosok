# Plan: Standardize typography and UI styles across the application

Status: implemented 2026-09-21 in branch `feat/auth-account-osm-pipeline` (manual browser visual inspection was not available; map artwork remained unchanged as approved).

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

The repository already has a Russian design document and shared color/spacing variables in `src/app/globals.css`, but typography and component rules have drifted across several global stylesheets. The codebase uses Manrope for interface text and Cormorant Garamond for editorial display text, while the newer map experience in `src/features/explore/explore.css` has its own hard-coded palette and many ad hoc sizes. The admin screens are split between `src/features/admin/admin.css` and `src/features/admin/walk-admin.css` and currently use a separate, inconsistent density and control treatment.

The goal is one coherent visual system for every application surface: the map/nearby experience, reading and walking modes, story generator, auth/account pages, walk builder, navigation, admin screens, and the standalone update page. The map artwork itself is an intentional cartographic exception and should retain its existing SVG label sizing and geometry; surrounding UI must use the shared system.

## Approved decisions

1. Apply the standard to the entire interface, including user-facing routes, admin screens, and `public/update.html`/`public/update.css`.
2. Make CSS custom properties in `src/app/globals.css` the source of truth. Component styles must consume the tokens instead of introducing arbitrary recurring values.
3. Set the default readable body text to `18px` (`1.125rem`). Use `16px` for controls and inputs, `14px` for secondary/supporting text, and `12px` only for short metadata or labels. UI text below `12px` is prohibited; map-internal SVG/Leaflet labels remain an explicit cartographic exception.
4. Keep fluid `clamp()` sizing only for major hero/editorial headings. Component headings, navigation, labels, buttons, fields, and metadata use named fixed typography tokens.
5. Bring admin screens into the same palette, font families, radii, controls, focus treatment, spacing, and responsive rules, while retaining a denser table/editor layout through explicit compact admin tokens.
6. Do not redesign the generated route map artwork (`scripts/build-map.mjs` and `public/data/maps/paveletskaya.svg`) as part of this pass. Only document it as an exception and avoid applying UI tokens inside the SVG.

## Key codebase facts

- `src/app/layout.tsx:1-32` loads `Cormorant_Garamond` into `--font-display`, `Manrope` into `--font-body`, imports `src/app/globals.css`, and mounts `AppNavigation` globally.
- `src/app/globals.css:1-28` defines the existing color variables (`--paper`, `--raised`, `--sunken`, `--ink`, `--muted`, `--accent`, `--teal`, etc.) and spacing variables from `--space-xs` through `--space-3xl`.
- `src/app/globals.css:61-778` styles the reading and story surfaces; `src/app/globals.css:787-1153` styles the dark walking mode; `src/app/globals.css:1165-1270` styles the generator and diagnostic areas; media queries continue through approximately line 1428.
- `src/features/explore/around-screen.tsx` imports `src/features/explore/explore.css` and renders the map shell, search, cards, nearby list, bottom navigation, and route detail surfaces. `src/features/explore/explore.css` currently contains many hard-coded sizes (including 9–13px metadata and 33/44px responsive heading overrides) and a duplicated map-specific palette.
- `src/features/navigation/app-navigation.css` styles the global four-item bottom navigation and currently sets its labels to `10px`.
- `src/features/auth/auth.css` is shared by `src/features/auth/login.tsx` and `src/features/account/account.tsx`; it currently uses independent hard-coded heading, form, button, and note values.
- `src/features/walk-builder/walk-builder.css` scopes the walk creation screen but defines a second set of hard-coded typography, controls, radii, and colors.
- `src/features/admin/admin.css` styles `AdminDesk`, including headings, filters, tables, buttons, forms, and responsive breakpoints; `src/features/admin/walk-admin.css` styles the route/chapter editor with overlapping heading and metadata sizes.
- `public/update.css` is a standalone stylesheet for `public/update.html` and currently uses system/Georgia fonts and its own button/link dimensions, so it cannot inherit application CSS automatically.
- `DESIGN.md` already documents the intended Manrope/Cormorant pairing, a nominal interface scale, 4px spacing scale, minimum action sizes, and the two visual modes, but it does not define enforceable CSS typography tokens or the newly approved 18px body scale.
- `scripts/build-map.mjs` embeds typography and colors directly into generated SVG; those labels are intentionally excluded from UI token migration.
- Existing structural tests such as `src/features/explore/explore-layout.test.ts`, `src/features/navigation/app-navigation.test.ts`, and feature tests read CSS/source text for important layout contracts. Any selector renames or value changes must preserve or update those assertions deliberately.
- Project checks are `pnpm lint`, `pnpm typecheck`, and `pnpm test` from `package.json`. There is no Stylelint or browser E2E dependency; verification must use the existing lint/type/test/build commands plus source-level contract tests where needed.
- Next.js 16 CSS guidance in `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md` recommends keeping truly global CSS in the root layout and avoiding conflicting global imports; the current architecture already imports `globals.css` from the root layout and feature styles from their components.

## Implementation

0. **Inventory and token contract — `src/app/globals.css`, `DESIGN.md`**
   - Add named typography tokens for body (`18px`), control (`16px`), secondary (`14px`), metadata (`12px`), section heading (`22px`), page heading (`32px`), and display/editorial roles. Add corresponding line-height and weight tokens, plus shared radii, control heights, content widths, and focus-ring values where repeated component rules currently diverge.
   - Keep the existing semantic color and spacing variables as the base; add aliases for the map palette so feature styles use the same values without changing the map's visual result.
   - Establish global defaults for body text, paragraphs, form controls, and links so `18px` is the readable baseline while preserving component-specific display roles.
   - Add a short token table and explicit exceptions to `DESIGN.md`: 18px body, 16px controls, 14px secondary, 12px metadata minimum, `clamp()` restricted to major headings, and generated map SVG labels excluded.

1. **Normalize the core reading/walking/generator surfaces — `src/app/globals.css`**
   - Replace recurring literal typography values in reading, story, walking, audio, diagnostics, and generator sections with the new tokens. Preserve the dark walking mode and Cormorant editorial hierarchy while ensuring status, controls, and data use Manrope.
   - Keep `clamp()` only on the explicitly approved hero/editorial heading selectors; replace incidental responsive fixed-size overrides that are not major headings.
   - Normalize control heights, button text, focus rings, paragraph line-height, metadata, and small labels. Do not reduce readable story copy below 18px.
   - Preserve existing layout contracts (walking bottom controls, transcript/source disclosure, route map, reduced-motion behavior) while changing only the visual system values.

2. **Unify the map/nearby experience — `src/features/explore/explore.css`, `src/features/explore/explore-layout.test.ts`**
   - Replace the duplicated palette and repeated literals with global semantic/map aliases and typography/control tokens.
   - Set readable card/list text to 18px, supporting copy to 14px, and short metadata/labels to 12px; retain 16px inputs and at least 44–48px touch targets.
   - Keep the existing rounded-card, bottom-sheet, responsive landscape/short-screen behavior and map layer geometry. Keep Leaflet/map attribution labels as the documented map exception where necessary.
   - Update layout contract tests only where tokenized output changes the asserted selector/value; add a focused source-level test that rejects UI font-size declarations below 12px outside the documented map exception if a robust selector-scoped assertion is practical.

3. **Normalize shared navigation and account/auth forms — `src/features/navigation/app-navigation.css`, `src/features/auth/auth.css`**
   - Apply the common font, label, control height, radius, spacing, focus, and action tokens to bottom navigation, login, registration, account panels, lists, and account actions.
   - Raise navigation labels from the current 10px to the metadata token (12px) and keep the navigation touch target at or above 44px.
   - Preserve existing routes, active-state semantics, form behavior, and accessibility attributes.

4. **Normalize the walk builder — `src/features/walk-builder/walk-builder.css`**
   - Replace local green/orange and literal typography/control values with shared tokens and map aliases.
   - Use 18px for explanatory/readable text, 16px for fields and controls, 14px for supporting help, and 12px only for compact map attribution/metadata.
   - Preserve the builder's one-column responsive layout, 56px primary action, 44px minimum controls, and focus/reduced-motion behavior.

5. **Redesign admin presentation within the shared system — `src/features/admin/admin.css`, `src/features/admin/walk-admin.css`**
   - Consolidate duplicate heading, metadata, form, button, table, message, and editor values onto the shared tokens, adding explicit compact admin aliases only where dense tables require them.
   - Replace ad hoc admin colors/radii with the application palette and consistent states for primary, secondary, warning, error, disabled, hover, active, and focus.
   - Improve information hierarchy: clear page/section headings, readable editor text, consistent field labels/help, predictable table density, and mobile overflow/stacking at the existing breakpoints.
   - Keep admin behavior and data operations untouched. This is a CSS-only presentation refactor unless a class is required to express an already-rendered semantic state; in that case update the smallest relevant JSX selector and its test.

6. **Bring the standalone update page into the system — `public/update.css`, `public/update.html`**
   - Mirror the shared font pairing, colors, spacing, body/control sizes, focus ring, and rounded action treatment in the standalone stylesheet using local custom properties, since it cannot import the Next.js global stylesheet.
   - Keep the update/retry behavior, copy, minimum touch targets, and no-script fallback unchanged.

7. **Source-level guardrails and documentation — tests and `DESIGN.md`**
   - Add a Vitest test (for example under `src/app` or `src/features` with the existing source-reading pattern) that verifies the required token names/values exist and that the main feature styles reference tokens for recurring typography rather than introducing the banned sub-12px UI sizes.
   - Exclude `scripts/build-map.mjs` and generated SVG map labels from the guardrail with an explicit comment/documentation reference.
   - Update `docs/agents/README.md` only if implementation uncovers a durable environment or architecture gotcha that future agents cannot infer from the code; do not add routine styling notes there.

8. **Verification and commit**
   - Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` after all stylesheet and test changes.
   - Run `pnpm build` to verify Next.js CSS ordering/production compilation and generated static output; inspect the build for CSS import/order failures.
   - Review the final diff for accidental behavior changes, remaining UI font sizes below 12px outside map exceptions, inconsistent hard-coded palette values in the targeted stylesheets, and accidental edits to generated map artwork.
   - Commit the complete change atomically using the repository convention, with a Conventional Commit message in Russian after the English type/scope (for example, `refactor(ui): стандартизировать типографику и стили интерфейса`).

## Testing & verification

- Add meaningful source-level assertions for the token contract and the no-sub-12px UI rule; update existing explore/navigation contract tests when their expected CSS contracts change.
- Run `pnpm lint` and `pnpm typecheck` to catch CSS-import and JSX/class selector mistakes exposed by the refactor.
- Run `pnpm test` for all existing Vitest and backend tests; styling changes must not alter behavior tests.
- Run `pnpm build` for production CSS concatenation/order verification. Do not call paid APIs or external services from tests.
- Manually inspect representative responsive states after the build if a browser is available: nearby map/card, reading home, walking mode, generator, auth/account, admin table/editor, and `update.html`; verify 18px readable copy, 16px controls, 12px minimum UI metadata, keyboard focus, and touch targets.

## Out of scope

- Rewriting React behavior, data contracts, API/auth flows, map selection/geolocation logic, audio playback, or admin operations.
- Replacing the font families or introducing a new CSS framework/design dependency.
- Redrawing or retuning generated SVG map artwork and its internal labels.
- Adding Stylelint, Storybook, visual-regression infrastructure, browser automation, monitoring, or unrelated product features.
- Replacing every legitimate responsive `clamp()` used for major editorial/hero headings.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented 2026-09-21 in branch \`feat/<name>\``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
