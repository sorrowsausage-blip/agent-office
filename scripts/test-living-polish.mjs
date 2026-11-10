import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_OFFICE_PREFERENCES, normalizeOfficePreferences, resolvePerformanceMode, resolvePerformanceSettings } from '../src/scene/officePreferences.ts'
import { naturalLightAt, NATURAL_LIGHT_NEUTRAL, NATURAL_LIGHT_CYCLE_S } from '../src/scene/naturalLight.ts'
import { catStateAt, catResourcePoints, CAT_CYCLE_S } from '../src/scene/officeCat.ts'
import { makeOfficeLayout } from '../src/scene/officeLayout.ts'
import { routeForSeat, reconcileOfficeSimulation, stepOfficeSimulation } from '../src/scene/officeSimulation.ts'
import { createMovementState } from '../src/scene/officeMotion.ts'
import { makeAgent } from '../server/agents.mjs'

// Phase 5: visual detail, movement polish, performance — cat, natural
// light, behaviour settings, performance profiles. Every behaviour here is
// still driven by real state or a fixed clock; nothing fakes task work.
function makeTeam(count) {
  const departments = ['architecture', 'engineering', 'design', 'quality']
  return Array.from({ length: count }, (_, index) => makeAgent({
    name: `Agent ${index}`, role: `Role ${index}`, specialty: `Specialty ${index}`,
    color: '#6474ab', department: departments[index % departments.length],
  }, `agent-${index}`))
}

test('the six behaviour preferences default as documented and illegal values fall back', () => {
  const defaults = normalizeOfficePreferences({})
  assert.equal(defaults.activityRate, 'normal')
  assert.equal(defaults.breaksEnabled, true)
  assert.equal(defaults.wanderEnabled, true)
  assert.equal(defaults.ambientEnabled, true)
  assert.equal(defaults.windowThinkingEnabled, true)
  assert.equal(defaults.performanceMode, 'auto')
  assert.deepEqual(defaults, DEFAULT_OFFICE_PREFERENCES)
  // Illegal or wrong-typed values fall back per field, never throw, and
  // never change the storage key or the other fields.
  const cleaned = normalizeOfficePreferences({
    activityRate: 'turbo', performanceMode: 'ultra', breaksEnabled: 'yes',
    wanderEnabled: 0, ambientEnabled: null, windowThinkingEnabled: 'false',
    theme: 'daylight',
  })
  assert.equal(cleaned.activityRate, 'normal')
  assert.equal(cleaned.performanceMode, 'auto')
  assert.equal(cleaned.breaksEnabled, true)
  assert.equal(cleaned.wanderEnabled, true)
  assert.equal(cleaned.ambientEnabled, true)
  assert.equal(cleaned.windowThinkingEnabled, true)
  assert.equal(cleaned.theme, 'daylight')
})

test('performanceMode resolves to observably different rendering profiles', () => {
  const quality = resolvePerformanceSettings('quality')
  const balanced = resolvePerformanceSettings('balanced')
  assert.equal(quality.mode, 'quality')
  assert.equal(balanced.mode, 'balanced')
  assert.notEqual(quality.shadowMapSize, balanced.shadowMapSize)
  assert.notEqual(quality.dprMax, balanced.dprMax)
  assert.notEqual(quality.crowdDetailCutoff, balanced.crowdDetailCutoff)
  assert.ok(quality.shadowMapSize > balanced.shadowMapSize, 'quality must keep the larger shadow map')
  assert.ok(quality.dprMax > balanced.dprMax, 'quality must keep the higher DPR cap')
  assert.ok(quality.crowdDetailCutoff > balanced.crowdDetailCutoff, 'quality must keep more agents detailed')
  // Auto is a fixed device-capability mapping (see officePreferences.ts):
  // high-DPR screens and few-core machines get balanced, the rest quality.
  assert.equal(resolvePerformanceMode('auto', { devicePixelRatio: 3, hardwareConcurrency: 8 }), 'balanced')
  assert.equal(resolvePerformanceMode('auto', { devicePixelRatio: 1, hardwareConcurrency: 2 }), 'balanced')
  assert.equal(resolvePerformanceMode('auto', { devicePixelRatio: 1, hardwareConcurrency: 8 }), 'quality')
  assert.equal(resolvePerformanceMode('auto', {}), 'quality')
})

test('the cat stays in bounds, clear of every resource and off the desks', () => {
  for (const spacing of ['compact', 'regular', 'spacious']) {
    const layout = makeOfficeLayout(makeTeam(4), spacing)
    const resources = catResourcePoints(layout)
    let minResource = Infinity, minSeat = Infinity
    const poses = new Set()
    let previous = null, maxStep = 0
    for (let t = 0; t <= CAT_CYCLE_S; t += .5) {
      const state = catStateAt(t, layout, true)
      poses.add(state.pose)
      assert.ok(['sit', 'lie', 'walk'].includes(state.pose), `unexpected cat pose ${state.pose}`)
      const [x, z] = state.position
      assert.ok(x >= 0 && x <= layout.width && z >= 0 && z <= layout.depth, `cat out of bounds at t=${t}: ${x},${z}`)
      for (const [rx, rz] of resources) minResource = Math.min(minResource, Math.hypot(x - rx, z - rz))
      for (const seat of layout.seats) minSeat = Math.min(minSeat, Math.hypot(x - seat.position[0], z - seat.position[2]))
      if (previous) maxStep = Math.max(maxStep, Math.hypot(x - previous[0], z - previous[1]))
      previous = state.position
    }
    assert.ok(minResource >= .7, `cat comes within ${minResource.toFixed(2)} m of a resource point (${spacing})`)
    assert.ok(minSeat >= 1, `cat comes within ${minSeat.toFixed(2)} m of a desk (${spacing})`)
    assert.ok(maxStep < .5, `cat teleports ${maxStep.toFixed(2)} m in half a second (${spacing})`)
    assert.deepEqual([...poses].sort(), ['lie', 'sit', 'walk'], 'the cat must sleep, sit and stroll in one cycle')
  }
})

test('the cat hides when ambient animation is off', () => {
  const layout = makeOfficeLayout(makeTeam(4))
  for (const t of [0, 30, 60, 90, 120, 149]) {
    assert.equal(catStateAt(t, layout, false).pose, 'hidden', `cat must hide at t=${t} with ambient off`)
  }
})

test('natural light drifts slowly and freezes when ambient is off', () => {
  for (let t = 0; t <= NATURAL_LIGHT_CYCLE_S; t += 5) {
    const light = naturalLightAt(t, true)
    assert.ok(light.intensity >= 2.1 && light.intensity <= 2.7, `sun intensity ${light.intensity} out of range at t=${t}`)
    assert.match(light.color, /^#[0-9a-f]{6}$/)
  }
  assert.notEqual(naturalLightAt(0, true).color, naturalLightAt(45, true).color, 'the sun colour must drift across the cycle')
  assert.notEqual(naturalLightAt(0, true).intensity, naturalLightAt(45, true).intensity, 'the sun intensity must drift across the cycle')
  for (const t of [0, 45, 90, 179]) assert.deepEqual(naturalLightAt(t, false), NATURAL_LIGHT_NEUTRAL, 'ambient off must freeze the light at noon')
})

test('with all decoration off, real tasks still dispatch, return and complete (acceptance 8)', () => {
  const layout = makeOfficeLayout(makeTeam(4))
  // Reconcile with window thinking off, so the ordinary rotation itself
  // can never assign a window route either — the test must prove the
  // switch, not the luck of the rotation.
  const simulation = reconcileOfficeSimulation(layout, new Map(), new Set(), { windowThinkingEnabled: false })
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  const target = layout.seats[0].agent.id
  const off = { layout, behavior: { activityRate: 'low', breaksEnabled: false, wanderEnabled: false }, routeOptions: { windowThinkingEnabled: false } }
  const travelling = new Set()
  const watch = () => {
    for (const actor of simulation.values()) {
      if (['walking', 'coffee', 'resting', 'returning'].includes(actor.state.stage)) travelling.add(actor.state.stage)
      assert.ok(!actor.resource.startsWith('window-'), 'decoration off must keep every agent off the window route')
      assert.notEqual(actor.resource, 'collab', 'decoration off must keep every agent off the whiteboard')
    }
  }
  // Idle with a live planning phase and no task: nobody leaves the desk,
  // nobody takes the window route, nobody visits a break stop.
  for (let i = 0; i < 3000; i++) {
    stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively', { ...off, planningIds: new Set([target]) })
    watch()
    for (const actor of simulation.values()) assert.equal(actor.state.stage, 'standing', 'an idle agent must stay standing with decoration off')
  }
  // A real task dispatches: the agent walks to its chair and works.
  let working = false
  for (let i = 0; i < 4000 && !working; i++) {
    stepOfficeSimulation(simulation, ids, new Set([target]), .05, 'lively', off)
    watch()
    working = simulation.get(target).state.stage === 'working'
  }
  assert.equal(working, true, 'a dispatched task must reach the working stage with decoration off')
  // The task finishes: the agent stands back up and stays put — no break
  // visit, no window visit, no wandering, and the route override is clear.
  let standing = false
  for (let i = 0; i < 4000 && !standing; i++) {
    stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively', off)
    watch()
    standing = simulation.get(target).state.stage === 'standing'
  }
  assert.equal(standing, true, 'a finished task must return the agent to standing with decoration off')
  assert.equal(travelling.size, 0, `decoration off must cause no break travel at all (saw ${[...travelling]})`)
  assert.equal(simulation.get(target).routeOverride, undefined, 'no route override may survive with decoration off')
})

test('pacing advances the shared gait phase without a jump', () => {
  const layout = makeOfficeLayout(makeTeam(2))
  const seat = layout.seats[0]
  const config = routeForSeat(layout, seat, 0, 'window')
  const simulation = new Map([[seat.agent.id, { ...config, ordinal: 0, gait: 0, state: createMovementState(config.route) }]])
  const ids = new Set([seat.agent.id])
  const actor = () => simulation.get(seat.agent.id)
  let reachedPace = false
  for (let i = 0; i < 8000 && !reachedPace; i++) {
    stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively', { layout })
    reachedPace = actor().state.breakActivity === 'pace'
  }
  assert.equal(reachedPace, true, 'setup: the agent must reach the pacing activity at the window')
  // While pacing the body stays put but the gait phase advances steadily.
  const paceStart = actor().state.position
  let previousGait = actor().gait
  for (let i = 0; i < 40; i++) {
    stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively', { layout })
    assert.equal(actor().state.breakActivity, 'pace', 'the agent must keep pacing for the sample window')
    assert.ok(Math.hypot(actor().state.position[0] - paceStart[0], actor().state.position[1] - paceStart[1]) < .01, 'pacing must not move the body')
    const delta = actor().gait - previousGait
    assert.ok(delta > .2 && delta < .3, `pace gait step must be one clock tick, got ${delta.toFixed(3)}`)
    previousGait = actor().gait
  }
  assert.ok(actor().gait > 0, 'the gait phase must advance while pacing')
  // Leaving the pace into the walk home must not jump the phase either.
  let leftPace = false, lastPaceGait = actor().gait
  for (let i = 0; i < 4000 && !leftPace; i++) {
    const before = actor().gait
    stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively', { layout })
    if (actor().state.breakActivity !== 'pace') {
      assert.ok(Math.abs(actor().gait - before) < .4, `gait jumped ${Math.abs(actor().gait - before).toFixed(3)} when pacing stopped`)
      leftPace = true
    }
    lastPaceGait = actor().gait
  }
  assert.equal(leftPace, true, 'the agent must leave the pace and walk home')
  assert.ok(Number.isFinite(lastPaceGait), 'the gait phase must stay finite after pacing')
})
