import type { Department } from '../types'

export type DecorBox = { x: number; y: number; z: number; width: number; height: number; depth: number }
type StandingProp = DecorBox & { kind: 'books' | 'server' | 'easel' | 'rack' | 'board' | 'cabinet' }
// Living-zone props, in zone-local metres from the zone centre. Same contract
// as departmentDecor: standing furniture is grounded (y = height / 2), boards
// hang at their centre height, planters sit on the floor.
export type LivingZoneKind = 'rest' | 'window' | 'collab'
export type LivingZoneDecor = { boards: { x: number; y: number; z: number; w: number; h: number; color: string }[]; furniture: StandingProp[]; planters: { x: number; z: number }[] }
export function livingZoneDecor(zone: LivingZoneKind): LivingZoneDecor {
  // Rest area (sofa centre): bookshelf east of the sofa, planter south-east.
  if (zone === 'rest') return { boards: [],
    furniture: [{ kind: 'books', x: 1.9, y: 2.1 / 2, z: -1.2, width: 1.5, height: 2.1, depth: .48 }],
    planters: [{ x: 2.1, z: .45 }] }
  // Window zone (thinking spot): one planter beside the sill bench.
  if (zone === 'window') return { boards: [], furniture: [], planters: [{ x: 1.05, z: .35 }] }
  // Collab zone (discussion spot, board group local space: local x runs along
  // the west wall after the group is rotated 90 degrees, so the board spans
  // z collabZ +/- .75 and stays clear of the coffee mat to its south).
  return { boards: [{ x: 0, y: 1.6, z: .1, w: 1.5, h: 1.05, color: '#5e87ab' }], furniture: [], planters: [] }
}
export function departmentDecor(id: Department, width: number, depth: number) {
  const back = -depth / 2 + .42
  const boardX = -width / 2 + 1.55
  const boards: { x: number; y: number; z: number; w: number; h: number; color: string }[] = []
  const furniture: StandingProp[] = []
  const board = (x: number, y: number, w: number, h: number, color: string) => boards.push({ x, y, z: back, w: Math.min(2.7, w), h: Math.min(1.3, h), color })
  const prop = (kind: StandingProp['kind'], x: number, w: number, h: number, d: number) => furniture.push({ kind, x, y: h / 2, z: back + .2, width: w, height: h, depth: d })
  if (id === 'research') { prop('books', -width / 2 + 1.35, 1.5, 2.1, .48); prop('books', width / 2 - 1.45, 1.5, 2.1, .48); board(0, 2.58, 2.25, .7, '#b3a3fa') }
  if (id === 'engineering') { prop('server', width / 2 - .95, 1.04, 2.02, .82); board(boardX, 2.12, 2.3, 1.25, '#287fa5') }
  if (id === 'design') { prop('easel', width / 2 - 1.2, 1.13, 1.8, .28); board(boardX, 2.1, 2.1, 1.12, '#bc8a87') }
  if (id === 'quality') { prop('rack', width / 2 - 1.4, 1.6, 1.7, .56); board(boardX, 2.45, 2.7, 1, '#3f966f') }
  if (id === 'architecture') { prop('board', width / 2 - 1.45, 1.7, 1.6, .08); board(boardX, 2.1, 2.7, 1.3, '#687fc0') }
  if (id === 'operations') { board(-1.15, 2.1, 2, 1.28, '#c9aa53'); board(1.15, 2.1, 2, 1.28, '#6a96ad') }
  if (id === 'security') { prop('cabinet', width / 2 - 1.1, .85, 1.6, .65); board(-1.2, 2.5, 2.15, 1, '#b7657f'); board(1.2, 2.5, 2.15, 1, '#5e8ba7') }
  if (id === 'data') { prop('books', width / 2 - 1.1, 1.5, 2.1, .48); board(-1.3, 2.1, 2.1, 1.32, '#408da5') }
  // Shared rooms already have a noticeboard; don't overlay a second board.
  const planter = ['research', 'quality', 'architecture'].includes(id) ? null : { x: 0, y: .55, z: -depth / 2 + .65, width: .86, height: 1.1, depth: .86 }
  return { boards, furniture, planter }
}
