import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHandoffFixture as fixture, sleep, until } from './test-server-fixture.mjs'
import { describeAgent, resolveAgentStatus, isCollaborating, COLLAB_WINDOW_MS } from '../src/scene/agentStatus.ts'
import { TERMINAL_POSE_MS } from '../src/scene/agentBehavior.ts'
import { agentStatusName } from '../src/components/taskDisplay.ts'
import { makeOfficeLayout } from '../src/scene/officeLayout.ts'
import { reconcileOfficeSimulation, stepOfficeSimulation, routeForSeat, giveWayStep } from '../src/scene/officeSimulation.ts'
import { resolvePerformanceSettings } from '../src/scene/officePreferences.ts'
import { catStateAt, catLaneZ, CAT_CYCLE_S } from '../src/scene/officeCat.ts'
import { naturalLightAt, NATURAL_LIGHT_NEUTRAL } from '../src/scene/naturalLight.ts'
import { makeAgent } from '../server/agents.mjs'
import { createMovementState } from '../src/scene/officeMotion.ts'

// Phase 6: real-task linkage tests. Every chain below is driven by a real
// server dispatch (the shared fixture with fake provider CLIs) feeding the
// same wiring the live scene uses (OfficeScene.tsx): activeIds from running
// tasks, planningIds/collabIds from the ten-state status map, frozenIds
// from the snapshot's `connected` flag — then stepped through the real
// simulation. Nothing here asserts a static mapping on its own.
//
// Simulated time: stepOfficeSimulation advances 0.05 s per call, so
// 1200 steps = 60 s of office time. Wall-clock windows (the 8 s terminal
// pose, the 60 s handoff window) are real time and use the server's real
// event timestamps.
const DT = .05

function makeTeam(count) {
  const departments = ['architecture', 'engineering', 'design', 'quality']
  return Array.from({ length: count }, (_, index) => makeAgent({
    name: `Agent ${index}`, role: `Role ${index}`, specialty: `Specialty ${index}`,
    color: '#6474ab', department: departments[index % departments.length],
  }, `agent-${index}`))
}

// Mirror of OfficeScene.tsx: activeIds from running tasks, planningIds
// from PLANNING statuses, collabIds from COLLABORATING statuses whose task
// is still running (a completed prerequisite collaborates on screen but
// never walks to the whiteboard), frozenIds from connected === false.
async function syncFromServer(f, sim, layout, now = Date.now()) {
  const state = (await f.request('/api/state')).body
  const tasks = state.tasks
  const statuses = new Map()
  for (const seat of layout.seats) {
    statuses.set(seat.agent.id, describeAgent(tasks, seat.agent.id, sim.get(seat.agent.id)?.state, { connected: state.connected }, now))
  }
  return {
    state, tasks, statuses,
    activeIds: new Set(tasks.filter(task => task.status === 'running').map(task => task.agentId)),
    planningIds: new Set([...statuses].filter(([, entry]) => entry.status === 'PLANNING').map(([id]) => id)),
    collabIds: new Set([...statuses].filter(([, entry]) => entry.status === 'COLLABORATING' && entry.task?.status === 'running').map(([id]) => id)),
    frozenIds: state.connected === false ? new Set(layout.seats.map(seat => seat.agent.id)) : new Set(),
  }
}

function stepSim(sim, ids, sets, count, opts = {}) {
  for (let i = 0; i < count; i++) {
    stepOfficeSimulation(sim, ids, sets.activeIds ?? new Set(), DT, opts.motion ?? 'lively', {
      behavior: opts.behavior, frozenIds: sets.frozenIds, planningIds: sets.planningIds,
      collabIds: sets.collabIds, layout: opts.layout, routeOptions: opts.routeOptions,
    })
    opts.onStep?.()
  }
  return count
}

// Step in 100-step chunks, re-syncing the sets from the live server each
// chunk (this is what the scene does every frame from the SSE snapshot).
// `paceMs` sleeps between chunks so real server time passes while the
// office runs; 0 means as fast as possible.
async function driveSync(f, sim, layout, count, opts = {}) {
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  let done = 0
  while (done < count) {
    const sets = await syncFromServer(f, sim, layout)
    const chunk = Math.min(100, count - done)
    done += stepSim(sim, ids, sets, chunk, { ...(opts.step ?? {}), layout, onStep: opts.onStep })
    if (opts.onSync) opts.onSync(sets)
    if (opts.paceMs) await sleep(opts.paceMs)
  }
  return done
}

// Like driveSync, but stops as soon as `cond(sim)` is true (checked after
// every chunk). Returns the steps actually run.
async function driveUntil(f, sim, layout, cond, maxSteps, opts = {}) {
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  let done = 0
  while (done < maxSteps && !cond(sim)) {
    const sets = await syncFromServer(f, sim, layout)
    const chunk = Math.min(100, maxSteps - done)
    done += stepSim(sim, ids, sets, chunk, { ...(opts.step ?? {}), layout, onStep: opts.onStep })
    if (opts.onSync) opts.onSync(sets)
    if (opts.paceMs) await sleep(opts.paceMs)
  }
  assert.ok(cond(sim), opts.message ?? 'driveUntil timed out')
  return done
}

async function waitForTask(f, id, cond, timeout = 8000) {
  return until(async () => { const item = await f.task(id); return cond(item) && item }, timeout)
}

function stageTracker(sim) {
  const seen = new Map([...sim.keys()].map(id => [id, new Set()]))
  return { seen, onStep: () => { for (const [id, actor] of sim) seen.get(id).add(actor.state.stage) } }
}

test('a. real dispatch: PLANNING -> WORKING -> COMPLETED (8 s) -> IDLE -> BREAK, others untouched', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  const agents = (await f.request('/api/state')).body.agents
  const target = agents[0].id // atlas
  const layout = makeOfficeLayout(agents)
  const sim = reconcileOfficeSimulation(layout)
  const tracker = stageTracker(sim)
  const seenStatuses = new Map(agents.map(agent => [agent.id, new Set()]))

  const launched = await f.launch({ agentId: target, prompt: 'Real linkage work [delayed] [coding]' })
  assert.equal(launched.status, 201)
  const id = launched.body.task.id
  // While the fake CLI is still thinking, the agent plans; once progress
  // output arrives the phase turns to coding and the agent works. Wait for
  // the coding phase first: the sit-down itself takes only ~100 steps, so
  // driving for the chair before the phase flips would miss WORKING.
  const running = await waitForTask(f, id, item => item.status === 'running' && item.phase === 'coding')
  assert.equal(running.phase, 'coding', 'the running task must reach the coding phase')
  let workingSeen = false
  await driveUntil(f, sim, layout, () => sim.get(target).state.stage === 'working', 2000, {
    onSync: sets => {
      for (const [agentId, entry] of sets.statuses) seenStatuses.get(agentId).add(entry.status)
      if (sets.statuses.get(target).status === 'WORKING') workingSeen = true
    },
  })
  assert.equal(workingSeen, true, 'WORKING must be observed while the real task runs')
  const done = await waitForTask(f, id, item => item.status !== 'running')
  assert.equal(done.status, 'completed')
  assert.ok(done.finishedAt, 'a completed task must record when it ended')
  // Inside the 8 s terminal window the agent celebrates; the pose comes
  // from the same describeAgent the inspector renders.
  const atCompletion = await syncFromServer(f, sim, layout)
  assert.equal(atCompletion.statuses.get(target).status, 'COMPLETED', 'a just-finished task must read COMPLETED')
  assert.equal(atCompletion.statuses.get(target).pose, 'celebrating')
  assert.ok(Date.now() - Date.parse(done.finishedAt) < TERMINAL_POSE_MS, 'the COMPLETED check must land inside the terminal window')
  // The task ends: the agent rises, stands, and reads IDLE once the
  // terminal window has passed (simulated with an explicit `now`).
  await driveUntil(f, sim, layout, () => sim.get(target).state.stage === 'standing', 2000, {
    onSync: sets => { for (const [agentId, entry] of sets.statuses) seenStatuses.get(agentId).add(entry.status) },
  })
  const afterWindow = await syncFromServer(f, sim, layout, Date.parse(done.finishedAt) + 60_000)
  assert.equal(afterWindow.statuses.get(target).status, 'IDLE', 'standing with no task after the window must read IDLE')
  // Left idle, the agent eventually takes a break — and only that agent.
  await driveUntil(f, sim, layout, () => ['coffee', 'resting'].includes(sim.get(target).state.stage), 6000, {
    onSync: sets => { for (const [agentId, entry] of sets.statuses) seenStatuses.get(agentId).add(entry.status) },
  })
  const onBreak = await syncFromServer(f, sim, layout, Date.parse(done.finishedAt) + 60_000)
  assert.equal(onBreak.statuses.get(target).status, 'BREAK', 'an agent parked at a break stop must read BREAK')
  for (const agent of agents) {
    if (agent.id === target) continue
    assert.equal(tracker.seen.get(agent.id).has('working'), false, `${agent.id} must never sit down to work without a task`)
    assert.equal(['IDLE', 'BREAK'].includes(onBreak.statuses.get(agent.id).status), true, `${agent.id} must stay IDLE or BREAK`)
    assert.equal(seenStatuses.get(agent.id).has('COMPLETED'), false, `${agent.id} must never read COMPLETED`)
    assert.equal(seenStatuses.get(agent.id).has('WORKING'), false, `${agent.id} must never read WORKING`)
  }
})

test('b. a new task interrupts a break at once: coffee, rest and window stops', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  const agents = (await f.request('/api/state')).body.agents
  const layout = makeOfficeLayout(agents)
  const sim = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  // Drive the idle office until one agent is parked at each break kind.
  // Which agent lands where comes from the real rotation, not an assumed
  // ordinal: coffee -> stage 'coffee', rest/window -> 'resting' + resource.
  const parked = new Map()
  for (let i = 0; i < 6000 && parked.size < 3; i++) {
    stepOfficeSimulation(sim, ids, new Set(), DT, 'lively', { layout })
    for (const [id, actor] of sim) {
      const kind = actor.state.stage === 'coffee' ? 'coffee'
        : actor.state.stage === 'resting' && actor.resource.startsWith('rest-') ? 'rest'
        : actor.state.stage === 'resting' && actor.resource.startsWith('window-') ? 'window' : null
      if (kind && !parked.has(kind)) parked.set(kind, { id, stage: actor.state.stage, resource: actor.resource })
    }
  }
  assert.deepEqual([...parked.keys()].sort(), ['coffee', 'rest', 'window'], 'all three break stops must be covered')
  const busy = [...parked.values()]
  const idleAgent = agents.find(agent => !busy.some(entry => entry.id === agent.id))
  assert.ok(idleAgent, 'one agent must be left without a task')
  // One workspace per task: same-folder tasks are mutually exclusive.
  const workspaces = []
  for (let i = 0; i < busy.length; i++) {
    const folder = join(f.root, `project-${i}`); await mkdir(folder); workspaces.push(folder)
  }
  const launched = []
  for (let i = 0; i < busy.length; i++) {
    const result = await f.launch({ agentId: busy[i].id, workspace: workspaces[i], prompt: `Urgent work ${i} [hold] [coding]` })
    assert.equal(result.status, 201)
    launched.push(result.body.task.id)
  }
  for (const taskId of launched) await waitForTask(f, taskId, item => item.status === 'running' && item.phase === 'coding')
  const activeIds = new Set(busy.map(entry => entry.id))
  // The return starts on the very next step — no finishing the coffee first.
  stepOfficeSimulation(sim, ids, activeIds, DT, 'lively', { layout })
  for (const entry of busy) assert.equal(sim.get(entry.id).state.stage, 'returning', `${entry.id} must leave its ${entry.resource} stop at once`)
  await driveUntil(f, sim, layout, () => busy.every(entry => sim.get(entry.id).state.stage === 'working'), 3000, {
    message: 'interrupted agents must reach their desks',
  })
  const working = await syncFromServer(f, sim, layout)
  for (const entry of busy) assert.equal(working.statuses.get(entry.id).status, 'WORKING', `${entry.id} must read WORKING after the interruption`)
  assert.equal(sim.get(idleAgent.id).state.stage === 'working', false, 'the agent without a task must not sit down to work')
  assert.equal(['IDLE', 'BREAK'].includes(working.statuses.get(idleAgent.id).status), true)
  for (const taskId of launched) assert.equal((await f.request(`/api/tasks/${taskId}/cancel`, 'POST')).status, 200)
})

test('c. /blocked reads BLOCKED at the desk, /unblock resumes real work', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  const agents = (await f.request('/api/state')).body.agents
  const target = agents[0].id
  const layout = makeOfficeLayout(agents)
  const sim = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  const studioSrc = await readFile(new URL('../src/views/Studio.tsx', import.meta.url), 'utf8')
  assert.match(studioSrc, /BLOCKED: 'amber'/, 'the inspector dot for BLOCKED must be amber in Studio.tsx')
  assert.equal(agentStatusName.BLOCKED, 'Waiting for approval', 'the inspector label for BLOCKED must match the status')

  const launched = await f.launch({ agentId: target, prompt: 'Long work [hold] [coding]' })
  assert.equal(launched.status, 201)
  const id = launched.body.task.id
  await waitForTask(f, id, item => item.status === 'running' && item.phase === 'coding')
  await driveUntil(f, sim, layout, () => sim.get(target).state.stage === 'working', 2000, { paceMs: 10 })
  const blocked = await f.request(`/api/tasks/${id}/blocked`, 'POST')
  assert.equal(blocked.status, 200)
  assert.equal(blocked.body.task.awaitingApproval, true)
  assert.equal((await f.task(id)).awaitingApproval, true)
  const blockedState = await syncFromServer(f, sim, layout)
  assert.equal(blockedState.statuses.get(target).status, 'BLOCKED')
  assert.equal(blockedState.statuses.get(target).pose, 'blocked')
  // 100 s of office time blocked: the agent stays seated, never takes a
  // break route, never walks to the window or the whiteboard.
  const sets = await syncFromServer(f, sim, layout)
  for (let i = 0; i < 2000; i++) {
    stepOfficeSimulation(sim, ids, sets.activeIds, DT, 'lively', { layout, planningIds: sets.planningIds, collabIds: sets.collabIds })
    const actor = sim.get(target)
    assert.equal(actor.state.stage, 'working', `blocked agent left the desk at step ${i} (stage ${actor.state.stage})`)
    assert.equal(actor.routeOverride, undefined, 'a blocked agent must never take a route override')
    assert.equal(actor.resource.startsWith('window-'), false, 'a blocked agent must never take the window route')
    assert.notEqual(actor.resource, 'collab', 'a blocked agent must never take the whiteboard route')
  }
  const unblocked = await f.request(`/api/tasks/${id}/unblock`, 'POST')
  assert.equal(unblocked.status, 200)
  assert.equal((await f.task(id)).awaitingApproval, undefined)
  const resumed = await syncFromServer(f, sim, layout)
  assert.equal(resumed.statuses.get(target).status, 'WORKING', 'after /unblock the same running task must read WORKING again')
  assert.equal((await f.request(`/api/tasks/${id}/cancel`, 'POST')).status, 200)
  await driveUntil(f, sim, layout, () => sim.get(target).state.stage === 'standing', 2000)
  assert.equal((await syncFromServer(f, sim, layout)).statuses.get(target).status, 'IDLE')
})

test('d. dependsOn handoff: both sides COLLABORATING, whiteboard only inside the window', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  const agents = (await f.request('/api/state')).body.agents
  const prereqAgent = agents[0].id // atlas
  const dependentAgent = agents[1].id // nova
  const layout = makeOfficeLayout(agents)
  const sim = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  // The dependent must be standing when the handoff lands: only a standing
  // agent swaps to the whiteboard route (officeSimulation.ts). Wait for it
  // with the sim running, then stop stepping while the server works.
  await driveUntil(f, sim, layout, () => sim.get(dependentAgent).state.stage === 'standing', 6000, {
    message: 'dependent must be standing before the handoff',
  })
  const first = await f.launch({ agentId: prereqAgent, prompt: 'Plan the dashboard [delayed]' })
  assert.equal(first.status, 201)
  const prereqId = first.body.task.id
  const second = await f.launch({ agentId: dependentAgent, prompt: 'Dependent follow-up work [hold] [coding]', dependsOn: prereqId })
  assert.equal(second.status, 201)
  assert.equal(second.body.task.status, 'queued')
  assert.ok(second.body.task.events.some(event => /Waiting for Atlas/.test(event.message)))
  const dependentId = second.body.task.id
  const dependent = await waitForTask(f, dependentId, item => item.status === 'running')
  assert.equal(dependent.status, 'running', 'the queued task must dispatch when its prerequisite completes')
  const prereq = await f.task(prereqId)
  assert.equal(prereq.status, 'completed')
  const handoffAt = Date.parse(dependent.events.find(event => event.message.startsWith('Handoff from Atlas:')).at)
  assert.ok(Number.isFinite(handoffAt), 'the dependent must record the handoff event')
  assert.ok(prereq.events.some(event => event.message.startsWith('Handed off to Nova:')), 'the prerequisite must record the handoff')
  // Inside the window the dependent collaborates at once; the prerequisite
  // side is still inside its 8 s completion window, so it reads COMPLETED
  // first and COLLABORATING only once that window has passed.
  const inWindow = await syncFromServer(f, sim, layout)
  assert.equal(inWindow.statuses.get(dependentAgent).status, 'COLLABORATING')
  assert.equal(inWindow.statuses.get(prereqAgent).status, 'COMPLETED')
  assert.equal(isCollaborating(dependent, Date.now()), true)
  const afterTerminal = await syncFromServer(f, sim, layout, Date.parse(prereq.finishedAt) + TERMINAL_POSE_MS + 2_000)
  assert.equal(afterTerminal.statuses.get(prereqAgent).status, 'COLLABORATING', 'the prerequisite side collaborates after its completion window')
  assert.equal(afterTerminal.statuses.get(dependentAgent).status, 'COLLABORATING')
  // The running dependent walks to the whiteboard; the completed side never
  // takes the collab route (OfficeScene only puts running collaborators in
  // collabIds) and nobody else goes near the board.
  const sets = await syncFromServer(f, sim, layout)
  assert.deepEqual([...sets.collabIds], [dependentAgent], 'only the running dependent may be in collabIds')
  await driveUntil(f, sim, layout, () => sim.get(dependentAgent).state.stage === 'resting' && sim.get(dependentAgent).resource === 'collab', 3000, {
    message: 'the dependent must reach the whiteboard inside the window',
    onSync: () => { for (const [id, actor] of sim) if (id !== dependentAgent) assert.notEqual(actor.routeOverride, 'collab', `${id} must never take the collab route`) },
  })
  assert.equal(sim.get(dependentAgent).routeOverride, 'collab')
  assert.equal(sim.get(prereqAgent).routeOverride === 'collab', false, 'the completed prerequisite must not take the collab route')
  // Past the 60 s window both sides stop collaborating, the board is never
  // re-entered, and the still-running dependent walks back to its desk.
  // Wait for the coding phase first: the fake CLI needs ~100 ms after
  // dispatch to emit its first coding record, and a check inside that
  // window would still read the launch phase (thinking).
  await waitForTask(f, dependentId, item => item.status === 'running' && item.phase === 'coding')
  const pastWindow = await syncFromServer(f, sim, layout, handoffAt + COLLAB_WINDOW_MS + 10_000)
  assert.equal(pastWindow.statuses.get(dependentAgent).status, 'WORKING', 'past the window the running dependent is ordinary work again')
  assert.notEqual(pastWindow.statuses.get(prereqAgent).status, 'COLLABORATING')
  assert.equal(isCollaborating(dependent, handoffAt + COLLAB_WINDOW_MS + 10_000), false)
  assert.deepEqual([...pastWindow.collabIds], [], 'no collabIds may survive past the window')
  // The real 60 s window is still open in wall time, so the return drive
  // steps with the past-window sets (exactly what the scene would derive
  // a minute later) instead of re-syncing live sets that still contain
  // the handoff — re-syncing here would keep the agent at the board.
  let returned = false
  for (let i = 0; i < 3000 && !returned; i++) {
    stepOfficeSimulation(sim, ids, pastWindow.activeIds, DT, 'lively', { layout, planningIds: pastWindow.planningIds, collabIds: pastWindow.collabIds })
    returned = sim.get(dependentAgent).state.stage === 'working'
  }
  assert.equal(returned, true, 'the dependent must return to its desk after the window')
  assert.equal(sim.get(dependentAgent).routeOverride, undefined, 'the collab override must clear after the window')
  assert.notEqual(sim.get(dependentAgent).resource, 'collab')
  for (const [id, actor] of sim) assert.notEqual(actor.resource, 'collab', `${id} must not be on the whiteboard route outside the window`)
  assert.equal((await f.request(`/api/tasks/${dependentId}/cancel`, 'POST')).status, 200)
})

test('e. OFFLINE comes only from connected === false: all frozen, then thawed', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  const agents = (await f.request('/api/state')).body.agents
  const target = agents[0].id
  const layout = makeOfficeLayout(agents)
  const sim = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  const studioSrc = await readFile(new URL('../src/views/Studio.tsx', import.meta.url), 'utf8')
  assert.match(studioSrc, /OFFLINE: 'failed'/, 'the inspector dot for OFFLINE must be failed in Studio.tsx')
  assert.equal(agentStatusName.OFFLINE, 'Offline')

  const launched = await f.launch({ agentId: target, prompt: 'Long work [hold] [coding]' })
  assert.equal(launched.status, 201)
  const id = launched.body.task.id
  await waitForTask(f, id, item => item.status === 'running' && item.phase === 'coding')
  // The live snapshot always reports connected: true while it answers, and
  // providers only gate starting new tasks — neither is the offline signal.
  const live = await syncFromServer(f, sim, layout)
  assert.equal(live.state.connected, true, 'a live server snapshot must report connected: true')
  assert.ok(Array.isArray(live.state.providers) && live.state.providers.length > 0, 'the snapshot must carry the provider list')
  assert.equal(live.statuses.get(target).status, 'WORKING', 'connected with a running task must read WORKING, never OFFLINE')
  assert.equal(resolveAgentStatus(undefined, undefined, { connected: true }), 'IDLE', 'connected with no task must read IDLE')
  // Disconnect: every agent reads OFFLINE (even the one mid-task) and the
  // whole office freezes in place.
  const tasks = live.tasks
  for (const agent of agents) {
    assert.equal(describeAgent(tasks, agent.id, sim.get(agent.id)?.state, { connected: false }).status, 'OFFLINE', `${agent.id} must read OFFLINE when disconnected`)
  }
  const frozenIds = new Set(ids)
  const before = new Map([...sim].map(([agentId, actor]) => [agentId, [...actor.state.position]]))
  for (let i = 0; i < 600; i++) stepOfficeSimulation(sim, ids, new Set(), DT, 'lively', { layout, frozenIds })
  for (const [agentId, position] of before) assert.deepEqual(sim.get(agentId).state.position, position, `${agentId} moved while frozen`)
  // Reconnect: the same office resumes moving.
  let moved = false
  for (let i = 0; i < 2400 && !moved; i++) {
    stepOfficeSimulation(sim, ids, new Set([target]), DT, 'lively', { layout })
    moved = [...sim].some(([agentId, actor]) => actor.state.position[0] !== before.get(agentId)[0] || actor.state.position[1] !== before.get(agentId)[1])
  }
  assert.equal(moved, true, 'the office must resume moving after reconnecting')
  assert.equal((await f.request(`/api/tasks/${id}/cancel`, 'POST')).status, 200)
})

test('f. settings linkage: every preference switch changes stepOfficeSimulation behaviour', { timeout: 120000 }, async t => {
  // f1. activityRate: the same 1200 s idle office departs more often on
  // 'high' than on 'low'. Measured on this build: high [7,8,7,7] vs low
  // [4,4,3,3] departures per agent; the bounds below leave one spare each.
  for (const [rate, min, max] of [['high', 6, Infinity], ['low', 0, 5]]) {
    const layout = makeOfficeLayout(makeTeam(4))
    const sim = reconcileOfficeSimulation(layout)
    const ids = new Set(layout.seats.map(seat => seat.agent.id))
    const departures = new Map([...ids].map(id => [id, 0]))
    const prev = new Map([...sim].map(([id, actor]) => [id, actor.state.stage]))
    for (let i = 0; i < 24000; i++) {
      stepOfficeSimulation(sim, ids, new Set(), DT, 'lively', { layout, behavior: { activityRate: rate } })
      for (const [id, actor] of sim) {
        if (prev.get(id) === 'standing' && actor.state.stage === 'walking') departures.set(id, departures.get(id) + 1)
        prev.set(id, actor.state.stage)
      }
    }
    for (const [id, count] of departures) assert.ok(count >= min && count <= max, `${rate} departures for ${id} must be in [${min}, ${max}], got ${count}`)
  }
  // f2. Either break switch off on its own keeps everyone at the desk.
  for (const behavior of [{ breaksEnabled: false }, { wanderEnabled: false }]) {
    const layout = makeOfficeLayout(makeTeam(4))
    const sim = reconcileOfficeSimulation(layout)
    const ids = new Set(layout.seats.map(seat => seat.agent.id))
    for (let i = 0; i < 3000; i++) {
      stepOfficeSimulation(sim, ids, new Set(), DT, 'lively', { layout, behavior })
      for (const actor of sim.values()) assert.equal(actor.state.stage, 'standing', `${JSON.stringify(behavior)} must keep every agent standing`)
    }
  }
  // f3. windowThinkingEnabled: a live PLANNING phase pulls the agent to the
  // window only while the switch is on. The planning phase is observed on a
  // real just-launched task (phase 'thinking' before its first output).
  const f = await fixture(t)
  const agents = (await f.request('/api/state')).body.agents
  const target = agents[0].id
  const launched = await f.launch({ agentId: target, prompt: 'Think it over [hold]' })
  assert.equal(launched.status, 201)
  const firstSeen = (await f.request('/api/state')).body.tasks.find(item => item.id === launched.body.task.id)
  assert.equal(firstSeen.status, 'running')
  assert.equal(firstSeen.phase, 'thinking', 'a just-launched task must start in the thinking phase')
  const fresh = (await f.request('/api/state')).body.tasks
  assert.equal(describeAgent(fresh, target, undefined, {}, Date.now()).status, 'PLANNING', 'the thinking phase must read PLANNING')
  for (const windowOn of [true, false]) {
    const layout = makeOfficeLayout(agents)
    const sim = reconcileOfficeSimulation(layout, new Map(), new Set(), { windowThinkingEnabled: windowOn })
    const ids = new Set(layout.seats.map(seat => seat.agent.id))
    let sawWindow = false, sawOverride = false
    for (let i = 0; i < 4000; i++) {
      stepOfficeSimulation(sim, ids, new Set(), DT, 'lively', {
        layout, planningIds: new Set([target]), routeOptions: { windowThinkingEnabled: windowOn },
      })
      const actor = sim.get(target)
      if (actor.resource.startsWith('window-')) sawWindow = true
      if (actor.routeOverride === 'window-planning') sawOverride = true
    }
    if (windowOn) {
      assert.equal(sawWindow, true, 'a planning agent must take the window route while the switch is on')
      assert.equal(sawOverride, true, 'a planning agent must carry the window-planning override while the switch is on')
    } else {
      assert.equal(sawWindow, false, 'a planning agent must never take the window route while the switch is off')
      assert.equal(sawOverride, false, 'a planning agent must never carry the window-planning override while the switch is off')
    }
  }
  assert.equal((await f.request(`/api/tasks/${launched.body.task.id}/cancel`, 'POST')).status, 200)
  // f4. All decoration off + a real dispatch (acceptance 8, linkage form):
  // 3000 idle steps with nobody leaving, then the real task still seats
  // the agent and returns it to standing with zero break travel at all.
  {
    const layout = makeOfficeLayout(agents)
    const sim = reconcileOfficeSimulation(layout, new Map(), new Set(), { windowThinkingEnabled: false })
    const ids = new Set(layout.seats.map(seat => seat.agent.id))
    const off = { layout, behavior: { activityRate: 'low', breaksEnabled: false, wanderEnabled: false }, routeOptions: { windowThinkingEnabled: false } }
    const travelling = new Set()
    const watch = () => {
      for (const actor of sim.values()) {
        if (['walking', 'coffee', 'resting', 'returning'].includes(actor.state.stage)) travelling.add(actor.state.stage)
        assert.equal(actor.resource.startsWith('window-'), false, 'decoration off must keep every agent off the window route')
        assert.notEqual(actor.resource, 'collab', 'decoration off must keep every agent off the whiteboard')
      }
    }
    for (let i = 0; i < 3000; i++) {
      stepOfficeSimulation(sim, ids, new Set(), DT, 'lively', { ...off, planningIds: new Set([target]) })
      watch()
      for (const actor of sim.values()) assert.equal(actor.state.stage, 'standing', 'an idle agent must stay standing with decoration off')
    }
    const second = await f.launch({ agentId: target, prompt: 'Real work with decoration off [delayed]' })
    assert.equal(second.status, 201)
    const secondId = second.body.task.id
    await waitForTask(f, secondId, item => item.status === 'running')
    await driveUntil(f, sim, layout, () => sim.get(target).state.stage === 'working', 4000, {
      message: 'a dispatched task must reach the working stage with decoration off',
      step: off,
      onSync: () => watch(),
    })
    const finished = await waitForTask(f, secondId, item => item.status !== 'running')
    assert.equal(finished.status, 'completed')
    await driveUntil(f, sim, layout, () => sim.get(target).state.stage === 'standing', 4000, {
      message: 'a finished task must return the agent to standing with decoration off',
      step: off,
      onSync: () => watch(),
    })
    assert.equal(travelling.size, 0, `decoration off must cause no break travel at all (saw ${[...travelling]})`)
    assert.equal(sim.get(target).routeOverride, undefined, 'no route override may survive with decoration off')
  }
  // f5. performanceMode: the same 30-agent office sends nobody to the
  // crowd LOD on quality (cutoff 50) and the six farthest agents to it on
  // balanced (cutoff 24) — the exact split OfficeScene.tsx applies.
  {
    const big = makeOfficeLayout(makeTeam(30))
    assert.equal(big.seats.length, 30)
    const selected = big.seats[0]
    const dist = seat => (seat.position[0] - selected.position[0]) ** 2 + (seat.position[2] - selected.position[2]) ** 2
    const sorted = [...big.seats].sort((a, b) => dist(a) - dist(b))
    const split = mode => {
      const cutoff = resolvePerformanceSettings(mode).crowdDetailCutoff
      return { visible: sorted.slice(0, cutoff), distant: sorted.slice(cutoff) }
    }
    assert.equal(split('quality').distant.length, 0, 'quality must keep all 30 agents detailed')
    const balanced = split('balanced')
    assert.equal(balanced.distant.length, 6, 'balanced must send 6 far agents to the crowd LOD')
    assert.equal(balanced.visible.length, 24)
    const nearestDistant = Math.min(...balanced.distant.map(dist))
    const farthestVisible = Math.max(...balanced.visible.map(dist))
    assert.ok(nearestDistant >= farthestVisible, 'the LOD agents must be the farthest from the selected seat')
  }
})

test('give-way never steps onto the cat lane', () => {
  // The window leg runs at z = 1.73, only 0.87 m north of the cat lane
  // (z = 2.6): a south hop off it would land 0.07 m from the lane. Two
  // agents head-on on that leg must both end up north of it.
  const layout = makeOfficeLayout(makeTeam(4))
  const lane = catLaneZ(layout)
  assert.ok(Math.abs(1.73 - lane) > .8, `window leg must stay clear of the lane (lane ${lane})`)
  const seat = layout.seats[2]
  const { route } = routeForSeat(layout, seat, 2, 'window')
  const actorAt = (x, cursor, stage = 'walking') => ({
    route, resource: 'window-0', ordinal: 2, gait: 0,
    state: { ...createMovementState(route), stage, position: [x, 1.73], cursor, walking: true },
  })
  const check = (mover, blocker, label) => {
    const sim = new Map([['mover', mover], ['blocker', blocker]])
    const prior = mover.state
    const next = { ...prior, position: [prior.position[0] + (prior.cursor === 7 ? .07 : -.07), 1.73] }
    const candidate = giveWayStep('mover', route, prior, next, sim, layout)
    assert.ok(candidate, `give-way must find a hop for the ${label} agent`)
    assert.ok(Math.abs(candidate[1] - lane) >= .7, `the ${label} hop lands ${Math.abs(candidate[1] - lane).toFixed(2)} m from the cat lane`)
    assert.ok(candidate[1] < 1.73, `the ${label} hop must go north, away from the lane (got z=${candidate[1].toFixed(2)})`)
    return candidate
  }
  // Eastbound (returning from the window): its first hop is already north.
  const east = check(actorAt(4.0, 7), actorAt(4.75, 6), 'eastbound')
  assert.deepEqual(east.map(v => +v.toFixed(2)), [4.0, 0.93])
  // Westbound (going to the window): its first hop would be south onto the
  // lane, so the guard must push it north instead.
  const west = check(actorAt(4.0, 6), actorAt(3.25, 7), 'westbound')
  assert.deepEqual(west.map(v => +v.toFixed(2)), [4.0, 0.93])
})

test('g. cat and natural light linkage: the cat never touches task state or an agent', { timeout: 120000 }, async t => {
  // g1. Forced configuration: an agent parked at each window spot while the
  // cat runs a full 150 s cycle — the distance must stay >= 0.7 m in every
  // spacing. (Phase 6 fix: the stroll used to run at z = 1.6, only 0.13 m
  // from a window-parked agent at z = 1.73.)
  for (const spacing of ['compact', 'regular', 'spacious']) {
    const layout = makeOfficeLayout(makeTeam(4), spacing)
    for (const windowIndex of [0, 1]) {
      // Ordinal 2 rotates to window-0, ordinal 3 to window-1 (two spots).
      const ordinal = 2 + windowIndex
      const seat = layout.seats[ordinal]
      const { route, resource } = routeForSeat(layout, seat, ordinal, 'window')
      assert.equal(resource, `window-${windowIndex}`)
      const park = route.points[route.breakIndex]
      let minDistance = Infinity
      const poses = new Set()
      for (let seconds = 0; seconds <= CAT_CYCLE_S; seconds += .5) {
        const cat = catStateAt(seconds, layout, true)
        poses.add(cat.pose)
        minDistance = Math.min(minDistance, Math.hypot(park[0] - cat.position[0], park[1] - cat.position[1]))
      }
      assert.ok(minDistance >= .7, `cat comes within ${minDistance.toFixed(3)} m of a window-parked agent (${spacing}, window-${windowIndex})`)
      assert.deepEqual([...poses].sort(), ['lie', 'sit', 'walk'], 'the cat must sleep, sit and stroll in one cycle')
    }
  }
  // g2. Live task cycle: dispatch, execute and complete while sampling the
  // cat every step — it must stay clear of every agent and must not change
  // any agent's resource or routeOverride.
  const f = await fixture(t)
  const agents = (await f.request('/api/state')).body.agents
  const target = agents[0].id
  const layout = makeOfficeLayout(agents)
  const sim = reconcileOfficeSimulation(layout)
  const beforeResources = new Map([...sim].map(([id, actor]) => [id, `${actor.resource}:${actor.routeOverride ?? ''}`]))
  let minCatAgent = Infinity
  let simSeconds = 0
  const sampleCat = () => {
    const cat = catStateAt(simSeconds, layout, true)
    assert.notEqual(cat.pose, 'hidden', 'the cat must be visible while ambient animation is on')
    for (const actor of sim.values()) {
      minCatAgent = Math.min(minCatAgent, Math.hypot(actor.state.position[0] - cat.position[0], actor.state.position[1] - cat.position[1]))
    }
  }
  const tickCat = () => { simSeconds += DT; sampleCat() }
  const launched = await f.launch({ agentId: target, prompt: 'Work under the cat [delayed] [coding]' })
  assert.equal(launched.status, 201)
  const id = launched.body.task.id
  // A coding task goes to the chair; a thinking-phase task would go to the
  // window instead (that is the planning behaviour, not a failure to sit).
  await waitForTask(f, id, item => item.status === 'running' && item.phase === 'coding')
  await driveUntil(f, sim, layout, () => sim.get(target).state.stage === 'working', 2000, {
    paceMs: 10, onStep: tickCat,
  })
  const done = await waitForTask(f, id, item => item.status !== 'running')
  assert.equal(done.status, 'completed')
  await driveUntil(f, sim, layout, () => sim.get(target).state.stage === 'standing', 2000, {
    onStep: tickCat,
  })
  assert.ok(minCatAgent >= .7, `the cat came within ${minCatAgent.toFixed(3)} m of an agent during the task cycle`)
  for (const [agentId, resource] of beforeResources) {
    const actor = sim.get(agentId)
    assert.equal(`${actor.resource}:${actor.routeOverride ?? ''}`, resource, `the cat must not change ${agentId}'s resource or routeOverride`)
  }
  // g3. Ambient off freezes the light at noon and hides the cat.
  for (const seconds of [0, 30, 60, 90, 120, 149]) {
    assert.deepEqual(naturalLightAt(seconds, false), NATURAL_LIGHT_NEUTRAL, `ambient off must freeze the light at t=${seconds}`)
    assert.equal(catStateAt(seconds, layout, false).pose, 'hidden', `ambient off must hide the cat at t=${seconds}`)
  }
})

test('h. long run: 30 min of office time, task rounds interleaved, no churn, no overlap, no phantom completion', { timeout: 180000 }, async t => {
  // Budgets, written down so a future change must argue with them, not
  // silently pass: 30 min simulated (36000 steps x 0.05 s); at most 12
  // sit/stand transitions per agent (4 task rounds need at most 8);
  // no agent stuck in a transient stage (approaching/sitting/rising/
  // leaving) for 10 s simulated; pairwise distance >= 0.72 m throughout;
  // the last 5000 steps must cost at most 3x the first 5000.
  const TOTAL_STEPS = 36000
  const MAX_SIT_STAND_PER_AGENT = 12
  const MAX_TRANSIENT_S = 10
  const f = await fixture(t)
  const agents = (await f.request('/api/state')).body.agents
  const [atlas, nova, pixel, sentinel] = agents.map(agent => agent.id)
  const layout = makeOfficeLayout(agents)
  const sim = reconcileOfficeSimulation(layout)
  const transient = new Set(['approaching', 'sitting', 'rising', 'leaving'])
  const rec = {
    steps: 0, minPair: Infinity,
    sit: new Map(agents.map(agent => [agent.id, 0])), rise: new Map(agents.map(agent => [agent.id, 0])),
    transientEnter: new Map(), maxTransient: new Map(agents.map(agent => [agent.id, 0])),
    prev: new Map([...sim].map(([id, actor]) => [id, actor.state.stage])),
    seenStatuses: new Map(agents.map(agent => [agent.id, new Set()])),
  }
  const observe = () => {
    rec.steps++
    const positions = [...sim.values()].map(actor => actor.state.position)
    for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
      const d = Math.hypot(positions[i][0] - positions[j][0], positions[i][1] - positions[j][1])
      if (d < rec.minPair) rec.minPair = d
    }
    for (const [id, actor] of sim) {
      const stage = actor.state.stage, prev = rec.prev.get(id)
      if (stage !== prev) {
        if (stage === 'sitting') rec.sit.set(id, rec.sit.get(id) + 1)
        if (stage === 'rising') rec.rise.set(id, rec.rise.get(id) + 1)
        if (transient.has(stage) && !transient.has(prev)) rec.transientEnter.set(id, rec.steps)
        if (!transient.has(stage) && transient.has(prev) && rec.transientEnter.has(id)) {
          rec.maxTransient.set(id, Math.max(rec.maxTransient.get(id), (rec.steps - rec.transientEnter.get(id)) * DT))
        }
        rec.prev.set(id, stage)
      }
    }
  }
  const recordStatuses = sets => { for (const [id, entry] of sets.statuses) rec.seenStatuses.get(id).add(entry.status) }
  const timeChunk = async (count, opts = {}) => {
    const start = Date.now()
    await driveSync(f, sim, layout, count, { ...opts, onSync: sets => { recordStatuses(sets); opts.onSync?.(sets) }, onStep: observe })
    return Date.now() - start
  }
  const firstChunkMs = await timeChunk(5000)
  // Round 1: idle stretch, then a real task for atlas.
  await timeChunk(1000)
  const first = await f.launch({ agentId: atlas, prompt: 'Round one work [delayed] [coding]' })
  assert.equal(first.status, 201)
  await waitForTask(f, first.body.task.id, item => item.status === 'running' && item.phase === 'coding')
  await driveUntil(f, sim, layout, () => sim.get(atlas).state.stage === 'working', 2000, { onSync: recordStatuses, onStep: observe })
  const firstDone = await waitForTask(f, first.body.task.id, item => item.status !== 'running')
  assert.equal(firstDone.status, 'completed')
  await driveUntil(f, sim, layout, () => sim.get(atlas).state.stage === 'standing', 2000, { onSync: recordStatuses, onStep: observe })
  // Round 2: a real handoff. Nova must be standing when it lands, so wait
  // for that with the sim running, then stop stepping while the server
  // works so nobody moves out from under the handoff.
  await driveUntil(f, sim, layout, () => sim.get(nova).state.stage === 'standing', 6000, { onSync: recordStatuses, onStep: observe })
  const prereq = await f.launch({ agentId: pixel, prompt: 'Round two plan [delayed]' })
  assert.equal(prereq.status, 201)
  const dependent = await f.launch({ agentId: nova, prompt: 'Round two build [delayed]', dependsOn: prereq.body.task.id })
  assert.equal(dependent.status, 201)
  assert.equal(dependent.body.task.status, 'queued')
  await waitForTask(f, dependent.body.task.id, item => item.status === 'running')
  await driveUntil(f, sim, layout, () => sim.get(nova).state.stage === 'resting' && sim.get(nova).resource === 'collab', 3000, {
    message: 'nova must reach the whiteboard during the long run',
    onSync: recordStatuses, onStep: observe,
  })
  const dependentDone = await waitForTask(f, dependent.body.task.id, item => item.status !== 'running')
  assert.equal(dependentDone.status, 'completed')
  await driveUntil(f, sim, layout, () => sim.get(nova).state.stage === 'standing', 3000, { onSync: recordStatuses, onStep: observe })
  // Round 3: a real failure — it must read ERROR, never COMPLETED. The
  // [slow-fail] marker fails ~900 ms after launch (the plain [fail] lands
  // in ~50 ms, too fast to observe the agent sitting down first); [coding]
  // flips the phase so the agent goes to its chair instead of the window
  // (a thinking-phase task plans at the window by design).
  const failing = await f.launch({ agentId: sentinel, prompt: 'Round three work [slow-fail] [coding]' })
  assert.equal(failing.status, 201)
  await waitForTask(f, failing.body.task.id, item => item.status === 'running' && item.phase === 'coding')
  await driveUntil(f, sim, layout, () => sim.get(sentinel).state.stage === 'working', 2000, { onSync: recordStatuses, onStep: observe })
  const failed = await waitForTask(f, failing.body.task.id, item => item.status !== 'running')
  assert.equal(failed.status, 'failed')
  assert.ok(failed.failure, 'a failed task must record why')
  const errorNow = await syncFromServer(f, sim, layout, Date.parse(failed.finishedAt) + 1_000)
  assert.equal(errorNow.statuses.get(sentinel).status, 'ERROR', 'a just-failed task must read ERROR inside the terminal window')
  await driveUntil(f, sim, layout, () => sim.get(sentinel).state.stage === 'standing', 2000, { onSync: recordStatuses, onStep: observe })
  // Idle tail to the full 30 simulated minutes, timing the last chunk.
  const remaining = TOTAL_STEPS - rec.steps
  assert.ok(remaining >= 5000, `the scripted rounds must leave at least 5000 steps for the tail, got ${remaining}`)
  await timeChunk(remaining - 5000)
  const tailMs = await timeChunk(5000)
  assert.equal(rec.steps, TOTAL_STEPS, `the long run must cover exactly 30 simulated minutes (${TOTAL_STEPS} steps)`)
  // Assertions over the whole run.
  assert.ok(rec.minPair >= .72, `agents came within ${rec.minPair.toFixed(3)} m of each other during the long run`)
  for (const agent of agents) {
    const transitions = rec.sit.get(agent.id) + rec.rise.get(agent.id)
    assert.ok(transitions <= MAX_SIT_STAND_PER_AGENT, `${agent.id} sat/stood ${transitions} times in 30 min (limit ${MAX_SIT_STAND_PER_AGENT})`)
    assert.ok(rec.maxTransient.get(agent.id) < MAX_TRANSIENT_S, `${agent.id} stuck in a transient stage for ${rec.maxTransient.get(agent.id).toFixed(2)} s (limit ${MAX_TRANSIENT_S} s)`)
    assert.equal(transient.has(sim.get(agent.id).state.stage), false, `${agent.id} ends the run stuck in ${sim.get(agent.id).state.stage}`)
    const [x, z] = sim.get(agent.id).state.position
    assert.ok(x >= 0 && x <= layout.width && z >= 0 && z <= layout.depth, `${agent.id} ends the run out of bounds`)
  }
  assert.equal(rec.seenStatuses.get(sentinel).has('COMPLETED'), false, 'a failed task must never read COMPLETED')
  for (const id of [atlas, pixel, nova]) assert.equal(rec.seenStatuses.get(id).has('COMPLETED'), true, `${id} must read COMPLETED once during the long run`)
  assert.equal(rec.seenStatuses.get(sentinel).has('ERROR'), true, 'sentinel must read ERROR during the long run')
  const final = (await f.request('/api/state')).body.tasks
  const byId = new Map(final.map(task => [task.id, task]))
  assert.equal(byId.get(first.body.task.id).status, 'completed')
  assert.equal(byId.get(prereq.body.task.id).status, 'completed')
  assert.equal(byId.get(dependent.body.task.id).status, 'completed')
  assert.equal(byId.get(failing.body.task.id).status, 'failed')
  assert.ok(tailMs <= 3 * firstChunkMs, `last 5000 steps took ${tailMs} ms vs first 5000 steps ${firstChunkMs} ms — steady slowdown`)
})
