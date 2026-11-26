---
name: implement-plan
description: Implement an existing plan from docs/agents/plans/. Use when the user asks to implement, execute, resume, or continue a plan, or references a plan file — the plan's Status line must be updated on completion.
---

Language and Git workflow: [ENG-01](../../../docs/instructions/engineering.md#eng-01). Plan lifecycle: [ENG-04](../../../docs/instructions/engineering.md#eng-04).

## Process

1. **Locate and read the whole plan.** If the user didn't name a file, list plans in `docs/agents/plans/` with status `plan` / `in progress` and ask **in Russian** which one to implement. If the plan's status is `implemented` or `rejected`, stop and confirm with the user before proceeding.
2. **Mark the plan started:** set `Status: in progress since YYYY-MM-DD.`.
3. **Implement step by step** in the plan's order, applying [ENG-01](../../../docs/instructions/engineering.md#eng-01) to each completed phase.
4. **Test as you go, but don't over-test.** Run the plan's checks per stage, BUT skip a stage's test run when a later plan stage will exercise the same code anyway — speed matters; one honest end-to-end verification at the end (plan's "Testing & verification" section + repo lint/type-check/test rules) is mandatory and cannot be skipped.
5. **After each large stage (or a few small ones)**, compact the context yourself if your harness lets you trigger compaction; if it doesn't, suggest to the user **in Russian** that now is a good moment to run `/compact`. Stage boundaries are where compacting loses the least.
6. **Close the plan** — this is part of "Done":
   - Update the status line: `Status: implemented YYYY-MM-DD in branch \`<branch>\`.` (add short caveats if something was skipped).
   - Correct any sections where the implementation diverged — the plan must not lie about what was built.
   - Ensure the snapshot note (blockquote right under the Status line) is present; add it if the plan predates the template that includes it:

     > Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

   - Apply [ENG-01](../../../docs/instructions/engineering.md#eng-01) to the plan update (may be folded into an authorized final feature commit).
7. **Report to the user in Russian — a TL;DR, not a wall of text:** a few short bullets covering what was built, any divergences from the plan, and how it was verified. Details stay in the plan file and commits; expand only if the user asks.

If some change doesn't make sense or wrong, let the user know.

## Don't execute a broken step

No dedicated verification pass is needed — plans are usually implemented right after being written. But keep your eyes open: if while implementing you see that a plan step is wrong or won't work (relies on code that doesn't exist / behaves differently, contradicts something you've already built, would produce a broken result), do NOT execute it as written. Stop, explain **in Russian** what's wrong and what you propose instead, and agree with the user before continuing.

## Report non-prod-ready code you encounter

Handle non-production-ready code under [ENG-02](../../../docs/instructions/engineering.md#eng-02). Report the concrete finding; fixing code outside the plan remains a separate scope decision.

## Rules

- Branch and commit policy: [ENG-01](../../../docs/instructions/engineering.md#eng-01).
- Old plans are kept, not deleted — "Context" and "Approved decisions" are decision history. The snapshot note is what protects readers from treating them as current docs.
- If implementation stalls partway, leave an honest `Status: in progress since YYYY-MM-DD, <what's done>.` so the next agent can resume.
