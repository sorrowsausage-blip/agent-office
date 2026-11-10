import type { OfficeLayout, Seat, Sector } from './officeLayout'
import type { OfficeMotion } from './officePreferences'
import { advanceMovement, CHAIR_Z, STAND_SIDE_X, STAND_Z, createMovementState, makeWalkRoute, type CoffeeStop, type MovementBehaviorOptions, type MovementState, type Route } from './officeMotion.ts'

export type OfficeActor = { state: MovementState; route: Route; resource: string; ordinal: number; gait: number }
export type OfficeSimulation = Map<string, OfficeActor>
export type BreakDestination = 'coffee' | 'rest' | 'window' | 'collab'
export type RouteDestinationOptions = { windowThinkingEnabled?: boolean }

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
    case 'collab':
      return { stop: via({ x: layout.collabZone.x, z: layout.collabZone.z, key: layout.collabZone.key, breakStage: 'resting' }), resource: layout.collabZone.key }
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
      if (existing.state.stage === 'standing') return [seat.agent.id, { ...existing, ordinal, route: config.route, resource: config.resource }]
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
  options: { behavior?: MovementBehaviorOptions; frozenIds?: ReadonlySet<string> } = {}) {
  const cell = (position: [number, number]) => `${Math.floor(position[0])},${Math.floor(position[1])}`
  const occupied = new Map<string, Set<string>>()
  const occupy = (id: string, position: [number, number]) => {
    const key = cell(position)
    if (!occupied.has(key)) occupied.set(key, new Set())
    occupied.get(key)!.add(id)
  }
  for (const [id, actor] of simulation) occupy(id, actor.state.position)
  const reservations = new Set([...simulation.values()].filter(actor => traveling(actor.state)).map(actor => actor.resource))
  const candidates = [...simulation.entries()].filter(([id, actor]) => visibleIds.has(id) || traveling(actor.state) || activeIds.has(id) ||
    (actor.state.stage !== 'standing' && actor.state.stage !== 'working') || (actor.state.stage === 'working' && !activeIds.has(id)))
    .sort(([a, actorA], [b, actorB]) => Number(activeIds.has(b)) - Number(activeIds.has(a)) || actorB.state.idleTime - actorA.state.idleTime || actorA.ordinal - actorB.ordinal)
  for (const [id, actor] of candidates) {
    if (options.frozenIds?.has(id)) continue
    const prior = actor.state
    const next = advanceMovement(prior, actor.route, dt, activeIds.has(id), motion, actor.ordinal, visibleIds.has(id) && !reservations.has(actor.resource), options.behavior)
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
