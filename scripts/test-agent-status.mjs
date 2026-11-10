import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentStatus, describeAgent, isCollaborating, statusToPose, crowdTier, settleAgentStatus, COLLAB_WINDOW_MS, STATUS_HOLD_MS } from '../src/scene/agentStatus.ts'
import { TERMINAL_POSE_MS } from '../src/scene/agentBehavior.ts'
import { DEFAULT_OFFICE_PREFERENCES, normalizeOfficePreferences } from '../src/scene/officePreferences.ts'
import { agentStatusName } from '../src/components/taskDisplay.ts'
import { leisureAttemptIntervalSeconds, leisureStaySeconds, IDLE_BEFORE_LEISURE_S, createMovementState, advanceMovement } from '../src/scene/officeMotion.ts'
import { makeOfficeLayout } from '../src/scene/officeLayout.ts'
import { routeForSeat, routeToCollab, reconcileOfficeSimulation, stepOfficeSimulation } from '../src/scene/officeSimulation.ts'
import { makeAvatarRigPose } from '../src/scene/avatarRig.ts'
import { makeAgent } from '../server/agents.mjs'

const now = Date.parse('2026-10-12T12:00:00.000Z')
const stamp = ms => new Date(now + ms).toISOString()
const task = overrides => ({
  id: 't1', agentId: 'nova', status: 'running', phase: 'coding',
  createdAt: stamp(-60_000), updatedAt: stamp(-1_000), finishedAt: null,
  lastMessage: '', threadId: null, events: [], ...overrides,
})
const movement = stage => ({ stage, position: [0, 0], facing: Math.PI, seated: 0, walking: false, cursor: 0, waypoints: [], wait: 0, idleTime: 0, nextBreakIn: 0 })

test('priority: OFFLINE beats everything, BLOCKED beats WORKING', () => {
  const blocked = task({ awaitingApproval: true })
  assert.equal(resolveAgentStatus(blocked, undefined, {}, now), 'BLOCKED')
  assert.equal(resolveAgentStatus(blocked, undefined, { connected: false }, now), 'OFFLINE')
  assert.equal(resolveAgentStatus(blocked, undefined, { connected: true }, now), 'BLOCKED')
  assert.equal(resolveAgentStatus(blocked, undefined, {}, now), 'BLOCKED')
  // Awaiting approval only blocks a running task.
  assert.equal(resolveAgentStatus(task({ status: 'completed', finishedAt: stamp(-1_000), awaitingApproval: true }), undefined, {}, now), 'COMPLETED')
})

test('OFFLINE needs an explicit disconnected snapshot, never a missing task', () => {
  assert.equal(resolveAgentStatus(undefined, undefined, { connected: false }, now), 'OFFLINE')
  assert.equal(resolveAgentStatus(undefined, undefined, {}, now), 'IDLE')
  assert.equal(resolveAgentStatus(undefined, undefined, { connected: true }, now), 'IDLE')
  assert.equal(resolveAgentStatus(task(), undefined, { connected: undefined }, now), 'WORKING')
})

test('COMPLETED and ERROR only live inside the 8 second terminal window', () => {
  assert.equal(resolveAgentStatus(task({ status: 'completed', finishedAt: stamp(-1_000) }), undefined, {}, now), 'COMPLETED')
  assert.equal(resolveAgentStatus(task({ status: 'completed', finishedAt: stamp(-1_000) }), undefined, {}, now + TERMINAL_POSE_MS), 'IDLE')
  assert.equal(resolveAgentStatus(task({ status: 'failed', finishedAt: stamp(-1_000) }), undefined, {}, now), 'ERROR')
  assert.equal(resolveAgentStatus(task({ status: 'interrupted', finishedAt: stamp(-1_000) }), undefined, {}, now), 'ERROR')
  assert.equal(resolveAgentStatus(task({ status: 'failed', finishedAt: stamp(-1_000) }), undefined, {}, now + TERMINAL_POSE_MS), 'IDLE')
  assert.equal(resolveAgentStatus(task({ status: 'cancelled', finishedAt: stamp(-1_000) }), undefined, {}, now), 'IDLE')
})

test('COLLABORATING only inside the handoff event window', () => {
  const handoff = { id: 'e1', at: stamp(-10_000), kind: 'info', message: 'Handoff from Atlas: dashboard plan' }
  assert.equal(isCollaborating(task({ events: [handoff] }), now), true)
  assert.equal(resolveAgentStatus(task({ events: [handoff] }), undefined, {}, now), 'COLLABORATING')
  // The window is bounded: an old handoff is ordinary work again.
  assert.equal(isCollaborating(task({ events: [handoff] }), now + COLLAB_WINDOW_MS, COLLAB_WINDOW_MS), false)
  assert.equal(resolveAgentStatus(task({ events: [handoff] }), undefined, {}, now + COLLAB_WINDOW_MS), 'WORKING')
  // A queued task only records "Waiting for …" — never a handoff.
  const waiting = { id: 'e2', at: stamp(-1_000), kind: 'info', message: 'Waiting for Atlas to finish: plan' }
  assert.equal(isCollaborating(task({ status: 'queued', phase: 'idle', events: [waiting] }), now), false)
  assert.equal(resolveAgentStatus(task({ status: 'queued', phase: 'idle', events: [waiting] }), undefined, {}, now), 'IDLE')
  // The prerequisite side ("Handed off to …") collaborates after its own
  // 8 s completion window has passed.
  const handedOff = { id: 'e3', at: stamp(-10_000), kind: 'info', message: 'Handed off to Nova: dashboard plan' }
  assert.equal(resolveAgentStatus(task({ status: 'completed', finishedAt: stamp(-20_000), events: [handedOff] }), undefined, {}, now), 'COLLABORATING')
  assert.equal(resolveAgentStatus(task({ status: 'completed', finishedAt: stamp(-1_000), events: [handedOff] }), undefined, {}, now), 'COMPLETED')
})

test('running phases map to WORKING, PLANNING and RESEARCHING', () => {
  assert.equal(resolveAgentStatus(task({ phase: 'thinking' }), undefined, {}, now), 'PLANNING')
  assert.equal(resolveAgentStatus(task({ phase: 'idle' }), undefined, {}, now), 'PLANNING')
  assert.equal(resolveAgentStatus(task({ phase: 'researching' }), undefined, {}, now), 'RESEARCHING')
  assert.equal(resolveAgentStatus(task({ phase: 'coding' }), undefined, {}, now), 'WORKING')
  assert.equal(resolveAgentStatus(task({ phase: 'finishing' }), undefined, {}, now), 'WORKING')
})

test('a queued task never triggers WORKING', () => {
  assert.equal(resolveAgentStatus(task({ status: 'queued', phase: 'idle', dependsOn: 'other' }), undefined, {}, now), 'IDLE')
  assert.equal(resolveAgentStatus(task({ status: 'queued', phase: 'idle' }), movement('coffee'), {}, now), 'BREAK')
  const queued = task({ id: 'q', status: 'queued', phase: 'idle', updatedAt: stamp(-500) })
  assert.equal(describeAgent([queued], 'nova', undefined, {}, now).status, 'IDLE')
})

test('BREAK comes from the movement stage, and real work outranks it', () => {
  assert.equal(resolveAgentStatus(undefined, movement('coffee'), {}, now), 'BREAK')
  assert.equal(resolveAgentStatus(undefined, movement('resting'), {}, now), 'BREAK')
  assert.equal(resolveAgentStatus(undefined, movement('walking'), {}, now), 'IDLE')
  assert.equal(resolveAgentStatus(undefined, movement('standing'), {}, now), 'IDLE')
  assert.equal(resolveAgentStatus(task(), movement('coffee'), {}, now), 'WORKING')
})

test('status maps to one avatar pose and one far-view tier each', () => {
  assert.deepEqual(
    ['WORKING', 'PLANNING', 'RESEARCHING', 'IDLE', 'BREAK', 'COLLABORATING', 'COMPLETED', 'BLOCKED', 'ERROR', 'OFFLINE'].map(statusToPose),
    ['coding', 'thinking', 'researching', 'idle', 'idle', 'collaborating', 'celebrating', 'blocked', 'error', 'offline'])
  assert.equal(crowdTier('WORKING'), 'WORKING')
  assert.equal(crowdTier('PLANNING'), 'WORKING')
  assert.equal(crowdTier('RESEARCHING'), 'WORKING')
  assert.equal(crowdTier('COLLABORATING'), 'WORKING')
  assert.equal(crowdTier('BREAK'), 'BREAK')
  for (const status of ['IDLE', 'COMPLETED', 'BLOCKED', 'ERROR', 'OFFLINE']) assert.equal(crowdTier(status), 'IDLE')
  assert.equal(Object.keys(agentStatusName).length, 10)
  for (const status of ['WORKING', 'PLANNING', 'RESEARCHING', 'IDLE', 'BREAK', 'COLLABORATING', 'COMPLETED', 'BLOCKED', 'ERROR', 'OFFLINE'])
    assert.equal(typeof agentStatusName[status], 'string')
})

test('status changes hold briefly, but higher priority cuts through at once', () => {
  assert.equal(STATUS_HOLD_MS, 2_000)
  const first = settleAgentStatus(undefined, 'WORKING', now)
  assert.deepEqual(first, { status: 'WORKING', since: now })
  // A lower-priority switch inside the hold is deferred.
  assert.deepEqual(settleAgentStatus(first, 'IDLE', now + 500), first)
  assert.deepEqual(settleAgentStatus(first, 'BREAK', now + STATUS_HOLD_MS - 1), first)
  // After the hold it goes through.
  assert.deepEqual(settleAgentStatus(first, 'IDLE', now + STATUS_HOLD_MS), { status: 'IDLE', since: now + STATUS_HOLD_MS })
  // A higher-priority status never waits.
  assert.deepEqual(settleAgentStatus(first, 'BLOCKED', now + 100), { status: 'BLOCKED', since: now + 100 })
  assert.deepEqual(settleAgentStatus(first, 'OFFLINE', now), { status: 'OFFLINE', since: now })
  assert.deepEqual(settleAgentStatus(first, 'WORKING', now + 500), first)
})

test('describeAgent picks the running task and maps its pose', () => {
  const running = task({ id: 'run', phase: 'researching' })
  const done = task({ id: 'done', status: 'completed', finishedAt: stamp(-1_000), updatedAt: stamp(-2_000) })
  assert.deepEqual(describeAgent([done, running], 'nova', undefined, {}, now), { status: 'RESEARCHING', pose: 'researching', task: running })
  assert.deepEqual(describeAgent([], 'nova', undefined, {}, now), { status: 'IDLE', pose: 'idle', task: undefined })
})

test('behaviour preferences default on and reject invalid values', () => {
  assert.equal(DEFAULT_OFFICE_PREFERENCES.activityRate, 'normal')
  assert.equal(DEFAULT_OFFICE_PREFERENCES.breaksEnabled, true)
  assert.equal(DEFAULT_OFFICE_PREFERENCES.wanderEnabled, true)
  assert.equal(DEFAULT_OFFICE_PREFERENCES.ambientEnabled, true)
  assert.equal(DEFAULT_OFFICE_PREFERENCES.windowThinkingEnabled, true)
  assert.equal(DEFAULT_OFFICE_PREFERENCES.performanceMode, 'auto')
  assert.deepEqual(normalizeOfficePreferences(null), DEFAULT_OFFICE_PREFERENCES)
  const fallback = normalizeOfficePreferences({ activityRate: 'warp', breaksEnabled: 'yes', wanderEnabled: 1, ambientEnabled: null, windowThinkingEnabled: 'no', performanceMode: 'ultra' })
  assert.equal(fallback.activityRate, 'normal')
  assert.equal(fallback.breaksEnabled, true)
  assert.equal(fallback.wanderEnabled, true)
  assert.equal(fallback.ambientEnabled, true)
  assert.equal(fallback.windowThinkingEnabled, true)
  assert.equal(fallback.performanceMode, 'auto')
  const chosen = normalizeOfficePreferences({ activityRate: 'high', breaksEnabled: false, wanderEnabled: false, ambientEnabled: false, windowThinkingEnabled: false, performanceMode: 'balanced' })
  assert.equal(chosen.activityRate, 'high')
  assert.equal(chosen.breaksEnabled, false)
  assert.equal(chosen.wanderEnabled, false)
  assert.equal(chosen.ambientEnabled, false)
  assert.equal(chosen.windowThinkingEnabled, false)
  assert.equal(chosen.performanceMode, 'balanced')
})

test('leisure timing: 30 s idle gap, 120–240 s attempts, 20–50 s stays', () => {
  assert.equal(IDLE_BEFORE_LEISURE_S, 30)
  for (let ordinal = 0; ordinal < 12; ordinal++) {
    const normal = leisureAttemptIntervalSeconds('normal', ordinal)
    assert.ok(normal >= 120 && normal < 240, `normal interval ${normal}`)
    const low = leisureAttemptIntervalSeconds('low', ordinal)
    assert.ok(low >= 240 && low < 360, `low interval ${low}`)
    const high = leisureAttemptIntervalSeconds('high', ordinal)
    assert.ok(high >= 60 && high < 120, `high interval ${high}`)
    for (const stage of ['coffee', 'resting']) {
      const stay = leisureStaySeconds(stage, ordinal)
      assert.ok(stay >= 20 && stay <= 50, `stay ${stay}`)
    }
  }
  // No departure before the idle gap, even with the break stop free.
  const layout = makeOfficeLayout(makeTeam(4))
  const route = routeForSeat(layout, layout.seats[0], 0).route
  let state = createMovementState(route)
  for (let i = 0; i < 500; i++) state = advanceMovement(state, route, .05, false, 'lively', 0)
  assert.equal(state.stage, 'standing', '25 s idle must not depart yet')
  for (let i = 0; i < 400 && state.stage === 'standing'; i++) state = advanceMovement(state, route, .05, false, 'lively', 0)
  assert.equal(state.stage, 'walking', 'past 30 s idle the agent may depart')
  // Either behaviour switch off keeps everyone at the desk.
  state = createMovementState(route)
  for (let i = 0; i < 4000; i++) state = advanceMovement(state, route, .05, false, 'lively', 0, true, { breaksEnabled: false })
  assert.equal(state.stage, 'standing')
  state = createMovementState(route)
  for (let i = 0; i < 4000; i++) state = advanceMovement(state, route, .05, false, 'lively', 0, true, { wanderEnabled: false })
  assert.equal(state.stage, 'standing')
})

test('break routes rotate across pantry, rest and window with separate resources', () => {
  const layout = makeOfficeLayout(makeTeam(4))
  const seen = layout.seats.map((seat, ordinal) => routeForSeat(layout, seat, ordinal))
  assert.equal(seen[0].resource, 'coffee-0')
  assert.equal(seen[0].route.breakStage, 'coffee')
  assert.equal(seen[1].resource, 'rest-1')
  assert.equal(seen[1].route.breakStage, 'resting')
  assert.ok(seen[2].resource.startsWith('window-'))
  assert.equal(seen[2].route.breakStage, 'resting')
  for (const { route } of seen) {
    assert.ok(route.points.every(([x, z]) => x >= 0 && x <= layout.width && z >= 0 && z <= layout.depth), 'break route leaves the floor')
  }
  // Window thinking off removes the window from the rotation.
  const noWindow = layout.seats.map((seat, ordinal) => routeForSeat(layout, seat, ordinal, undefined, { windowThinkingEnabled: false }))
  assert.equal(noWindow.some(({ resource }) => resource.startsWith('window-')), false)
  // The whiteboard route is built on demand for real handoffs, never by rotation.
  const collab = routeToCollab(layout, layout.seats[0], 0)
  assert.equal(collab.resource, 'collab')
  assert.equal(collab.route.breakStage, 'resting')
  assert.ok(Math.abs(collab.route.points[collab.route.breakIndex][0] - layout.collabZone.x) < .001)
  assert.ok(Math.abs(collab.route.points[collab.route.breakIndex][1] - (layout.collabZone.z + .98)) < .001)
  assert.equal(seen.some(({ resource }) => resource === 'collab'), false)
})

test('OFFLINE freezes every agent in place', () => {
  const layout = makeOfficeLayout(makeTeam(4))
  const simulation = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  for (let i = 0; i < 1200; i++) stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively')
  const before = new Map([...simulation].map(([id, actor]) => [id, [...actor.state.position]]))
  for (let i = 0; i < 600; i++) stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively', { frozenIds: ids })
  for (const [id, position] of before) assert.deepEqual(simulation.get(id).state.position, position, `${id} moved while frozen`)
  // Unfrozen, the same idle team resumes moving.
  let moved = false
  for (let i = 0; i < 2400 && !moved; i++) {
    stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively')
    moved = [...simulation].some(([id, actor]) => actor.state.position[0] !== before.get(id)[0] || actor.state.position[1] !== before.get(id)[1])
  }
  assert.equal(moved, true)
})

test('new rig poses keep every limb connected', () => {
  for (const activity of ['blocked', 'collaborating', 'offline', 'celebrating']) {
    for (const seated of [0, .5, 1]) {
      const rig = makeAvatarRigPose(seated, false, 1.25, activity)
      for (const arm of rig.arms) {
        assert.ok(Math.hypot(...arm.shoulder.map((v, i) => v - arm.elbow[i])) > .1, `${activity} upper arm collapses`)
        assert.ok(Math.hypot(...arm.elbow.map((v, i) => v - arm.wrist[i])) > .1, `${activity} forearm collapses`)
        assert.ok([...arm.shoulder, ...arm.elbow, ...arm.wrist].every(Number.isFinite))
      }
    }
  }
  const celebrating = makeAvatarRigPose(0, false, 1.25, 'celebrating')
  assert.ok(celebrating.arms.every(arm => arm.wrist[1] > 1.7), 'celebration must raise both hands')
  const blocked = makeAvatarRigPose(0, false, 1.25, 'blocked')
  assert.ok(blocked.arms.every(arm => Math.abs(arm.wrist[0]) > .55), 'blocked shrug must open both palms outward')
  const collab = makeAvatarRigPose(0, false, 1.25, 'collaborating')
  assert.ok(collab.arms[1].wrist[2] > .5, 'collaboration must point the free hand forward')
  assert.deepEqual(makeAvatarRigPose(0, false, 1.25, 'offline').arms, makeAvatarRigPose(0, false, 1.25, 'idle').arms)
})

function makeTeam(count) {
  const departments = ['architecture', 'engineering', 'design', 'quality']
  return Array.from({ length: count }, (_, index) => makeAgent({
    name: `Agent ${index}`, role: `Role ${index}`, specialty: `Specialty ${index}`,
    color: '#6474ab', department: departments[index % departments.length],
  }, `agent-${index}`))
}
