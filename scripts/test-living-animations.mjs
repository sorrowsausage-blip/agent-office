import test from 'node:test'
import assert from 'node:assert/strict'
import { makeAvatarRigPose } from '../src/scene/avatarRig.ts'
import { isCollaborating } from '../src/scene/agentStatus.ts'
import { breakActivityFor, leisureStaySeconds, createMovementState, advanceMovement } from '../src/scene/officeMotion.ts'
import { makeOfficeLayout } from '../src/scene/officeLayout.ts'
import { routeForSeat, reconcileOfficeSimulation, stepOfficeSimulation } from '../src/scene/officeSimulation.ts'
import { makeAgent } from '../server/agents.mjs'

// Phase 4: interactive animations for the pantry, rest area, window and
// whiteboard. Every behaviour here is driven by real state — a break stop
// and the time spent there, a live planning phase, or a live handoff
// window — never by a timer or a random pick.
const now = Date.parse('2026-10-12T12:00:00.000Z')
const stamp = ms => new Date(now + ms).toISOString()
const task = overrides => ({
  id: 't1', agentId: 'agent-0', status: 'running', phase: 'coding',
  createdAt: stamp(-60_000), updatedAt: stamp(-1_000), finishedAt: null,
  lastMessage: '', threadId: null, events: [], ...overrides,
})

function makeTeam(count) {
  const departments = ['architecture', 'engineering', 'design', 'quality']
  return Array.from({ length: count }, (_, index) => makeAgent({
    name: `Agent ${index}`, role: `Role ${index}`, specialty: `Specialty ${index}`,
    color: '#6474ab', department: departments[index % departments.length],
  }, `agent-${index}`))
}

function driveToBreak(route, ordinal) {
  let state = createMovementState(route)
  for (let i = 0; i < 6000 && state.stage !== 'coffee' && state.stage !== 'resting'; i++)
    state = advanceMovement(state, route, .05, false, 'lively', ordinal)
  assert.ok(state.stage === 'coffee' || state.stage === 'resting', `never reached a break stop (stage ${state.stage})`)
  return state
}

// Consecutive duplicates collapsed, in the order the activities appear.
function collectBreakActivities(route, ordinal) {
  let state = driveToBreak(route, ordinal)
  const seen = []
  for (let i = 0; i < 4000 && (state.stage === 'coffee' || state.stage === 'resting'); i++) {
    if (state.breakActivity !== 'none' && seen.at(-1) !== state.breakActivity) seen.push(state.breakActivity)
    state = advanceMovement(state, route, .05, false, 'lively', ordinal)
  }
  assert.equal(state.breakActivity, 'none', 'the break activity must clear when the visit ends')
  return seen
}

test('breakActivityFor derives the pantry, rest and window sequences from the stop and the wait', () => {
  const coffeeStay = leisureStaySeconds('coffee', 0)
  assert.equal(breakActivityFor('coffee', 'coffee', 0, 0), 'pour')
  assert.equal(breakActivityFor('coffee', 'coffee', coffeeStay * .5, 0), 'brew')
  assert.equal(breakActivityFor('coffee', 'coffee', coffeeStay * .9, 0), 'take-cup')
  const restStay = leisureStaySeconds('resting', 1)
  assert.deepEqual([0, .25, .45, .65, .85].map(fraction => breakActivityFor('rest', 'resting', restStay * fraction, 1)),
    ['sit', 'read', 'drink', 'daydream', 'nap'])
  const windowStay = leisureStaySeconds('resting', 0)
  assert.deepEqual([0, .5, .9].map(fraction => breakActivityFor('window', 'resting', windowStay * fraction, 0)),
    ['gaze', 'think', 'pace'])
  assert.equal(breakActivityFor('collab', 'resting', 0, 0), 'discuss')
  assert.equal(breakActivityFor('coffee', 'standing', 0, 0), 'none')
  assert.equal(breakActivityFor(undefined, 'resting', 0, 0), 'none')
  assert.equal(breakActivityFor('rest', 'walking', 5, 0), 'none')
})

test('pantry visit cycles pour, brew and take-cup, and the mug only lifts at the end', () => {
  const layout = makeOfficeLayout(makeTeam(4))
  const route = routeForSeat(layout, layout.seats[0], 0).route
  assert.equal(route.breakKind, 'coffee')
  assert.deepEqual(collectBreakActivities(route, 0), ['pour', 'brew', 'take-cup'])
  // Pouring reaches forward over the cup; the sip reuses the coffee branch
  // and only lifts the mug toward the face.
  const pouring = makeAvatarRigPose(0, false, 1.25, 'pouring')
  assert.ok(pouring.arms[1].wrist[2] > .5, 'pouring hand must reach forward over the cup')
  assert.ok(pouring.arms[1].wrist[1] > 1.1 && pouring.arms[1].wrist[1] < 1.25, 'pouring hand must stay low over the cup')
  const sipping = makeAvatarRigPose(0, false, 2, 'idle', 0, 0, 1)
  assert.ok(sipping.arms[1].wrist[1] > 1.3, 'take-cup must lift the mug toward the face')
})

test('rest visit cycles sit, read, drink, daydream and nap with small hand and head changes only', () => {
  const layout = makeOfficeLayout(makeTeam(4))
  const route = routeForSeat(layout, layout.seats[1], 1, 'rest').route
  assert.equal(route.breakKind, 'rest')
  assert.deepEqual(collectBreakActivities(route, 1), ['sit', 'read', 'drink', 'daydream', 'nap'])
})

test('three rest visits use three separate sofa seats and never overlap', () => {
  const layout = makeOfficeLayout(makeTeam(4))
  const simulation = new Map(layout.seats.slice(0, 3).map((seat, ordinal) => {
    const config = routeForSeat(layout, seat, ordinal, 'rest')
    return [seat.agent.id, { ...config, ordinal, gait: 0, state: createMovementState(config.route) }]
  }))
  const ids = new Set(simulation.keys())
  assert.deepEqual([...simulation.values()].map(actor => actor.resource), ['rest-0', 'rest-1', 'rest-2'])
  const visited = new Set()
  for (let i = 0; i < 6000; i++) {
    stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively', { layout })
    const travelling = [...simulation.values()].filter(actor => ['walking', 'coffee', 'resting', 'returning'].includes(actor.state.stage))
    assert.equal(new Set(travelling.map(actor => actor.resource)).size, travelling.length, 'two rest visits share one sofa seat')
    for (const [id, actor] of simulation) {
      if (actor.state.stage === 'resting') visited.add(id)
      for (const [otherId, other] of simulation) if (otherId !== id) {
        assert.ok(Math.hypot(actor.state.position[0] - other.state.position[0], actor.state.position[1] - other.state.position[1]) >= .72 - 1e-8, 'rest visitors overlap')
      }
    }
    if (visited.size === 3) break
  }
  assert.equal(visited.size, 3, 'all three sofa seats must be reachable')
})

test('window visit cycles gaze, think and pace, and thinking works standing up', () => {
  const layout = makeOfficeLayout(makeTeam(4))
  const route = routeForSeat(layout, layout.seats[2], 2, 'window').route
  assert.equal(route.breakKind, 'window')
  assert.deepEqual(collectBreakActivities(route, 2), ['gaze', 'think', 'pace'])
  // Chin-on-hand thinking must work standing at the window, not only
  // seated at the desk (the desk pose is already covered by the layout suite).
  const thinking = makeAvatarRigPose(0, false, 1.25, 'thinking', 1)
  assert.ok(thinking.arms[1].wrist[1] > 1.4, 'standing thinking must lift the hand toward the chin')
  assert.ok(thinking.arms[1].wrist[2] > .2, 'standing thinking hand must be near the face')
  const seated = makeAvatarRigPose(1, false, 1.25, 'thinking', 1)
  assert.ok(Math.abs(seated.arms[1].wrist[1] - 1.50) < .025, 'seated thinking must still reach the chin')
})

test('a live planning phase walks to the window; the switch off keeps it away', () => {
  const layout = makeOfficeLayout(makeTeam(2))
  const simulation = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  const target = layout.seats[0].agent.id
  let sawWindow = false
  const activities = []
  for (let i = 0; i < 6000; i++) {
    stepOfficeSimulation(simulation, ids, new Set([target]), .05, 'lively', { layout, planningIds: new Set([target]) })
    const actor = simulation.get(target)
    if (actor.state.stage === 'resting' && actor.resource.startsWith('window-')) {
      sawWindow = true
      if (actor.state.breakActivity !== 'none' && activities.at(-1) !== actor.state.breakActivity) activities.push(actor.state.breakActivity)
      if (activities.length === 3) break
    }
  }
  assert.equal(sawWindow, true, 'a planning agent must reach the window')
  assert.deepEqual(activities, ['gaze', 'think', 'pace'])
  // Window thinking off: the same live planning phase must never take the
  // window route (it falls back to the ordinary rotation).
  const blocked = reconcileOfficeSimulation(layout)
  let tookWindow = false
  for (let i = 0; i < 6000; i++) {
    stepOfficeSimulation(blocked, ids, new Set([target]), .05, 'lively',
      { layout, planningIds: new Set([target]), routeOptions: { windowThinkingEnabled: false } })
    if ([...blocked.values()].some(actor => actor.resource.startsWith('window-'))) { tookWindow = true; break }
  }
  assert.equal(tookWindow, false, 'windowThinkingEnabled=false must keep every agent off the window route')
})

test('whiteboard is only visited inside a live handoff window, and both sides may share it', () => {
  // No handoff event at all: the rotation never assigns the whiteboard.
  assert.equal(isCollaborating(task(), now), false)
  const layout = makeOfficeLayout(makeTeam(4))
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  const quiet = reconcileOfficeSimulation(layout)
  for (let i = 0; i < 6000; i++) {
    stepOfficeSimulation(quiet, ids, new Set(), .05, 'lively', { layout })
    assert.equal([...quiet.values()].some(actor => actor.resource === 'collab'), false, 'no event must ever send an agent to the whiteboard')
    for (const [id, actor] of quiet) for (const [otherId, other] of quiet) if (otherId !== id) {
      assert.ok(Math.hypot(actor.state.position[0] - other.state.position[0], actor.state.position[1] - other.state.position[1]) >= .72 - 1e-8)
    }
  }
  // Inside the window both handoff partners walk to the board and discuss.
  const pair = reconcileOfficeSimulation(layout)
  const partners = [layout.seats[0].agent.id, layout.seats[1].agent.id]
  const visited = new Set()
  let sawDiscuss = false
  for (let i = 0; i < 6000; i++) {
    stepOfficeSimulation(pair, ids, new Set(partners), .05, 'lively', { layout, collabIds: new Set(partners) })
    for (const id of partners) {
      const actor = pair.get(id)
      if (actor.state.stage === 'resting' && actor.resource === 'collab') {
        visited.add(id)
        sawDiscuss ||= actor.state.breakActivity === 'discuss'
      }
    }
    for (const [id, actor] of pair) for (const [otherId, other] of pair) if (otherId !== id) {
      assert.ok(Math.hypot(actor.state.position[0] - other.state.position[0], actor.state.position[1] - other.state.position[1]) >= .72 - 1e-8, 'collaborators overlap at the whiteboard')
    }
    if (visited.size === 2 && sawDiscuss) break
  }
  assert.equal(visited.size, 2, 'both handoff partners must reach the whiteboard')
  assert.equal(sawDiscuss, true, 'whiteboard visitors must show the discussion activity')
  const [first, second] = partners.map(id => pair.get(id).state.position)
  assert.ok(Math.hypot(first[0] - second[0], first[1] - second[1]) >= 1.0, 'partners must stand at separate spots along the board, not on one point')
})

test('when the handoff window ends mid-visit the agent returns to its desk at once', () => {
  const layout = makeOfficeLayout(makeTeam(2))
  const simulation = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  const target = layout.seats[0].agent.id
  let atBoard = false
  for (let i = 0; i < 6000 && !atBoard; i++) {
    stepOfficeSimulation(simulation, ids, new Set([target]), .05, 'lively', { layout, collabIds: new Set([target]) })
    const actor = simulation.get(target)
    atBoard = actor.state.stage === 'resting' && actor.resource === 'collab'
  }
  assert.equal(atBoard, true, 'setup: agent must start at the whiteboard')
  // The window ends while the task is still running: the agent must leave
  // the board immediately and sit back down to work.
  let sawReturn = false, working = false
  for (let i = 0; i < 4000 && !working; i++) {
    stepOfficeSimulation(simulation, ids, new Set([target]), .05, 'lively', { layout, collabIds: new Set() })
    const actor = simulation.get(target)
    sawReturn ||= actor.state.stage === 'returning'
    working = actor.state.stage === 'working'
  }
  assert.equal(sawReturn, true, 'the whiteboard visit must end with a return, not a lingering stay')
  assert.equal(working, true, 'the agent must be back working at its desk')
  assert.equal(simulation.get(target).routeOverride, undefined, 'the collab override must clear after the return')
  assert.notEqual(simulation.get(target).resource, 'collab', 'the agent must be back on an ordinary route')
})

test('a new task ends a coffee break at once and returns the agent to its desk', () => {
  const layout = makeOfficeLayout(makeTeam(2))
  const simulation = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  const target = layout.seats[0].agent.id
  let atCoffee = false
  for (let i = 0; i < 6000 && !atCoffee; i++) {
    stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively', { layout })
    atCoffee = simulation.get(target).state.stage === 'coffee'
  }
  assert.equal(atCoffee, true, 'setup: agent must start on a coffee break')
  assert.ok(['pour', 'brew', 'take-cup'].includes(simulation.get(target).state.breakActivity), 'the coffee break must show a pantry activity')
  let sawReturn = false, working = false
  for (let i = 0; i < 4000 && !working; i++) {
    stepOfficeSimulation(simulation, ids, new Set([target]), .05, 'lively', { layout })
    const actor = simulation.get(target)
    sawReturn ||= actor.state.stage === 'returning'
    working = actor.state.stage === 'working'
    assert.equal(actor.state.breakActivity, actor.state.stage === 'coffee' ? actor.state.breakActivity : 'none', 'the break activity must clear once the agent leaves the stop')
  }
  assert.equal(sawReturn, true, 'a new task must interrupt the break with a return')
  assert.equal(working, true, 'the agent must be back working at its desk')
})

test('reading, napping and pouring keep every limb connected', () => {
  for (const activity of ['reading', 'napping', 'pouring']) {
    for (const seated of [0, .5, 1]) {
      const rig = makeAvatarRigPose(seated, false, 1.25, activity)
      for (const arm of rig.arms) {
        assert.ok(Math.hypot(...arm.shoulder.map((v, i) => v - arm.elbow[i])) > .1, `${activity} upper arm collapses`)
        assert.ok(Math.hypot(...arm.elbow.map((v, i) => v - arm.wrist[i])) > .1, `${activity} forearm collapses`)
        assert.ok([...arm.shoulder, ...arm.elbow, ...arm.wrist].every(Number.isFinite))
      }
      for (const leg of rig.legs) {
        assert.ok(Math.hypot(...leg.hip.map((v, i) => v - leg.knee[i])) > .1)
        assert.ok(Math.hypot(...leg.knee.map((v, i) => v - leg.ankle[i])) > .1)
      }
    }
  }
  const reading = makeAvatarRigPose(0, false, 1.25, 'reading')
  assert.ok(reading.arms.every(arm => Math.abs(arm.wrist[0]) < .2), 'reading hands must meet at the book')
  assert.ok(reading.arms.every(arm => arm.wrist[1] > 1.2 && arm.wrist[1] < 1.4), 'reading hands must be at chest height')
  assert.ok(reading.headPitch > .05, 'reading must tilt the head down toward the book')
  const napping = makeAvatarRigPose(0, false, 1.25, 'napping')
  assert.ok(napping.headPitch > .15, 'napping must drop the head')
  assert.ok(napping.arms.every(arm => arm.wrist[1] < 1.0), 'napping hands must rest low')
  assert.ok(Math.abs(napping.bob) <= .005 + 1e-9, 'napping breathing must stay shallow')
  const pouring = makeAvatarRigPose(0, false, 1.25, 'pouring')
  const idle = makeAvatarRigPose(0, false, 1.25, 'idle')
  assert.deepEqual(pouring.arms[0], idle.arms[0], 'pouring must leave the resting hand alone')
  assert.ok(pouring.arms[1].wrist[2] > .5, 'pouring hand must reach forward')
  assert.ok(pouring.headPitch > .05, 'pouring must look down at the cup')
})
