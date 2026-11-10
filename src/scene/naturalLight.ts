// Natural light (phase 5): a slow warm drift of the sun, not a weather
// simulation. One 3-minute cycle, small amplitude on purpose — the light
// must never wash out task labels or make an avatar hard to read.
// Ambient off freezes it at the neutral noon value.

export type NaturalLight = { intensity: number; color: string }

export const NATURAL_LIGHT_CYCLE_S = 180
export const NATURAL_LIGHT_NEUTRAL: NaturalLight = { intensity: 2.4, color: '#f4ecdc' }
// Pale morning <-> warm afternoon. Both ends stay close to the neutral
// colour so the drift reads as daylight, not a theme change.
const COOL_END = '#f7efdd'
const WARM_END = '#f0dcae'

function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const [r1, g1, b1] = parse(a), [r2, g2, b2] = parse(b)
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')
  return `#${mix(r1, r2)}${mix(g1, g2)}${mix(b1, b2)}`
}

export function naturalLightAt(seconds: number, ambientEnabled = true): NaturalLight {
  if (!ambientEnabled) return { ...NATURAL_LIGHT_NEUTRAL }
  const phase = Math.sin(seconds * Math.PI * 2 / NATURAL_LIGHT_CYCLE_S)
  return { intensity: 2.4 + phase * .3, color: mixHex(COOL_END, WARM_END, (phase + 1) / 2) }
}
