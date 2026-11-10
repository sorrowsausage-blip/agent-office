import type { OfficeLayout } from './officeLayout'

export type CatPose = 'sit' | 'lie' | 'walk' | 'hidden'
export type CatState = { pose: CatPose; position: [number, number]; facing: number }

// The office cat (phase 5) lives in the idle north band, in front of the
// glass and clear of everything else:
// - its stroll runs east-west at z = 2.6 * scale, on the reception mat and
//   1.85 * scale - 0.98 m south of where an agent parks at a window
//   thinking spot (the spot itself is at z = 0.75 * scale, the agent stops
//   0.98 m south of it — the 0.98 is unscaled, so compact spacing is the
//   tightest at 0.76 m), so it stays >= 0.7 m from every parked or walking
//   agent in every spacing and never occupies a window-*/rest-*/collab
//   resource point; the reception counter's south edge is at
//   z = 3.375 * scale, 0.775 * scale clear of the stroll, and the stroll
//   never enters the spine passage (x < 6.0 * scale) or any workstation
//   (x >= 8.6 * scale);
// - it has no route, no routeOverride and no BreakActivity: it is pure
//   decoration on a fixed clock cycle, and it can never be mistaken for an
//   agent doing task work.
// Phase 6 fix: the stroll used to run at z = 1.6 * scale, which is only
// 0.13 m from a window-parked agent (1.6, 1.73) — the cat walked straight
// through anyone thinking at the window. The lane moved south to 2.6
// (2.5 still left only 0.665 m at compact spacing, where the unscaled
// 0.98 m park offset eats the margin).
// Cycle (150 s, position-continuous throughout; only the pose switches at
// fixed points): sleep 50 s at the east end, stroll west 35 s, sit 15 s,
// stroll back east 35 s, sleep 15 s. Ambient off hides the cat entirely.
export const CAT_CYCLE_S = 150

export function catScale(layout: OfficeLayout): number {
  const restX = layout.restSeats[1]?.x ?? layout.restSeats[0]?.x
  const scale = restX ? restX / 3 : 1
  return Math.min(1.2, Math.max(.9, scale))
}

// The stroll's z: the single source of truth for the lane. The simulation
// keeps sidesteps out of the 0.7 m band around it (phase 6).
export function catLaneZ(layout: OfficeLayout): number {
  return 2.6 * catScale(layout)
}

export function catStateAt(seconds: number, layout: OfficeLayout, ambientEnabled = true): CatState {
  if (!ambientEnabled) return { pose: 'hidden', position: [0, 0], facing: Math.PI }
  const scale = catScale(layout)
  const laneZ = catLaneZ(layout)
  const east: [number, number] = [5.4 * scale, laneZ]
  const west: [number, number] = [.8 * scale, laneZ]
  const t = ((seconds % CAT_CYCLE_S) + CAT_CYCLE_S) % CAT_CYCLE_S
  if (t < 50) return { pose: 'lie', position: east, facing: Math.PI }
  if (t < 85) {
    const alpha = (t - 50) / 35
    return { pose: 'walk', position: [east[0] + (west[0] - east[0]) * alpha, east[1]], facing: -Math.PI / 2 }
  }
  if (t < 100) return { pose: 'sit', position: west, facing: Math.PI }
  if (t < 135) {
    const alpha = (t - 100) / 35
    return { pose: 'walk', position: [west[0] + (east[0] - west[0]) * alpha, west[1]], facing: Math.PI / 2 }
  }
  return { pose: 'lie', position: east, facing: Math.PI }
}

// Resource points the cat must keep clear of: sofa seats, window spots and
// the whiteboard discussion spot. Used by the tests; the cat itself never
// reads or writes a reservation.
export function catResourcePoints(layout: OfficeLayout): [number, number][] {
  return [
    ...layout.restSeats.map(seat => [seat.x, seat.z] as [number, number]),
    ...layout.amenities.filter(area => area.id === 'window').map(area => [area.x, area.z] as [number, number]),
    [layout.collabZone.x, layout.collabZone.z],
  ]
}
