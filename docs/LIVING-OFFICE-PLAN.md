# Living Office — Four-Person Intelligent Office Transformation

> Branch: `feature/living-office` (from `main` @ `228080b`, v0.4.0)
> Goal: turn the Agent Office into a living, dynamic virtual office where four
> AI agents work, rest, think and collaborate according to **real task state** —
> never faked by decoration animation.

## 1. Verified baseline (2026-11-10)

- `npm run test:behavior`: 64 pass / 0 fail
- `npm run check:server`: pass
- `npm run lint`: 0 warnings, 0 errors
- `npm run build`: pass
- Chrome is unavailable in the dev environment, so browser smoke tests
  (`smoke:browser`, `smoke:floor`, `smoke:avatars`) cannot run locally.
  They are recorded as not-run, not passed.

## 2. What already exists — reuse, do not rebuild

| Capability | Source file(s) |
|---|---|
| Single-floor office layout: sectors, pods (max 9 desks), spine aisle, passages, one coffee point per row | `src/scene/officeLayout.ts` |
| Furniture, glazed facade, lighting, meeting area, focus nook, kitchenette, plants, whiteboards | `src/scene/OfficeCampus.tsx`, `src/scene/officeDecor.ts` |
| Character movement: reserved coffee visits per wing, 0.72 m collision check, yield-before-contact | `src/scene/officeSimulation.ts` |
| Walk routes: separate outward/return paths, 10 movement stages, safe return-to-seat on new task | `src/scene/officeMotion.ts` |
| Task phase → character pose; 8 s terminal reaction window after completed/failed | `src/scene/agentBehavior.ts` |
| Avatar rig: gait, sitting transitions, typing, chin-on-hand thinking, coffee sip, breathing | `src/scene/avatarRig.ts`, `src/scene/OfficeAvatar.tsx` |
| Appearance preferences persisted under `agent-office-appearance-v1` | `src/scene/officePreferences.ts` |
| Local Express API + SSE full-snapshot stream (`event: state`) | `server/index.mjs` |
| CLI adapters & discovery (Codex / Claude Code / Gemini CLI) | `server/providers.mjs` |
| Roster CRUD, atomic `agents.json` writes | `server/agents.mjs` |
| Behavior tests (no real AI jobs needed) | `scripts/test-office-layout.mjs`, `scripts/test-agent-behavior.mjs`, `scripts/test-task-dispatch.mjs` |

Established rules that must stay true:

- Real tasks outrank ambient routines; a new task forces a safe return to the chair.
- Ambient routines never change backend task status.
- There is no agent-to-agent messaging, shared memory or orchestration (yet).

Corrections to earlier assumptions (verified by reading the code):

- The office is a **single floor**, not multi-storey.
- `celebrating` is only a pose type + 8 s timer — there is **no celebration
  animation** in the rig. Visible celebration must be added if required.
- `walkAt()` in `officeMotion.ts` is dead code (tests only); the live path is
  `advanceMovement` + `stepOfficeSimulation`.
- There is **no rest area and no window zone** yet: `OfficeAmenity` only has
  `meeting | coffee | focus | reception`.
- The preferences key lives in `officePreferences.ts`, not in
  `OfficePreferencesContext.ts` (which is only an 11-line React context).

## 3. What is new in this project

1. **Five zones**: four-person work area (desks stay 1:1 with agents),
   pantry (coffee machine, water dispenser, fridge, cup rack, snack cabinet,
   counter), rest area (sofa, rug, coffee table, bookshelf, plants, soft
   light), window inspiration area (floor-to-ceiling window, city / mountains /
   sky / slow clouds), whiteboard collaboration area.
2. **Office cat**: wanders or sleeps in idle areas only, never blocks work.
3. **Ten-state agent status machine** (new adapter layer
   `src/scene/agentStatus.ts`): `WORKING | PLANNING | RESEARCHING | IDLE |
   BREAK | COLLABORATING | COMPLETED | BLOCKED | ERROR | OFFLINE`.
   Priority: `OFFLINE > BLOCKED > ERROR > COMPLETED (8 s) > COLLABORATING >
   WORKING/PLANNING/RESEARCHING > BREAK > IDLE`.
4. **Settings**: activity rate, break-animation toggle, random-movement toggle,
   ambient-animation toggle, window-thinking toggle, performance mode — added
   to `officePreferences.ts` + `Settings.tsx`, same storage key, all new
   fields defaulted and backward compatible.
5. **Collision & pathing**: extend the existing reservation system to the new
   zones; four agents moving at once must not clip walls, furniture or each
   other.
6. **Click interactions**: click a character for name / real status / current
   task / execution info; click a desk to jump to that agent's task view.

## 4. Two verified caveats — do not overpromise

### BLOCKED (waiting for user authorization): no CLI signal exists

Checked `server/providers.mjs:52-55` and `server/task-output.mjs`:

- Codex launches with `-s workspace-write` (sandbox write, non-interactive).
- Claude Code launches with `--permission-mode acceptEdits --permission-prompts
  none` — approval prompts explicitly disabled.
- Gemini CLI launches with `--approval-mode auto_edit` — auto-approve.
- The parsers recognise no approval/permission/waiting event; stderr is only
  kept (last 1200 chars) as a failure fallback; stdin is closed right after
  launch.

Therefore:

- **Manual flag is the primary mechanism**: `awaitingApproval?` on the task,
  `POST /api/tasks/:id/blocked` + `/unblock` (mirroring the existing cancel
  endpoint), pushed through the existing SSE snapshot.
- **Weak auto-detection (secondary)**: match known future JSON types and
  stderr keywords (`approval / permission / awaiting / confirm`) and set the
  same flag. It will rarely fire while the launch args disable prompts.
- **Idle watchdog (cheap safety net)**: if a `running` task produces no
  stdout JSON for > 10 minutes, emit a `warning` event ("no output for a
  long time, may be waiting for input") without changing state.
- **Out of scope**: interactive approval from the UI. That would need stdin
  kept open + a new input channel — a different scale of work with injection
  risk. If a CLI is waiting, the UI says "handle it in the terminal".

### COLLABORATING: no collaboration events exist

Verified by grep: no agent-to-agent communication, no handoff, no dependency
fields anywhere (only the "Ready to collaborate" stats label and a demo task
description mention the word). `OfficeTask` has a single `agentId`.

**Chosen trigger (real, server-side)**: task dependency — `POST /api/tasks`
accepts an optional `dependsOn` (id of a prerequisite task). When the
prerequisite completes, dependent tasks are dispatched and both sides get a
`TaskEvent` (e.g. `Handoff from Atlas: …`). The whiteboard behavior is
shown only inside that real handoff window. A "handoff from" picker in the
new-task dialog is the manual equivalent. Random/timed "two agents walk over
and chat" is **forbidden** — it would fake collaboration and contradicts the
existing test asserting idle movement must not enter a conversation stage.

## 5. Phases

1. **Architecture review & module list** — this document. (Done.)
2. **Office layout** — five zones, paths, furniture occupancy.
3. **State machine & behavior switching** — work / idle / thinking / waiting /
   completed.
4. **Interactive animations** — pantry, rest area, window, whiteboard.
5. **Visual detail, movement polish, performance** — cat, natural light,
   settings UI.
6. **Real-task linkage testing** — against the 9 acceptance scenarios below.

Each phase ends with tests + a commit. No phase is batched into the end.

## 6. Acceptance scenarios (must be covered in test records)

1. Four agents work at once, each returns to their own desk.
2. One agent finishes a task and goes to the rest area; the other three are
   unaffected.
3. One agent drinking coffee gets a new task and returns to their desk at once.
4. One agent in a real planning phase shows thinking at the window.
5. One agent waiting for user authorization shows the correct reminder and
   does not enter rest state.
6. Multiple agents move at once with no visible clipping, overlap or deadlock.
7. Disconnecting an agent shows offline correctly.
8. Turning off all decoration animation does not affect real task execution.
9. Long runs show no frequent random wandering, state confusion or steady
   performance decline.

## 7. Rules of this branch

- Only `feature/living-office` is written to. `main` is never pushed to
  directly; the PR is never merged by the developer.
- No fake task progress, tool calls or completion messages. Thinking
  effects (lightbulb, draft paper) are decoration and are never presented
  as real task progress.
- Movement logic never affects real AI execution; visual position and task
  state stay separate.
- Keep new modules small and maintainable; reuse first.
