import test from 'node:test'
import assert from 'node:assert/strict'
import { makeOfficeLayout } from '../src/scene/officeLayout.ts'
import { DEFAULT_AGENTS, makeAgent, validateAgent, validStoredAgents } from '../server/agents.mjs'
import { advanceMovement, CHAIR_Z, CHAIR_APPROACH_Z, createMovementState, STAND_SIDE_X, STAND_Z, walkAt } from '../src/scene/officeMotion.ts'
import { makeAvatarRigPose } from '../src/scene/avatarRig.ts'
import { departmentDecor, livingZoneDecor } from '../src/scene/officeDecor.ts'
import { DEFAULT_OFFICE_PREFERENCES, normalizeOfficePreferences } from '../src/scene/officePreferences.ts'
import { layoutGeometryKey, routeForSeat, reconcileOfficeSimulation, stepOfficeSimulation } from '../src/scene/officeSimulation.ts'

const departments = ['architecture', 'engineering', 'design', 'quality', 'research', 'operations', 'security', 'data', 'general']

test('department furniture, noticeboards and planters remain disjoint and grounded in narrow pods', () => {
  const overlaps = (a, b) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 - .001 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 - .001 && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2 - .001
  for (const id of departments) for (const spacing of ['compact', 'regular', 'spacious']) {
    const layout = makeOfficeLayout(makeTeam(10).map(agent => ({ ...agent, department: id })), spacing)
    for (const sector of layout.sectors) {
      const decor = departmentDecor(id, sector.width, sector.depth)
      const boards = decor.boards.map(board => ({ x: board.x, y: board.y, z: board.z, width: board.w + .12, height: board.h + .12, depth: .18 }))
      const objects = [...boards, ...decor.furniture, ...(decor.planter ? [decor.planter] : [])]
      for (const item of decor.furniture) assert.ok(Math.abs(item.y - item.height / 2) < .001, 'standing furniture must touch the floor')
      for (let a = 0; a < objects.length; a++) for (let b = a + 1; b < objects.length; b++) assert.equal(overlaps(objects[a], objects[b]), false, `${id}/${spacing} contextual props intersect`)
      for (const seat of layout.seats.filter(seat => seat.sectorKey === sector.key)) {
        const tabletop = { x: seat.position[0] - sector.center[0], y: .95, z: seat.position[2] - sector.center[2] - .22, width: 2.5, height: .16, depth: 1.32 }
        for (const item of objects) assert.equal(overlaps(item, tabletop), false, `${id}/${spacing} decoration penetrates a workstation`)
      }
    }
  }
})

test('avatar rig connects all limbs and aligns seated hands with mouse and keyboard', () => {
  for (const seated of [0, .25, .5, .75, 1]) {
    for (const activity of ['idle', 'thinking', 'coding', 'researching', 'finishing', 'celebrating', 'error']) {
      const rig = makeAvatarRigPose(seated, false, 1.25, activity)
      assert.equal(rig.arms.length, 2)
      assert.equal(rig.legs.length, 2)
      for (const arm of rig.arms) {
        assert.ok(Math.hypot(...arm.shoulder.map((v, i) => v - arm.elbow[i])) > .1)
        assert.ok(Math.hypot(...arm.elbow.map((v, i) => v - arm.wrist[i])) > .1)
        assert.ok([...arm.shoulder, ...arm.elbow, ...arm.wrist].every(Number.isFinite))
      }
      for (const leg of rig.legs) {
        assert.ok(Math.hypot(...leg.hip.map((v, i) => v - leg.knee[i])) > .1)
        assert.ok(Math.hypot(...leg.knee.map((v, i) => v - leg.ankle[i])) > .1)
        assert.ok([...leg.hip, ...leg.knee, ...leg.ankle, ...leg.foot].every(Number.isFinite))
      }
    }
  }
  const seated = makeAvatarRigPose(1, false, 1.25, 'coding')
  // Rotating the avatar by PI puts its -X hand on the desk's +X mouse.
  const mouseHand = seated.arms[0].wrist
  assert.ok(Math.abs(-mouseHand[0] - .59) < .06, 'hand misses mouse')
  assert.ok(Math.abs(CHAIR_Z - mouseHand[2] - .16) < .06, 'hands miss desktop depth')
  assert.ok(mouseHand[1] > 1.08 && mouseHand[1] < 1.19, 'hands must hover over desk surface')
  assert.ok(Math.abs(seated.arms[1].wrist[0] - .26) < .02, 'other hand misses keyboard')
  const thinking = makeAvatarRigPose(1, false, 1.25, 'thinking')
  assert.ok(Math.abs(thinking.arms[1].wrist[0]) < .025, 'thinking hand must reach chin horizontally')
  assert.ok(Math.abs(thinking.arms[1].wrist[1] - 1.50) < .025, 'thinking hand must reach chin vertically')
  assert.ok(Math.abs(thinking.arms[1].wrist[2] - .27) < .025, 'thinking hand must be near face')
  assert.deepEqual(thinking.arms[0], seated.arms[0], 'thinking must keep mouse hand at desk')
  const beforeThought = makeAvatarRigPose(1, false, 1.25, 'thinking', 0)
  const midThought = makeAvatarRigPose(1, false, 1.25, 'thinking', .5)
  for (let axis = 0; axis < 3; axis++) {
    const expected = (thinking.arms[1].wrist[axis] + beforeThought.arms[1].wrist[axis]) / 2
    assert.ok(Math.abs(midThought.arms[1].wrist[axis] - expected) < .001, 'thinking hand transition must be continuous')
  }
  const idle = makeAvatarRigPose(0, false, 1.25, 'idle')
  assert.deepEqual(idle.arms[0].wrist, [-.4, 1.02, .12],
    'ambient idle animation must keep the arm in a neutral pose instead of inventing conversation')
  assert.ok(idle.bob < .009 && idle.bob > -.009, 'idle breathing must remain subtle')
})

test('walking shoes use alternating planted steps with stable leg lengths', () => {
  const samples = Array.from({ length: 33 }, (_, index) => index * Math.PI * 2 / 32)
  for (const phase of samples) {
    const pose = makeAvatarRigPose(0, 1, 0, 'idle', 0, phase)
    assert.ok(pose.legs.some(leg => Math.abs(leg.foot[1] - .078) < .00001), 'one shoe must remain planted')
    for (const leg of pose.legs) {
      const femur = Math.hypot(...leg.hip.map((n, i) => n - leg.knee[i]))
      const shin = Math.hypot(...leg.knee.map((n, i) => n - leg.ankle[i]))
      assert.ok(Math.abs(femur - .51) < .001, 'femur stretches while walking')
      assert.ok(Math.abs(shin - .50) < .001, 'shin stretches while walking')
      assert.ok(leg.foot[1] >= .078 - 1e-7, 'shoe clips the floor')
      assert.ok(Math.abs(leg.ankle[1] - leg.foot[1] - .105) < 1e-6, 'ankle misses the shoe collar')
      assert.ok(Math.abs(leg.ankle[2] - (leg.foot[2] - .075)) < 1e-6, 'shoe collar detached from ankle')
      assert.ok(leg.knee[1] > .60 && leg.knee[1] < .83, 'walking knee bends into crouch')
    }
  }
  const stopped = makeAvatarRigPose(0, 0, 0, 'idle', 0, 2)
  const moving = makeAvatarRigPose(0, 1, 0, 'idle', 0, 2)
  const settling = makeAvatarRigPose(0, .5, 0, 'idle', 0, 2)
  for (let leg = 0; leg < 2; leg++) {
    assert.ok(Math.abs(settling.legs[leg].foot[2] - (stopped.legs[leg].foot[2] + moving.legs[leg].foot[2]) / 2) < 1e-8)
  }
  for (const seated of [0, .2, .5, .8, 1]) {
    const pose = makeAvatarRigPose(seated, .4, 0, 'coding', 0, 1.7)
    for (const leg of pose.legs) {
      assert.ok(Math.abs(Math.hypot(...leg.hip.map((n, i) => n - leg.knee[i])) - .51) < .001, 'thigh stretches during seating')
      assert.ok(Math.abs(Math.hypot(...leg.knee.map((n, i) => n - leg.ankle[i])) - .50) < .001, 'shin stretches during seating')
      assert.ok(Math.abs(leg.ankle[2] - (leg.foot[2] - .075)) < .001, 'shoe collar separates during seating')
      assert.ok(leg.knee[1] > .63, 'knee sinks through chair cushion during sitting')
      if (seated >= .8) assert.ok(leg.knee[2] > .36, 'knee does not clear the front of the chair during sitting')
      const eased = seated * seated * (3 - 2 * seated)
      assert.ok(Math.abs(leg.hip[1] - (1.16 - eased * .4)) < .001, 'hips do not travel with the pelvis')
    }
    const eased = seated * seated * (3 - 2 * seated)
    assert.ok(Math.abs(pose.torsoDrop - eased * .4) < .001, 'torso is detached from the hip during seating')
  }
})
function makeTeam(count) {
  return Array.from({ length: count }, (_, index) => makeAgent({
    name: `Agent ${index}`, role: `Role ${index}`, specialty: `Specialty ${index}`,
    color: '#6474ab', department: departments[index % departments.length],
  }, `agent-${index}`))
}

function routeFor(layout, seat, ordinal) {
  return routeForSeat(layout, seat, ordinal).route
}

for (const spacing of ['compact', 'regular', 'spacious']) {
  test(`${spacing} modular layout includes connected corridors and valid agent paths`, () => {
    const layout = makeOfficeLayout(makeTeam(90), spacing)
    assert.ok(layout.passages.length > 0)
    assert.equal(layout.seats.length, 90)
    for (const seat of layout.seats) {
      const ordinal = layout.seats.filter(item => item.sector === seat.sector).indexOf(seat)
      const route = routeFor(layout, seat, ordinal)
      for (const phase of [0, 3, 5, 10, 20, 50, 150]) {
        const state = walkAt(route, phase, 'lively')
        assert.ok(Number.isFinite(state.position[0]) && Number.isFinite(state.position[1]))
        assert.ok(state.position[0] >= 0 && state.position[0] <= layout.width, 'route leaves the office width')
        assert.ok(state.position[1] >= 0 && state.position[1] <= layout.depth, 'route leaves the office depth')
      }
      assert.deepEqual(walkAt(route, 12, 'off').position, [seat.position[0] + STAND_SIDE_X, seat.position[2] + STAND_Z])
    }
  })
}

test('walking paths stay outside workstation and chair footprints across multiple team sizes', () => {
  for (const count of [1, 4, 20, 50, 100]) {
    for (const spacing of ['compact', 'regular', 'spacious']) {
      const layout = makeOfficeLayout(makeTeam(count), spacing)
      for (const seat of layout.seats) {
        const ordinal = layout.seats.filter(item => item.sector === seat.sector).indexOf(seat)
        const route = routeFor(layout, seat, ordinal)
        for (let segment = 0; segment < route.points.length - 1; segment++) {
          const [ax, az] = route.points[segment], [bx, bz] = route.points[segment + 1]
          // Sample the entire segment, not only the endpoints (diagonal cuts
          // through furniture are invisible to endpoint-only checks).
          for (let sample = 0; sample <= 12; sample++) {
            const t = sample / 12
            const px = ax + (bx - ax) * t, pz = az + (bz - az) * t
            for (const other of layout.seats) {
              const dx = Math.abs(px - other.position[0]), dz = pz - other.position[2]
              assert.ok(!(dx < 1.35 && dz > -.98 && dz < .55), `desk collision at ${count}/${spacing}/${seat.agent.id}`)
              assert.ok(!(dx < .55 && dz > .65 && dz < 1.67), `chair collision at ${count}/${spacing}/${seat.agent.id}`)
            }
          }
        }
      }
    }
  }
})

test('compact floor retains clear chair approaches, back-row walkways and scaled shared spaces', () => {
  for (const count of [1, 2, 3, 4, 8, 9, 20, 25, 50, 100, 250]) {
    for (const spacing of ['compact', 'regular', 'spacious']) {
      const layout = makeOfficeLayout(makeTeam(count), spacing)
      const farthestBayEdge = Math.max(...layout.sectors.map(sector => sector.center[2] + sector.depth / 2))
      assert.equal(layout.amenities.some(amenity => amenity.id === 'reception'), true)
      assert.equal(layout.amenities.some(amenity => amenity.id === 'meeting'), count >= 3)
      assert.equal(layout.amenities.filter(amenity => amenity.id === 'coffee').length,
        new Set(layout.sectors.map(sector => sector.row)).size)
      if (layout.amenities.length) {
        const meeting = layout.amenities.find(amenity => amenity.id === 'meeting')
        if (meeting) assert.ok(meeting.x + 2.2 < layout.spineX - .5, 'meeting furniture overlaps the circulation spine')
        const coffee = layout.amenities.find(amenity => amenity.id === 'coffee')
        if (coffee) assert.ok(coffee.z + .82 < layout.depth, 'coffee stop leaves the office floor')
        for (const amenity of layout.amenities) {
          assert.ok(amenity.x > 0 && amenity.x < layout.width)
          assert.ok(amenity.z < layout.depth)
        }
      } else assert.ok(layout.depth > farthestBayEdge)
      for (const seat of layout.seats) {
        const sector = layout.sectors.find(item => item.key === seat.sectorKey)
        const ordinal = layout.seats.filter(item => item.sector === seat.sector).indexOf(seat)
        const route = routeFor(layout, seat, ordinal)
        const bayEnd = sector.center[2] + sector.depth / 2
        assert.ok(route.points[3][1] - bayEnd > .4, 'exit route must reach the shared corridor beyond the bay')
        assert.ok(route.points[3][1] - (seat.position[2] + CHAIR_Z + .55) > .6,
          'rear walkway is too close to the last row of chairs')
      }
    }
  }
})

test('living zones place rest, window and whiteboard areas inside the floor without overlap', () => {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  const clearOfSectors = (layout, point, margin) => layout.sectors.every(sector =>
    Math.abs(point.x - sector.center[0]) > sector.width / 2 + margin ||
    Math.abs(point.z - sector.center[2]) > sector.depth / 2 + margin)
  for (const count of [0, 1, 2, 3, 4, 9, 20, 25, 100, 250]) {
    for (const spacing of ['compact', 'regular', 'spacious']) {
      const label = `${count}/${spacing}`
      const layout = makeOfficeLayout(makeTeam(count), spacing)
      // The new amenity types exist, with one rest area, two window spots and
      // one independently named whiteboard zone.
      assert.equal(layout.amenities.some(amenity => amenity.id === 'rest'), true, `${label} rest area missing`)
      assert.equal(layout.amenities.filter(amenity => amenity.id === 'window').length, 2, `${label} window zone needs two thinking spots`)
      assert.equal(layout.collabZone.key, 'collab', `${label} whiteboard zone must keep its own name`)
      assert.equal(layout.collabZone.row, 0, `${label} whiteboard zone sits in the first row`)
      assert.equal(layout.restSeats.length, 3, `${label} rest area needs three sofa seats`)
      // Every zone point stays inside the floor.
      for (const amenity of layout.amenities) {
        assert.ok(amenity.x > 0 && amenity.x < layout.width, `${label} amenity ${amenity.key} leaves the floor width`)
        assert.ok(amenity.z > 0 && amenity.z < layout.depth, `${label} amenity ${amenity.key} leaves the floor depth`)
      }
      for (const seat of layout.restSeats) {
        assert.ok(seat.x > 0 && seat.x < layout.width, `${label} rest seat leaves the floor width`)
        assert.ok(seat.z > 0 && seat.z < layout.depth, `${label} rest seat leaves the floor depth`)
      }
      assert.ok(layout.collabZone.x > 0 && layout.collabZone.x < layout.width, `${label} whiteboard zone leaves the floor width`)
      assert.ok(layout.collabZone.z > 0 && layout.collabZone.z < layout.depth, `${label} whiteboard zone leaves the floor depth`)
      // The rest amenity marks the middle sofa seat.
      const rest = layout.amenities.find(amenity => amenity.id === 'rest')
      assert.deepEqual([rest.x, rest.z], [layout.restSeats[1].x, layout.restSeats[1].z], `${label} rest amenity must mark the middle sofa seat`)
      // Sofa seats never overlap each other or a workstation bay.
      for (let a = 0; a < layout.restSeats.length; a++) for (let b = a + 1; b < layout.restSeats.length; b++)
        assert.ok(dist(layout.restSeats[a], layout.restSeats[b]) >= 1.0, `${label} rest seats overlap`)
      for (const seat of layout.restSeats) assert.equal(clearOfSectors(layout, seat, .5), true, `${label} rest seat invades a workstation bay`)
      const lastCoffee = layout.amenities.filter(amenity => amenity.id === 'coffee').at(-1)
      if (lastCoffee) for (const seat of layout.restSeats)
        assert.ok(dist(seat, { x: lastCoffee.x, z: lastCoffee.z + .98 }) >= 1.0, `${label} rest seat crowds the coffee stop`)
      // Window spots stay apart, north of reception and clear of the bays.
      const windows = layout.amenities.filter(amenity => amenity.id === 'window')
      assert.ok(dist(windows[0], windows[1]) >= 2.0, `${label} window spots overlap`)
      const reception = layout.amenities.find(amenity => amenity.id === 'reception')
      for (const spot of windows) {
        assert.ok(dist(spot, reception) >= 2.0, `${label} window spot crowds reception`)
        assert.equal(clearOfSectors(layout, spot, .5), true, `${label} window spot invades a workstation bay`)
      }
      // The whiteboard spot keeps its distance from the meeting circle, every
      // coffee point, the rest area and the window spots.
      const meeting = layout.amenities.find(amenity => amenity.id === 'meeting')
      if (meeting) assert.ok(dist(layout.collabZone, meeting) >= 2.6, `${label} whiteboard zone crowds the meeting circle`)
      for (const coffee of layout.amenities.filter(amenity => amenity.id === 'coffee'))
        assert.ok(dist(layout.collabZone, coffee) >= 2.0, `${label} whiteboard zone crowds a coffee point`)
      for (const seat of layout.restSeats) assert.ok(dist(layout.collabZone, seat) >= 2.0, `${label} whiteboard zone crowds the rest area`)
      for (const spot of windows) assert.ok(dist(layout.collabZone, spot) >= 3.0, `${label} whiteboard zone crowds a window spot`)
    }
  }
})

test('living zone decor stays grounded and within its zone footprint', () => {
  for (const zone of ['rest', 'window', 'collab']) {
    const decor = livingZoneDecor(zone)
    for (const item of decor.furniture) assert.ok(Math.abs(item.y - item.height / 2) < .001, `${zone} furniture must touch the floor`)
    for (const item of [...decor.boards, ...decor.furniture, ...decor.planters])
      assert.ok(Object.values(item).filter(value => typeof value === 'number').every(Number.isFinite), `${zone} decor must use finite coordinates`)
  }
  const rest = livingZoneDecor('rest')
  assert.equal(rest.furniture.filter(item => item.kind === 'books').length, 1, 'rest area needs one bookshelf')
  assert.equal(rest.planters.length, 1, 'rest area needs one plant')
  assert.equal(livingZoneDecor('window').planters.length, 1, 'window zone needs one plant')
  const collab = livingZoneDecor('collab')
  assert.equal(collab.boards.length, 1, 'whiteboard zone needs one board')
  assert.ok(collab.boards[0].w <= 1.5, 'whiteboard must fit the band between meeting and coffee')
})

test('corporate floor grows through bounded team pods with a real service wing', () => {
  for (const count of [1, 2, 3, 4, 20]) {
    const team = makeTeam(count).map(agent => ({ ...agent, department: 'engineering' }))
    const layout = makeOfficeLayout(team)
    assert.ok(layout.width >= 17, 'floor must include reception and circulation, not only desks')
    assert.ok(layout.depth >= 13, 'support wing needs usable depth')
    assert.ok(layout.sectors.every(sector => sector.count <= 9), 'large departments must branch into pods instead of an endless desk row')
    if (count <= 6) assert.equal(layout.sectors.length, 1, 'small teams must sit together')
    for (const seat of layout.seats) {
      const sector = layout.sectors.find(item => item.key === seat.sectorKey)
      const left = seat.position[0] - 1.25, right = seat.position[0] + 1.25
      assert.ok(left > sector.center[0] - sector.width / 2 && right < sector.center[0] + sector.width / 2, 'desk exceeds bay bounds')
    }
  }
})

test('work transitions return along walkways, sit at the monitor and rise coherently', () => {
  const layout = makeOfficeLayout(makeTeam(4))
  const seat = layout.seats[0]
  const route = routeFor(layout, seat, 0)
  let state = createMovementState(route)
  for (let i = 0; i < 1000 && state.stage !== 'coffee'; i++) state = advanceMovement(state, route, .05, false, 'lively', 0)
  assert.equal(state.stage, 'coffee')
  let sawReturn = false, sawSit = false, sawApproach = false
  for (let i = 0; i < 900 && state.stage !== 'working'; i++) {
    state = advanceMovement(state, route, .05, true, 'lively', 0)
    sawReturn ||= state.stage === 'returning'
    sawApproach ||= state.stage === 'approaching'
    sawSit ||= state.stage === 'sitting'
    if (state.stage === 'sitting') {
      assert.ok(Math.abs(state.position[0] - seat.position[0]) < .001, 'avatar cannot slide sideways through chair while sitting')
      assert.ok(state.position[1] >= seat.position[2] + CHAIR_APPROACH_Z - .001)
      assert.ok(state.position[1] <= seat.position[2] + CHAIR_Z + .001)
    }
  }
  assert.equal(sawReturn, true)
  assert.equal(sawApproach, true)
  assert.equal(sawSit, true)
  assert.equal(state.stage, 'working')
  assert.equal(state.seated, 1)
  assert.ok(Math.abs(state.position[0] - seat.position[0]) < .001)
  assert.ok(Math.abs(state.position[1] - seat.position[2] - CHAIR_Z) < .001)
  let sawLeave = false
  for (let i = 0; i < 150; i++) {
    state = advanceMovement(state, route, .05, false, 'off', 0)
    sawLeave ||= state.stage === 'leaving'
    if (state.stage === 'standing') break
  }
  assert.equal(sawLeave, true)
  assert.equal(state.stage, 'standing')
  assert.equal(state.seated, 0)
  assert.deepEqual(state.position, route.points[0])
})

test('idle agents take a visible coffee break without claiming a conversation or real work', () => {
  const layout = makeOfficeLayout(makeTeam(2))
  const seat = layout.seats[0]
  const route = routeFor(layout, seat, 0)
  let state = createMovementState(route)
  let sawPause = false
  for (let i = 0; i < 4000; i++) {
    state = advanceMovement(state, route, .05, false, 'lively', 0)
    assert.notEqual(state.stage, 'chatting', 'idle movement must not enter a conversation stage')
    sawPause ||= state.stage === 'coffee'
  }
  assert.equal(sawPause, true, 'the shared-space walk should include a coffee break')
  const sipping = makeAvatarRigPose(0, false, 2, 'idle', 0, 0, 1)
  assert.ok(sipping.arms[1].wrist[1] > 1.3, 'coffee break should lift the mug toward the face')
})

test('cancelling and restarting tasks during chair approach preserves continuous movement', () => {
  const layout = makeOfficeLayout(makeTeam(1))
  const route = routeFor(layout, layout.seats[0], 0)
  let state = createMovementState(route)
  const advance = active => {
    const before = state.position
    state = advanceMovement(state, route, .05, active, 'subtle', 0)
    assert.ok(Math.hypot(state.position[0] - before[0], state.position[1] - before[1]) < .08, 'position jumped between animation phases')
  }
  for (let i = 0; i < 14; i++) advance(true)
  assert.equal(state.stage, 'approaching')
  for (let i = 0; i < 12; i++) advance(false)
  assert.equal(state.stage, 'leaving')
  for (let i = 0; i < 120 && state.stage !== 'working'; i++) advance(true)
  assert.equal(state.stage, 'working')
  for (let i = 0; i < 6; i++) advance(false)
  assert.equal(state.stage, 'rising')
  for (let i = 0; i < 40 && state.stage !== 'working'; i++) advance(true)
  assert.equal(state.stage, 'working')
})

test('appearance preferences reject invalid persisted values and accept user selections', () => {
  assert.deepEqual(normalizeOfficePreferences(null), DEFAULT_OFFICE_PREFERENCES)
  assert.deepEqual(normalizeOfficePreferences({ theme: 'script', accent: 'url(javascript:bad)', motion: 'flying' }), DEFAULT_OFFICE_PREFERENCES)
  const chosen = normalizeOfficePreferences({ theme: 'warm', spacing: 'spacious', motion: 'off', accent: '#abcdef', social: false })
  assert.equal(chosen.theme, 'warm')
  assert.equal(chosen.spacing, 'spacious')
  assert.equal(chosen.motion, 'off')
  assert.equal('social' in chosen, false, 'obsolete social-animation preference is ignored')
  assert.deepEqual(normalizeOfficePreferences({ sectorColors: { engineering: '#ff1133', hacker: '#ffffff', design: 'red' } }).sectorColors, { engineering: '#ff1133' })
})

test('connecting corridors remain between rooms when one department is much larger', () => {
  const team = makeTeam(2)
  const large = Array.from({ length: 110 }, (_, index) => makeAgent({
    name: `Builder ${index}`, role: 'Developer', specialty: 'Build', color: '#6474ab', department: 'architecture',
  }, `builder-${index}`))
  const layout = makeOfficeLayout([...team, ...large])
  for (const sector of layout.sectors) {
    const coffee = layout.amenities.find(amenity => amenity.id === 'coffee' && amenity.row === sector.row)
    assert.ok(coffee.aisleZ > sector.center[2] + sector.depth / 2, 'each pod needs an unobstructed exit to its wing corridor')
    assert.ok(layout.passages.some(passage => Math.abs(passage.z - coffee.aisleZ) < .5))
  }
})

for (const count of [0, 1, 2, 4, 10, 20, 50, 100, 1000]) {
  test(`office layout seats exactly ${count} agents without collisions`, () => {
    const team = makeTeam(count)
    const layout = makeOfficeLayout(team)
    assert.equal(layout.seats.length, count)
    assert.deepEqual(layout.seats.map(seat => seat.agent.id).sort(), team.map(agent => agent.id).sort())
    const positions = layout.seats.map(seat => seat.position.join(','))
    assert.equal(new Set(positions).size, count)
    assert.ok(layout.sectors.length >= 1 && layout.sectors.every(sector => sector.count <= 9))
    assert.equal(new Set(layout.sectors.map(sector => sector.key)).size, layout.sectors.length)
    for (const seat of layout.seats) {
      const sector = layout.sectors.find(area => area.key === seat.sectorKey)
      assert.ok(sector)
      assert.equal(seat.sector, count <= 6 ? 'general' : seat.agent.department)
      assert.ok(Math.abs(seat.position[0] - sector.center[0]) < sector.width / 2)
      assert.ok(Math.abs(seat.position[2] - sector.center[2]) < sector.depth / 2)
    }
  })
}

test('default legacy agents remain compatible with persisted history', () => {
  assert.deepEqual(DEFAULT_AGENTS.map(agent => agent.id), ['atlas', 'nova', 'pixel', 'sentinel'])
  assert.equal(validStoredAgents(DEFAULT_AGENTS), true)
  assert.equal(validStoredAgents([]), true)
  assert.equal(validStoredAgents(makeTeam(20)), true)
  assert.equal(validStoredAgents([...DEFAULT_AGENTS, DEFAULT_AGENTS[0]]), false)
})

test('snapshot refresh preserves movement, and declarations of leadership only guide seating', () => {
  const layout = makeOfficeLayout(DEFAULT_AGENTS)
  assert.equal(layout.seats[0].agent.id, 'atlas')
  assert.equal(layout.seats[0].placement, 'lead')
  const original = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  for (let i = 0; i < 700; i++) stepOfficeSimulation(original, ids, new Set(), .05, 'lively')
  const refreshed = reconcileOfficeSimulation(makeOfficeLayout(DEFAULT_AGENTS.map(agent => ({ ...agent }))), original)
  for (const [id, actor] of original) assert.equal(refreshed.get(id).state, actor.state, 'SSE refresh must not reset pose or position')
})

test('simultaneous idle routines reserve cafe wings, keep distance and release visits for tasks', () => {
  const layout = makeOfficeLayout(makeTeam(20))
  const simulation = reconcileOfficeSimulation(layout)
  const ids = new Set(layout.seats.map(seat => seat.agent.id))
  const visited = new Set()
  for (let i = 0; i < 3600; i++) {
    stepOfficeSimulation(simulation, ids, new Set(), .05, 'lively')
    const occupied = new Set()
    for (const [id, actor] of simulation) {
      if (['walking', 'coffee', 'returning'].includes(actor.state.stage)) {
        assert.equal(occupied.has(actor.resource), false, 'only one visit can occupy a shared kitchenette route')
        occupied.add(actor.resource)
      }
      if (actor.state.stage === 'coffee') visited.add(id)
      for (const [otherId, other] of simulation) if (otherId !== id) {
        assert.ok(Math.hypot(actor.state.position[0] - other.state.position[0], actor.state.position[1] - other.state.position[1]) >= .72 - 1e-8, 'characters overlap during simultaneous movement')
      }
    }
  }
  assert.ok(visited.size >= 3, 'the queue should allow different agents to reach the cafe')
  for (let i = 0; i < 2400; i++) stepOfficeSimulation(simulation, ids, ids, .05, 'lively')
  assert.ok([...simulation.values()].every(actor => actor.state.stage === 'working'), 'new tasks must interrupt visits and return everyone to their desk')
})

test('agent editing rejects malformed input and malicious values', () => {
  assert.equal(validateAgent({ name: 'test', role: 'dev', specialty: 'code', color: '#abcdef', department: 'engineering' }), null)
  assert.ok(validateAgent({ name: '<script>\n', role: 'dev', specialty: 'code', color: '#abcdef', department: 'engineering' }))
  assert.ok(validateAgent({ name: 'ok', role: 'dev', specialty: 'code', color: 'red', department: 'engineering' }))
  assert.ok(validateAgent({ name: 'ok', role: 'dev', specialty: 'code', color: '#abcdef', department: 'admin' }))
})

test('geometry rebuilds are distinct from metadata snapshots and restore actual work poses', () => {
  const original = makeOfficeLayout(DEFAULT_AGENTS)
  const metadata = makeOfficeLayout(DEFAULT_AGENTS.map(agent => ({ ...agent, name: agent.name + ' updated', color: '#123456' })))
  assert.equal(layoutGeometryKey(metadata), layoutGeometryKey(original), 'profile-only updates must not rebuild the office')
  const changed = makeOfficeLayout(DEFAULT_AGENTS, 'spacious')
  assert.notEqual(layoutGeometryKey(changed), layoutGeometryKey(original))
  const latest = makeOfficeLayout(DEFAULT_AGENTS, 'compact')
  assert.notEqual(layoutGeometryKey(latest), layoutGeometryKey(changed))
  const actors = reconcileOfficeSimulation(original)
  const held = reconcileOfficeSimulation(changed, actors)
  for (const [id, actor] of actors) assert.equal(held.get(id).state, actor.state, 'the old scene stays intact until the transition completes')
  const rebuilt = reconcileOfficeSimulation(latest, new Map(), new Set(['nova']))
  assert.equal(rebuilt.get('nova').state.stage, 'working')
  assert.equal(rebuilt.get('nova').state.seated, 1)
  const seat = latest.seats.find(item => item.agent.id === 'nova')
  assert.deepEqual(rebuilt.get('nova').state.position, [seat.position[0], seat.position[2] + CHAIR_Z])
})

test('distant actors finish tasks and chair transitions even after focus changes', () => {
  const team = makeTeam(100), layout = makeOfficeLayout(team)
  const simulation = reconcileOfficeSimulation(layout)
  const hidden = layout.seats.at(-1).agent.id
  const visible = new Set(layout.seats.slice(0, 50).map(seat => seat.agent.id))
  for (let i = 0; i < 200; i++) stepOfficeSimulation(simulation, visible, new Set([hidden]), .05, 'off')
  assert.equal(simulation.get(hidden).state.stage, 'working', 'a hidden active agent must actually approach and sit')
  const state = simulation.get(hidden).state
  stepOfficeSimulation(simulation, new Set([hidden]), new Set([hidden]), .05, 'off')
  assert.deepEqual(simulation.get(hidden).state.position, state.position, 'changing detail selection must preserve location')
  for (let i = 0; i < 200; i++) stepOfficeSimulation(simulation, visible, new Set(), .05, 'off')
  assert.equal(simulation.get(hidden).state.stage, 'standing', 'hidden agents must rise after work ends')
})
