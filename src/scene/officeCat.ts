import type { OfficeLayout } from './officeLayout'

export type CatPose = 'sit' | 'lie' | 'walk' | 'hidden'
export type CatState = { pose: CatPose; position: [number, number]; facing: number }

// The office cat (phase 5) lives in the idle north band, in front of the
// glass and clear of everything else:
// - its stroll runs east-west at z = 1.6 * scale, 0.85 * scale south of the
//   window thinking spots and 0.875 * scale north of the reception desk, so
//   it never occupies a window-*/rest-*/collab resource point (all stay
//   >= 0.7 m away) and never enters the spine passage (x < 6.0 * scale) or
//   any workstation (x >= 8.6 * scale);
// - it has no route, no routeOverride and no BreakActivity: it is pure
//   decoration on a fixed clock cycle, and it can never be mistaken for an
//   agent doing task work.
// Cycle (150 s, position-continuous throughout; only the pose switches at
// fixed points): sleep 50 s at the east end, stroll west 35 s, sit 15 s,
// stroll back east 35 s, sleep 15 s. Ambient off hides the cat entirely.
export const CAT_CYCLE_S = 150

export function catScale(layout: OfficeLayout): number {
  const restX = layout.restSeats[1]?.x ?? layout.restSeats[0]?.x
  const scale = restX ? restX / 3 : 1
  return Math.min(1.2, Math.max(.9, scale))
}

export function catStateAt(seconds: number, layout: OfficeLayout, ambientEnabled = true): CatState {
  if (!ambientEnabled) return { pose: 'hidden', position: [0, 0], facing: Math.PI }
  const scale = catScale(layout)
  const east: [number, number] = [5.4 * scale, 1.6 * scale]
  const west: [number, number] = [.8 * scale, 1.6 * scale]
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
