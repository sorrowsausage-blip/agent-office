import type { OfficeLayout, Seat, Sector } from './officeLayout'
import type { OfficeMotion } from './officePreferences'
import { advanceMovement, CHAIR_Z, IDLE_BEFORE_LEISURE_S, STAND_SIDE_X, STAND_Z, createMovementState, makeWalkRoute, type CoffeeStop, type MovementBehaviorOptions, type MovementState, type Route } from './officeMotion.ts'

export type RouteOverride = 'collab' | 'window-planning'
export type OfficeActor = { state: MovementState; route: Route; resource: string; ordinal: number; gait: number; routeOverride?: RouteOverride }
export type OfficeSimulation = Map<string, OfficeActor>
export type BreakDestination = 'coffee' | 'rest' | 'window' | 'collab'
export type RouteDestinationOptions = { windowThinkingEnabled?: boolean }
export type StepOfficeSimulationOptions = {
  behavior?: MovementBehaviorOptions
  frozenIds?: ReadonlySet<string>
  // Agents in a live planning phase (running task, thinking phase) and
  // agents inside a live handoff window (running task, Handoff event < 60 s
  // ago). Both sets are derived from real task state by the caller — never
  // from a timer or random choice — and only ever pull a standing agent.
  planningIds?: ReadonlySet<string>
  collabIds?: ReadonlySet<string>
  routeOptions?: RouteDestinationOptions
  // The layout is only needed for the phase-4 route swaps above; without
  // it the step behaves exactly as before (no overrides applied).
  layout?: OfficeLayout
}

export function layoutGeometryKey(layout: OfficeLayout): string {
  return JSON.stringify([layout.width, layout.depth, layout.seats.map(seat => [seat.agent.id, seat.position, seat.sectorKey]),
    layout.sectors.map(sector => [sector.key, sector.center, sector.width, sector.depth]), layout.amenities.map(area => [area.key, area.x, area.z, area.aisleZ])])
}

// One break stop per agent, rotated by seat ordinal so the four-person team
// spreads across the pantry, the rest area and the window instead of
// queuing at a single counter. The whiteboard is deliberately NOT part of
// the rotation: a collab visit must come from a real handoff (phase 4),
// never from a random idle walk.
function stopForDestination(layout: OfficeLayout, sector: Sector, ordinal: number, kind: BreakDestination): { stop?: CoffeeStop; resource: string } {
  const rowCoffee = layout.amenities.find(area => area.id === 'coffee' && area.row === sector.row)
  const aisleZ = rowCoffee?.aisleZ ?? sector.center[2] + sector.depth / 2 + .55
  const via = (stop: Omit<CoffeeStop, 'aisleZ' | 'spineX'>): CoffeeStop => ({ ...stop, aisleZ, spineX: layout.spineX })
  switch (kind) {
    case 'coffee':
      return rowCoffee ? { stop: { ...rowCoffee, spineX: layout.spineX }, resource: rowCoffee.key } : { resource: sector.key }
    case 'rest': {
      // Three sofa seats rotate so simultaneous rest visits never overlap;
      // each seat is its own reservation resource.
      const index = layout.restSeats.length ? ordinal % layout.restSeats.length : 0
      const seat = layout.restSeats[index]
      return seat ? { stop: via({ x: seat.x, z: seat.z, key: `rest-${index}`, breakStage: 'resting' }), resource: `rest-${index}` } : { resource: sector.key }
    }
    case 'window': {
      const spots = layout.amenities.filter(area => area.id === 'window')
      const spot = spots.length ? spots[ordinal % spots.length] : undefined
      return spot ? { stop: via({ x: spot.x, z: spot.z, key: spot.key, breakStage: 'resting' }), resource: spot.key } : { resource: sector.key }
    }
    case 'collab': {
      // Handoff partners share the one board, so their standing spots
      // spread along it: both must be able to arrive, and the first to
      // leave must not step straight into the second (the 0.72 m collision
      // check would revert its stay timer and deadlock the pair). Ordinal 0
      // keeps the exact zone point; the others step 1.1 m aside.
      const dx = ordinal === 0 ? 0 : ordinal % 2 === 1 ? 1.1 : -1.1
      return { stop: via({ x: layout.collabZone.x + dx, z: layout.collabZone.z, key: layout.collabZone.key, breakStage: 'resting' }), resource: layout.collabZone.key }
    }
  }
}

export function routeForSeat(layout: OfficeLayout, seat: Seat, ordinal: number, destination?: BreakDestination, opts: RouteDestinationOptions = {}): { route: Route; resource: string } {
  const sector = layout.sectors.find(area => area.key === seat.sectorKey)!
  const kinds: BreakDestination[] = opts.windowThinkingEnabled === false ? ['coffee', 'rest'] : ['coffee', 'rest', 'window']
  const kind = destination ?? kinds[ordinal % kinds.length]
  const { stop, resource } = stopForDestination(layout, sector, ordinal, kind)
  return { route: makeWalkRoute(seat, sector, ordinal, stop), resource }
}

// Whiteboard route for a real handoff. Phase 4 drives the departure; this
// only builds the aisle route and its reservation resource.
export function routeToCollab(layout: OfficeLayout, seat: Seat, ordinal: number): { route: Route; resource: string } {
  return routeForSeat(layout, seat, ordinal, 'collab')
}

// Equivalent snapshots update profiles while preserving world positions and gait.
// Actual geometry changes are atomically rebuilt behind the scene's fade transition.
export function reconcileOfficeSimulation(layout: OfficeLayout, previous: OfficeSimulation = new Map(), activeIds: ReadonlySet<string> = new Set(), opts: RouteDestinationOptions = {}): OfficeSimulation {
  return new Map(layout.seats.map((seat, ordinal) => {
    const config = routeForSeat(layout, seat, ordinal, undefined, opts)
    const existing = previous.get(seat.agent.id)
    if (existing) {
      // An agent standing at home may take the newly resolved destination;
      // anyone mid-walk, mid-break or seated keeps the route they are on.
      // A standing agent also drops any phase-4 override: the next frame
      // re-applies it from live task state if it is still valid.
      if (existing.state.stage === 'standing') return [seat.agent.id, { ...existing, ordinal, route: config.route, resource: config.resource, routeOverride: undefined }]
      return [seat.agent.id, { ...existing, ordinal }]
    }
    const state = createMovementState(config.route)
    if (activeIds.has(seat.agent.id)) {
      state.stage = 'working'; state.seated = 1
      state.position = [config.route.points[0][0] - STAND_SIDE_X, config.route.points[0][1] + CHAIR_Z - STAND_Z]
    }
    return [seat.agent.id, { ...config, ordinal, gait: 0, state }]
  }))
}

const traveling = (state: MovementState) => ['walking', 'coffee', 'resting', 'returning'].includes(state.stage)

// One complete idle visit reserves its break stop. Independent stops can
// host simultaneous visits; actual jobs always outrank breaks. Frozen
// (OFFLINE) agents do not move at all — they keep occupying their cell so
// nobody walks through them.
export function stepOfficeSimulation(simulation: OfficeSimulation, visibleIds: ReadonlySet<string>, activeIds: ReadonlySet<string>, dt: number, motion: OfficeMotion,
  options: StepOfficeSimulationOptions = {}) {
  const cell = (position: [number, number]) => `${Math.floor(position[0])},${Math.floor(position[1])}`
  const occupied = new Map<string, Set<string>>()
  const occupy = (id: string, position: [number, number]) => {
    const key = cell(position)
    if (!occupied.has(key)) occupied.set(key, new Set())
    occupied.get(key)!.add(id)
  }
  for (const [id, actor] of simulation) occupy(id, actor.state.position)
  // Phase 4 route overrides (strictly bounded): a standing agent may swap
  // to the whiteboard only inside a live handoff window, and to the window
  // only in a live planning phase — both checked here from the caller's
  // task-derived sets, never from a timer or a random pick. The swap seeds
  // the idle clock past the leisure gate (30 s + the largest per-agent
  // stagger) so the agent departs on the next frame instead of waiting out
  // another idle gap; a mid-walk, mid-break or seated agent never swaps.
  // When the window/phase ends, a standing agent falls back to the ordinary
  // rotation route; anyone already out is forced back by effectiveActive.
  if (options.layout && (options.collabIds?.size || options.planningIds?.size || [...simulation.values()].some(actor => actor.routeOverride))) {
    const layout = options.layout
    const seatsById = new Map(layout.seats.map(seat => [seat.agent.id, seat]))
    for (const [id, actor] of simulation) {
      if (options.frozenIds?.has(id) || actor.state.stage !== 'standing') continue
      const seat = seatsById.get(id)
      if (!seat) continue
      if (options.collabIds?.has(id)) {
        if (actor.routeOverride !== 'collab') {
          const config = routeToCollab(layout, seat, actor.ordinal)
          actor.route = config.route; actor.resource = config.resource; actor.routeOverride = 'collab'
          actor.state.idleTime = IDLE_BEFORE_LEISURE_S + 31; actor.state.nextBreakIn = 0
        }
        continue
      }
      if (options.planningIds?.has(id) && options.routeOptions?.windowThinkingEnabled !== false) {
        if (actor.routeOverride !== 'window-planning') {
          const config = routeForSeat(layout, seat, actor.ordinal, 'window', options.routeOptions)
          actor.route = config.route; actor.resource = config.resource; actor.routeOverride = 'window-planning'
          actor.state.idleTime = IDLE_BEFORE_LEISURE_S + 31; actor.state.nextBreakIn = 0
        }
        continue
      }
      if (actor.routeOverride) {
        const config = routeForSeat(layout, seat, actor.ordinal, undefined, options.routeOptions)
        actor.route = config.route; actor.resource = config.resource; actor.routeOverride = undefined
      }
    }
  }
  const reservations = new Set([...simulation.values()].filter(actor => traveling(actor.state)).map(actor => actor.resource))
  const candidates = [...simulation.entries()].filter(([id, actor]) => visibleIds.has(id) || traveling(actor.state) || activeIds.has(id) ||
    (actor.state.stage !== 'standing' && actor.state.stage !== 'working') || (actor.state.stage === 'working' && !activeIds.has(id)))
    .sort(([a, actorA], [b, actorB]) => Number(activeIds.has(b)) - Number(activeIds.has(a)) || actorB.state.idleTime - actorA.state.idleTime || actorA.ordinal - actorB.ordinal)
  for (const [id, actor] of candidates) {
    if (options.frozenIds?.has(id)) continue
    const prior = actor.state
    // A real task normally forces an immediate return — except while the
    // agent is out on the very thing the task says: a live handoff at the
    // whiteboard, or a live planning phase at the window. Once that window
    // or phase ends (or the task ends), an agent already out is forced back
    // by the second clause, exactly like a new task arriving.
    const inCollab = actor.routeOverride === 'collab' && (options.collabIds?.has(id) ?? false)
    const inPlanning = actor.routeOverride === 'window-planning' && (options.planningIds?.has(id) ?? false)
    const overrideEnded = actor.routeOverride !== undefined && !inCollab && !inPlanning &&
      ['walking', 'resting', 'coffee'].includes(prior.stage)
    const effectiveActive = (activeIds.has(id) && !inCollab && !inPlanning) || overrideEnded
    // Both sides of a handoff share the one whiteboard zone: the 'collab'
    // reservation does not block a second live collaborator (the 0.72 m
    // collision check below still keeps them from overlapping).
    const canDepart = visibleIds.has(id) &&
      (!reservations.has(actor.resource) || (actor.routeOverride === 'collab' && (options.collabIds?.has(id) ?? false)))
    const next = advanceMovement(prior, actor.route, dt, effectiveActive, motion, actor.ordinal, canDepart, options.behavior)
    let collides = false
    if (next.walking) {
      const [x, z] = next.position.map(Math.floor)
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const otherId of occupied.get(`${x + dx},${z + dz}`) ?? []) {
          const other = simulation.get(otherId)!
          if (otherId !== id && Math.hypot(next.position[0] - other.state.position[0], next.position[1] - other.state.position[1]) < .72) collides = true
        }
      }
    }
    actor.state = collides ? { ...prior, walking: false } : next
    if (actor.state.walking) actor.gait += Math.hypot(actor.state.position[0] - prior.position[0], actor.state.position[1] - prior.position[1]) * (Math.PI * 2 / 1.2)
    occupied.get(cell(prior.position))?.delete(id)
    occupy(id, actor.state.position)
    if (!traveling(prior) && traveling(actor.state)) reservations.add(actor.resource)
    if (traveling(prior) && !traveling(actor.state)) reservations.delete(actor.resource)
  }
}
