# Plan: Walk builder opens the walk right after building

Status: implemented 2026-10-02 in branch `feat/promo-walks-stories-only`. Caveats: the manual browser-preview check was replaced by e2e screenshots, because another session's `next dev` held this folder. The 6 pre-existing `layout-invariants` failures «прогулка / … footer обрезано» remain.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

A user builds a 30-minute walk. After «Построить прогулку» the builder shows the «Ваш маршрут» step: time, distance, «Откуда/Куда», route on the map. Its «Начать прогулку» is only a link to `/walk?local=…`. That page shows the same route, time, distance and stops again, with a second «Начать прогулку» that actually starts the walk. The user sees two near-identical screens in a row.

The walk page's pre-start state cannot be dropped:

- `startTour` (`src/features/tour/tour-experience.tsx:169-199`) calls `audio.begin` inside the click so iOS unlocks audio. A walk auto-started after navigation would be silent on iPhone.
- The same state serves catalog and shared walks: rating, reviews, «Продолжить прогулку».

So the builder's «Ваш маршрут» step is the redundant one.

## Approved decisions

1. After a successful build, the builder navigates straight to the walk page. The «Ваш маршрут» step is removed. (User: «Да давай».)
2. Builder-only content moves to the walk page for the user's own walks (`?local=` and `?id=`), or stays in the builder behind «Изменить».

Proposed by the implementer, approved with the plan (user: «Implement the plan»):

3. **«Изменить» on the walk page.** Own walks get a «Изменить маршрут» button in `walk-session-tools` before start. It links to `/?walk=create&{local|id}=…&edit=1`, which already opens the builder for that walk (`walk-library.tsx` «Редактировать»).
4. **Builder with an existing route opens the form.** The route stays drawn on the map, and the footer shows «Открыть прогулку» (link to `openHref`). Any edit already clears `route` (`editDraft`, `model.ts:102`), so the footer switches back to «Построить прогулку». This covers «Редактировать» from the library and `?resume=1`.
5. **Shortfall note on the walk page.** For own walks without a destination, the pre-start panel shows «Рядом нашлось мест только на N мин из M. Измените начало прогулки.» It uses `routeShortfall(route, document.minutes)`. The note is shown on every open of the walk, not only right after the build: `autoRoute` is not persisted, and the shortfall is still true later.
6. **AI story preparation stays in the builder.** The consent checkbox, «Подготовить историю», job links and ID recovery move from the removed preview into the builder form, under «Остановки · N», shown while `draft.route` exists. Reason: the job, poll and recovery machinery lives in `useWalkDraft` (`use-walk-draft.ts:256-310`). Moving it to the walk page would duplicate it. The walk page only says «У N остановок пока нет истории» next to «Изменить маршрут» for own walks.
7. **Research.** `ResearchPanel.onApply` navigates to the walk page instead of switching to the preview step.
8. **Account walks are saved before opening (user choice during implementation).** Edits to an account walk lived only in this browser, because `persist` writes local walks only, while `/walk?id=…` loads the server copy. So after a rebuild the walk page showed the old route. `openWalk()` now calls `saveToAccount()` first when the walk was changed (`accountDirty`). If saving fails, or a public walk goes back to the editors («В топе она появится после проверки редакцией»), the builder stays open with the message. An unchanged account walk opens without a request.

## Key codebase facts

- `src/features/walk-builder/walk-creation-panel.tsx`:
  - `build()` (`:71`) awaits `w.plan()`, then dispatches `step: "preview"`.
  - `preview = Boolean(w.draft.route) && !state.picking` (`:72`) drives the title «Ваш маршрут», the summary block (`:118-131`) and the footer link «Начать прогулку» (`:103`).
  - `w.target === "stop"` (`:116`) is never set anywhere: dead UI for manual stops. Remove it together with the preview.
- `src/features/walk-builder/use-walk-draft.ts`:
  - `plan()` persists the route.
  - `openHref` (`:336`) is `/walk?id=…` for account walks and `/walk?local=…` otherwise.
  - `nextPlace` is the first stop without `contentId` and without a job. Automatic stops without published content have no `contentId` (`backend/walks.mjs:379-382`), so preparation stays reachable for regular users.
- `src/features/walks/walk-screen.tsx`: `selectedKind` is `local | id | catalog | share`. Only `local` and `id` are the viewer's own walks. `TourExperience` receives no ownership flag today.
- `src/features/tour/walk-session.tsx`: the pre-start state is `!active && !completed`. The tools row (`:121-127`) holds «Остановки · N» and «Отзывы».
- `src/features/walk-builder/creation-state.ts`: the `"preview"` step becomes unused.

## Implementation

As built:

1. **Ownership, edit link and notes** (commit `da4ab13`).
   - `src/features/walks/own-walk.ts`:
     - `OwnWalk = { editHref, notes }`;
     - `ownWalkEditHref(kind, id)`;
     - `ownWalkNotes(view)`: the shortfall for walks without a destination, and «У N остановки/остановок пока нет истории» for chapters with status `not_requested`.
   - `WalkScreen` builds `own` for `local`/`id` and passes it through `TourExperience` to `WalkSession`.
   - Before the start, `WalkSession` renders the notes as `walk-session-muted` lines and «Изменить маршрут» as a `Link` in the tools row.
2. **Builder navigation** (commit `624dd78`).
   - `useWalkDraft`:
     - `plan()` returns whether the route was built;
     - `openWalk()` saves a changed account walk (decision 8), then calls `router.push(openHref)`;
     - `build()` runs `plan()`, then `openWalk()`.
   - The panel's `build()` and `ResearchPanel.onApply` call these.
   - `saveToAccount()` now returns `"saved" | "review" | null`.
   - A legacy (version 1) account snapshot is no longer kept as `documentRef`; saving builds a fresh document from it.
3. **Builder form with a route.**
   - Removed:
     - the preview branch and the «Ваш маршрут» title;
     - `"preview"` from `CreationState`;
     - the dead `target === "stop"` UI;
     - the unused `autoRoute` state;
     - the preview CSS (`.summary`, `.shortfall`, `.routePoints`).
   - Footer: «Открыть прогулку» (a button calling `openWalk()`) when `draft.route` exists, otherwise «Построить прогулку».
   - The stops `<details>` with the AI-preparation controls sits under the endpoints while `draft.route` exists.
4. **Layout check** (commit `7abc904`).
   - `e2e/support/layout.ts` no longer treats the content of a closed `<details>` as visible; only its `summary` counts.
   - This removed the known `создание / маршрут` target failure: it was the hidden AI-consent checkbox.

## Testing & verification

- Unit (`walk-session.test.ts`), table-driven:
  - «Изменить маршрут» is shown for own walks before start;
  - it is hidden after start, after completion, and for catalog/shared walks;
  - the shortfall and missing-stories notes follow the same rules.
- Unit for the shortfall/missing-count helper: no destination vs destination, `walkingMinutes` at and below the 75 % threshold of `routeShortfall`.
- `use-walk-draft-open.test.ts`:
  - a successful build pushes `/walk?local=…`;
  - a failed build stays with the error;
  - account walks (table): unchanged — no PATCH, opens; rebuilt — PATCH, opens; went back to review — stays with the message; save error — stays.
- `walk-creation-panel.test.ts`: a draft with a route shows the form and «Открыть прогулку»; editing the time switches the footer to «Построить прогулку».
- e2e (`e2e/interface.spec.ts`, `e2e/support/scenarios.ts`): rewrite every flow that expects the «Ваш маршрут» heading or the «Начать прогулку» link in the builder (`interface.spec.ts:128-143, 250, 505, 537`; `scenarios.ts:125`). They should expect the walk page heading and the «Начать прогулку» button. «Изменить маршрут» on the walk page leads back to the filled form.
- Results:
  - vitest: 86 files and 844 tests passed;
  - `node --test backend`: 688 passed;
  - lint and typecheck clean;
  - Playwright `interface`, `walk-session`, `navigation` (chromium): 81 passed;
  - `layout-invariants`: all passed except the 6 pre-existing «footer обрезано» walk-panel cases.
- The e2e runs used a separate worktree. Their screenshots show the walk page after the build: the notes and «Изменить маршрут». They also show the builder form with the route and «Открыть прогулку».

## Risks

- **Parallel session.** At the time of writing, uncommitted changes from another session touch `walk-creation-panel.tsx` (preview map markers) and `e2e/interface.spec.ts` (assertions on the «Ваш маршрут» step). Implement only after they are committed, then rebase the e2e expectations onto the walk page.
- The walk page now shows builder notes for own walks; catalog/shared views must stay unchanged (covered by the unit table).

## Out of scope

- Auto-starting the walk after navigation (breaks iOS audio, see Context).
- Moving AI story preparation to the walk page.
