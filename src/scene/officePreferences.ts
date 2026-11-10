import type { Department } from '../types'

export type OfficeTheme = 'daylight' | 'midnight' | 'warm'
export type OfficeSpacing = 'compact' | 'regular' | 'spacious'
export type OfficeMotion = 'off' | 'subtle' | 'lively'
export type ActivityRate = 'low' | 'normal' | 'high'
export type PerformanceMode = 'auto' | 'quality' | 'balanced'

export type OfficePreferences = {
  theme: OfficeTheme
  spacing: OfficeSpacing
  motion: OfficeMotion
  accent: string
  sectorColors: Partial<Record<Department, string>>
  // Phase 3b behaviour preferences. All defaulted and backward compatible:
  // the storage key is unchanged and unknown/missing values fall back to
  // the defaults below, so older persisted preferences keep working.
  // The Settings UI for these fields arrives in phase 5.
  activityRate: ActivityRate
  breaksEnabled: boolean
  wanderEnabled: boolean
  ambientEnabled: boolean
  windowThinkingEnabled: boolean
  performanceMode: PerformanceMode
}

export const OFFICE_PREFERENCES_KEY = 'agent-office-appearance-v1'
export const DEFAULT_OFFICE_PREFERENCES: OfficePreferences = {
  theme: 'daylight', spacing: 'regular', motion: 'lively', accent: '#547fc0', sectorColors: {},
  activityRate: 'normal', breaksEnabled: true, wanderEnabled: true, ambientEnabled: true,
  windowThinkingEnabled: true, performanceMode: 'auto',
}

// Only accept known presentation values. Stored preferences are never interpreted as commands.
export function normalizeOfficePreferences(value: unknown): OfficePreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const colors = input.sectorColors && typeof input.sectorColors === 'object' && !Array.isArray(input.sectorColors) ? input.sectorColors as Record<string, unknown> : {}
  const sectorColors: Partial<Record<Department, string>> = {}
  for (const id of ['engineering', 'architecture', 'design', 'quality', 'research', 'data', 'security', 'operations', 'general'] as Department[]) {
    if (typeof colors[id] === 'string' && /^#[0-9a-fA-F]{6}$/.test(colors[id])) sectorColors[id] = colors[id]
  }
  return {
    theme: ['daylight', 'midnight', 'warm'].includes(String(input.theme)) ? input.theme as OfficeTheme : DEFAULT_OFFICE_PREFERENCES.theme,
    spacing: ['compact', 'regular', 'spacious'].includes(String(input.spacing)) ? input.spacing as OfficeSpacing : DEFAULT_OFFICE_PREFERENCES.spacing,
    motion: ['off', 'subtle', 'lively'].includes(String(input.motion)) ? input.motion as OfficeMotion : DEFAULT_OFFICE_PREFERENCES.motion,
    accent: typeof input.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.accent) ? input.accent : DEFAULT_OFFICE_PREFERENCES.accent,
    sectorColors,
    activityRate: ['low', 'normal', 'high'].includes(String(input.activityRate)) ? input.activityRate as ActivityRate : DEFAULT_OFFICE_PREFERENCES.activityRate,
    breaksEnabled: typeof input.breaksEnabled === 'boolean' ? input.breaksEnabled : DEFAULT_OFFICE_PREFERENCES.breaksEnabled,
    wanderEnabled: typeof input.wanderEnabled === 'boolean' ? input.wanderEnabled : DEFAULT_OFFICE_PREFERENCES.wanderEnabled,
    ambientEnabled: typeof input.ambientEnabled === 'boolean' ? input.ambientEnabled : DEFAULT_OFFICE_PREFERENCES.ambientEnabled,
    windowThinkingEnabled: typeof input.windowThinkingEnabled === 'boolean' ? input.windowThinkingEnabled : DEFAULT_OFFICE_PREFERENCES.windowThinkingEnabled,
    performanceMode: ['auto', 'quality', 'balanced'].includes(String(input.performanceMode)) ? input.performanceMode as PerformanceMode : DEFAULT_OFFICE_PREFERENCES.performanceMode,
  }
}

export function loadOfficePreferences(): OfficePreferences {
  try { return normalizeOfficePreferences(JSON.parse(localStorage.getItem(OFFICE_PREFERENCES_KEY) || 'null')) }
  catch { return { ...DEFAULT_OFFICE_PREFERENCES } }
}

export type DeviceCapabilities = { devicePixelRatio?: number; hardwareConcurrency?: number }

// One observable rendering profile per performance mode. 'auto' is a fixed
// device-capability mapping, not frame-rate sampling: sampling would need a
// running loop plus a hysteresis policy, and a mid-task quality switch would
// be visible as a pop. Low-end devices (high-DPR screens or few cores) get
// the balanced profile; everything else gets quality.
export type PerformanceSettings = {
  mode: 'quality' | 'balanced'
  shadows: boolean
  shadowMapSize: number
  dprMax: number
  // Team size up to which every agent gets a detailed avatar; beyond it the
  // far agents render through the cheap instanced crowd LOD.
  crowdDetailCutoff: number
}

export function resolvePerformanceMode(mode: PerformanceMode, caps: DeviceCapabilities = {}): 'quality' | 'balanced' {
  if (mode === 'quality') return 'quality'
  if (mode === 'balanced') return 'balanced'
  const dpr = caps.devicePixelRatio ?? 1
  const cores = caps.hardwareConcurrency ?? 8
  return dpr >= 2 || cores <= 4 ? 'balanced' : 'quality'
}

export function resolvePerformanceSettings(mode: PerformanceMode, caps: DeviceCapabilities = {}): PerformanceSettings {
  return resolvePerformanceMode(mode, caps) === 'quality'
    ? { mode: 'quality', shadows: true, shadowMapSize: 2048, dprMax: 1.5, crowdDetailCutoff: 50 }
    : { mode: 'balanced', shadows: true, shadowMapSize: 1024, dprMax: 1.25, crowdDetailCutoff: 24 }
}
