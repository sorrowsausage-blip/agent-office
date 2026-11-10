import type { Seat, Sector } from './officeLayout'
import type { ActivityRate, OfficeMotion } from './officePreferences'

export type Point = [number, number]
export type BreakKind = 'coffee' | 'rest' | 'window' | 'collab'
export type Route = { points: Point[]; durations: number[]; total: number; breakIndex: number; breakStage: 'coffee' | 'resting'; breakKind?: BreakKind }
// A break stop is any amenity an idle visit can end at: the coffee point
// ('coffee'), a rest sofa seat or a window thinking spot ('resting'), or
// the whiteboard ('resting'). The route shape is the same aisle network in
// every case; only the destination and the stage name differ.
export type CoffeeStop = { x: number; z: number; aisleZ: number; spineX?: number; key?: string; breakStage?: 'coffee' | 'resting' }
export const CHAIR_Z = .94
export const STAND_Z = 1.18
export const STAND_SIDE_X = .98
export const AISLE_Z = 2.32
export const DESK_FACING = Math.PI
// Walking to the front of the chair and sitting are separate phases.
export const CHAIR_APPROACH_Z = .56

// Paths use desk-side aisles and the shared corridor. A coffee visit goes
// around the outside of each bay, then enters the kitchenette from its aisle.
export function makeWalkRoute(seat: Seat, sector: Sector, slot: number, coffee?: CoffeeStop): Route {
  const [x, , z] = seat.position
  const leftEdge = sector.center[0] - sector.width / 2
  // Compact shared rooms have a narrower left margin than department bays.
  // Keep the avatar's shoulders outside the adjacent workstation footprint.
  const sideAisle = leftEdge + .55
  const front = coffee?.aisleZ ?? sector.center[2] + sector.depth / 2 - .88
  const loungeX = leftEdge + 1.2 + (slot % 3) * .65
  // The stop key names the destination, so the route itself can tell the
  // pantry, the sofa, the window and the whiteboard apart — all four share
  // the 'resting' stage, only the break kind differs.
  const breakKind: BreakKind | undefined = coffee?.key === 'collab' ? 'collab'
    : coffee?.key?.startsWith('rest-') ? 'rest'
    : coffee?.key?.startsWith('window-') ? 'window'
    : coffee?.key?.startsWith('coffee-') ? 'coffee' : undefined
  const points: Point[] = coffee ? [
    [x + STAND_SIDE_X, z + STAND_Z], [x + STAND_SIDE_X, z + AISLE_Z], [sideAisle, z + AISLE_Z], [sideAisle, front],
    [coffee.spineX ?? sideAisle, front], [coffee.spineX ?? sideAisle, coffee.z + .98],
    [coffee.x, coffee.z + .98],
    [coffee.spineX ?? sideAisle, coffee.z + .98], [coffee.spineX ?? sideAisle, front + .9], [leftEdge - .55, front + .9],
    [leftEdge - .55, z + AISLE_Z], [x + STAND_SIDE_X, z + AISLE_Z], [x + STAND_SIDE_X, z + STAND_Z],
  ] : [
    [x + STAND_SIDE_X, z + STAND_Z], [x + STAND_SIDE_X, z + AISLE_Z], [sideAisle, z + AISLE_Z], [sideAisle, front],
    [loungeX, front], [sideAisle, front], [sideAisle, z + AISLE_Z], [x + STAND_SIDE_X, z + AISLE_Z], [x + STAND_SIDE_X, z + STAND_Z],
  ]
  const breakIndex = coffee ? 6 : 4
  const durations = points.slice(1).map((point, index) => Math.hypot(point[0] - points[index][0], point[1] - points[index][1]) / 1.3)
  return { points, durations, total: durations.reduce((sum, seconds) => sum + seconds, 0) + 12,
    breakIndex, breakStage: coffee?.breakStage ?? (coffee ? 'coffee' : 'resting'), breakKind }
}

// Leisure timing (phase 3b, initial configuration — all read from the
// behaviour preferences, with the hardcoded defaults below matching them):
// - an agent must be idle for at least IDLE_BEFORE_LEISURE_S before it may
//   leave for a break, so a short gap between tasks never triggers a visit;
// - while idle, a new leisure attempt is allowed every 120–240 s at the
//   normal rate (low: 240–360 s, high: 60–120 s), staggered per agent;
// - one stay at the break stop lasts 20–50 s. Real task events always win:
//   a new task forces a return from any break stage (see advanceMovement).
export const IDLE_BEFORE_LEISURE_S = 30
export const LEISURE_STAY_MIN_S = 20
export const LEISURE_STAY_MAX_S = 50
export type MovementBehaviorOptions = { activityRate?: ActivityRate; breaksEnabled?: boolean; wanderEnabled?: boolean }

export function leisureAttemptIntervalSeconds(rate: ActivityRate, ordinal: number): number {
  const base = rate === 'low' ? 240 : rate === 'high' ? 60 : 120
  const span = rate === 'high' ? 60 : 120
  return base + ((ordinal * 37) % span)
}

export function leisureStaySeconds(_breakStage: 'coffee' | 'resting', ordinal: number): number {
  return LEISURE_STAY_MIN_S + ((ordinal * 13) % (LEISURE_STAY_MAX_S - LEISURE_STAY_MIN_S + 1))
}

// What the avatar is visibly doing while parked at a break stop. This is
// decoration only: it never changes a task, a status or a pose priority —
// the status machine (agentStatus.ts) stays the only source of truth for
// what the agent is doing. Derived purely from the stop kind and the time
// already spent there, so it is deterministic and testable.
export type BreakActivity =
  | 'none'
  | 'pour' | 'brew' | 'take-cup'
  | 'sit' | 'read' | 'drink' | 'daydream' | 'nap'
  | 'gaze' | 'think' | 'pace'
  | 'discuss'

export function breakActivityFor(breakKind: BreakKind | undefined, stage: MovementStage, wait: number, ordinal: number): BreakActivity {
  if (stage === 'coffee') {
    const stay = leisureStaySeconds('coffee', ordinal)
    if (wait < stay / 3) return 'pour'
    if (wait < stay * 2 / 3) return 'brew'
    return 'take-cup'
  }
  if (stage !== 'resting') return 'none'
  const stay = leisureStaySeconds('resting', ordinal)
  if (breakKind === 'rest') {
    const fifth = stay / 5
    if (wait < fifth) return 'sit'
    if (wait < fifth * 2) return 'read'
    if (wait < fifth * 3) return 'drink'
    if (wait < fifth * 4) return 'daydream'
    return 'nap'
  }
  if (breakKind === 'window') {
    if (wait < stay / 3) return 'gaze'
    if (wait < stay * 2 / 3) return 'think'
    return 'pace'
  }
  if (breakKind === 'collab') return 'discuss'
  return 'none'
}

export function walkAt(route: Route, seconds: number, motion: OfficeMotion): { position: Point; walking: boolean; resting: boolean; facing: number } {
  const home = route.points[0]
  if (motion === 'off') return { position: home, walking: false, resting: false, facing: Math.PI }
  const factor = motion === 'subtle' ? .55 : 1
  const cycle = route.total / factor
  let remaining = ((seconds % cycle) + cycle) % cycle * factor
  if (remaining < 3) return { position: home, walking: false, resting: false, facing: Math.PI }
  remaining -= 3
  for (let index = 0; index < route.durations.length; index++) {
    if (index === route.breakIndex) {
      if (remaining < 4) return { position: route.points[route.breakIndex], walking: false, resting: true, facing: 0 }
      remaining -= 4
    }
    const duration = route.durations[index]
    if (remaining < duration) {
      const start = route.points[index], end = route.points[index + 1]
      const alpha = duration ? remaining / duration : 1
      return {
        position: [start[0] + (end[0] - start[0]) * alpha, start[1] + (end[1] - start[1]) * alpha],
        walking: duration > .08,
        resting: false,
        facing: Math.atan2(end[0] - start[0], end[1] - start[1]),
      }
    }
    remaining -= duration
  }
  return { position: home, walking: false, resting: false, facing: Math.PI }
}

export type MovementStage = 'standing' | 'walking' | 'resting' | 'coffee' | 'returning' | 'approaching' | 'sitting' | 'working' | 'rising' | 'leaving'
export type MovementState = {
  stage: MovementStage; position: Point; facing: number; seated: number; walking: boolean
  cursor: number; waypoints: Point[]; wait: number; idleTime: number
  // Cooldown (seconds) before the next leisure departure may be attempted.
  // Counts down only while standing idle; 0 means an attempt is allowed.
  nextBreakIn: number
  // Visible break activity while parked at a stop ('none' everywhere else).
  breakActivity: BreakActivity
}

export function createMovementState(route: Route): MovementState {
  return { stage: 'standing', position: [...route.points[0]], facing: DESK_FACING, seated: 0,
    walking: false, cursor: 0, waypoints: [], wait: 0, idleTime: 0, nextBreakIn: 0, breakActivity: 'none' }
}

// A task event changes the movement goal, not the avatar's coordinates.
// While returning, the agent retraces the aisle network instead of cutting
// diagonally through chairs or desks. All pose transitions advance by delta.
export function advanceMovement(state: MovementState, route: Route, dt: number, active: boolean,
  motion: OfficeMotion, ordinal: number, canDepart = true, behavior: MovementBehaviorOptions = {}): MovementState {
  const next: MovementState = { ...state, position: [...state.position], waypoints: [...state.waypoints] }
  const step = Math.min(Math.max(0, dt), .05)
  const home = route.points[0]
  const chair: Point = [home[0] - STAND_SIDE_X, home[1] + CHAIR_Z - STAND_Z]
  const front: Point = [chair[0], home[1] + CHAIR_APPROACH_Z - STAND_Z]
  const side: Point = [home[0], front[1]]
  next.walking = false
  if ((active || motion === 'off') && (next.stage === 'walking' || next.stage === 'resting' || next.stage === 'coffee')) {
    const outbound = next.stage === route.breakStage || next.cursor <= route.breakIndex
    next.waypoints = outbound ? route.points.slice(0, next.cursor).reverse() : route.points.slice(next.cursor)
    next.cursor = 0
    next.stage = 'returning'
    next.breakActivity = 'none'
  }
  if (active && next.stage === 'rising') next.stage = 'sitting'
  if (active && next.stage === 'leaving') {
    next.stage = 'approaching'
    next.waypoints = [side, front]
    next.cursor = 0
  }
  if (active && next.stage === 'standing') {
    next.stage = 'approaching'
    next.waypoints = [side, front]
    next.cursor = 0
    next.wait = 0
  }
  if (!active && next.stage === 'approaching') {
    next.stage = 'leaving'
    next.waypoints = [side, home]
    next.cursor = 0
  }
  if (!active && (next.stage === 'working' || next.stage === 'sitting')) { next.stage = 'rising'; next.wait = 0 }

  if (next.stage === 'sitting' || next.stage === 'rising') {
    const direction = next.stage === 'sitting' ? 1 : -1
    next.seated = Math.min(1, Math.max(0, next.seated + direction * step / .72))
    const ease = next.seated * next.seated * (3 - 2 * next.seated)
    next.position = [chair[0], front[1] + (chair[1] - front[1]) * ease]
    next.facing = DESK_FACING
    if (next.seated === 1) next.stage = 'working'
    if (next.seated === 0) {
      next.stage = 'leaving'
      next.waypoints = [side, home]
      next.cursor = 0
      next.idleTime = 0
    }
    return next
  }
  if (next.stage === 'working') {
    next.position = [...chair]
    next.seated = 1
    next.facing = DESK_FACING
    return next
  }
  if (next.stage === 'standing') {
    next.position = [...home]
    next.facing = DESK_FACING
    next.breakActivity = 'none'
    if (!active && motion !== 'off') {
      next.idleTime += step * (motion === 'subtle' ? .45 : 1)
      next.nextBreakIn = Math.max(0, next.nextBreakIn - step)
      // Spread visits over time so a large team does not crowd the break
      // stops, and never depart before a genuine idle gap. Either behaviour
      // switch off disables leisure departures entirely.
      const breaksOn = behavior.breaksEnabled !== false && behavior.wanderEnabled !== false
      if (breaksOn && canDepart && next.nextBreakIn <= 0 && next.idleTime > IDLE_BEFORE_LEISURE_S + (ordinal * 7 % 31)) {
        next.stage = 'walking'
        next.cursor = 1
      }
    }
    return next
  }
  if (next.stage === 'resting' || next.stage === 'coffee') {
    next.wait += step
    next.breakActivity = breakActivityFor(route.breakKind, next.stage, next.wait, ordinal)
    if (next.wait < leisureStaySeconds(route.breakStage, ordinal)) return next
    next.stage = 'walking'
    next.cursor = route.breakIndex + 1
    next.breakActivity = 'none'
  }
  if (next.stage === 'approaching' || next.stage === 'leaving') {
    const target = next.waypoints[next.cursor]
    if (!target) {
      next.stage = next.stage === 'approaching' ? 'sitting' : 'standing'
      next.cursor = 0
      next.position = next.stage === 'sitting' ? [...front] : [...home]
      next.facing = DESK_FACING
      return next
    }
    const dx = target[0] - next.position[0], dz = target[1] - next.position[1]
    const distance = Math.hypot(dx, dz)
    const speed = 1.1 * step
    if (distance > .0001) {
      const travel = Math.min(distance, speed)
      next.position = [next.position[0] + dx / distance * travel, next.position[1] + dz / distance * travel]
      next.facing = Math.atan2(dx, dz)
      next.walking = true
    }
    if (distance <= speed + .0001) {
      next.position = [...target]
      next.cursor++
      if (next.cursor === next.waypoints.length) {
        next.stage = next.stage === 'approaching' ? 'sitting' : 'standing'
        next.cursor = 0
        next.facing = DESK_FACING
      }
    }
    return next
  }
  const returning = next.stage === 'returning'
  const points = returning ? next.waypoints : route.points
  if (returning && points.length === 0) {
    next.stage = 'standing'
    next.position = [...home]
    next.nextBreakIn = leisureAttemptIntervalSeconds(behavior.activityRate ?? 'normal', ordinal)
    return next
  }
  const target = points[next.cursor]
  if (!target) { next.stage = 'standing'; next.position = [...home]; next.idleTime = 0; next.nextBreakIn = leisureAttemptIntervalSeconds(behavior.activityRate ?? 'normal', ordinal); return next }
  const dx = target[0] - next.position[0], dz = target[1] - next.position[1]
  const distance = Math.hypot(dx, dz)
  if (distance > .0001) {
    const travel = Math.min(distance, 1.35 * step)
    next.position = [next.position[0] + dx / distance * travel, next.position[1] + dz / distance * travel]
    next.facing = Math.atan2(dx, dz)
    next.walking = true
  }
  if (distance <= 1.35 * step + .0001) {
    next.position = [...target]
    next.cursor++
    if (!returning && next.cursor === route.breakIndex + 1) {
      next.stage = route.breakStage
      next.wait = 0
      next.walking = false
      next.breakActivity = breakActivityFor(route.breakKind, route.breakStage, 0, ordinal)
      if (route.breakStage === 'coffee') next.facing = DESK_FACING
    }
    else if (next.cursor >= points.length) {
      next.stage = 'standing'
      next.cursor = 0
      next.position = [...home]
      next.idleTime = 0
      next.nextBreakIn = leisureAttemptIntervalSeconds(behavior.activityRate ?? 'normal', ordinal)
    }
  }
  return next
}
