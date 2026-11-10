import type { OfficeTask } from '../types'
import { resolveAgentPose, selectAgentTask, type AgentPose } from './agentBehavior.ts'
import type { MovementStage } from './officeMotion.ts'

export type OfficeAgentStatus =
  | 'WORKING' | 'PLANNING' | 'RESEARCHING' | 'IDLE' | 'BREAK'
  | 'COLLABORATING' | 'COMPLETED' | 'BLOCKED' | 'ERROR' | 'OFFLINE'

// Handoff pairs are a display window, not task state: the whiteboard
// behaviour shows only briefly after a real handoff event, then the agent
// falls back to its ordinary working pose.
export const COLLAB_WINDOW_MS = 60_000
// A status that has just changed is held briefly so a burst of task events
// cannot flap the avatar between sitting and standing. A strictly
// higher-priority status always cuts through immediately.
export const STATUS_HOLD_MS = 2_000

const STATUS_PRIORITY: Record<OfficeAgentStatus, number> = {
  OFFLINE: 0, BLOCKED: 1, ERROR: 2, COMPLETED: 3, COLLABORATING: 4,
  WORKING: 5, PLANNING: 5, RESEARCHING: 5, BREAK: 6, IDLE: 7,
}

// OFFLINE definition — read the code before changing this:
// - Source: the client-side `online` flag in App.tsx, which is the
//   `connected` field of the SSE/HTTP snapshot. The server snapshot always
//   reports `connected: true` when it answers (server/index.mjs `snapshot()`),
//   so `connected === false` here means the browser has no live snapshot:
//   the /api/state fetch failed or the /api/events stream errored.
// - Scope: the whole office at once. There is no per-agent connectivity
//   signal anywhere in the snapshot.
// - Providers are deliberately NOT used: `providers[].available` only gates
//   starting new tasks (App.start), and no task carries a per-agent
//   provider-health signal. An unavailable provider never shows an agent
//   as offline.
// - Demo mode passes `connected: undefined` and is never OFFLINE. An
//   agent with no task is IDLE, never OFFLINE.
export type AgentStatusOptions = {
  connected?: boolean
  collabWindowMs?: number
}

export type AgentStatusEntry = { status: OfficeAgentStatus; pose: AgentPose; task?: OfficeTask }

export function statusToPose(status: OfficeAgentStatus): AgentPose {
  switch (status) {
    case 'WORKING': return 'coding'
    case 'PLANNING': return 'thinking'
    case 'RESEARCHING': return 'researching'
    case 'IDLE': return 'idle'
    case 'BREAK': return 'idle'
    case 'COLLABORATING': return 'collaborating'
    case 'COMPLETED': return 'celebrating'
    case 'BLOCKED': return 'blocked'
    case 'ERROR': return 'error'
    case 'OFFLINE': return 'offline'
  }
}

// Far-view LOD keeps only three tiers; the full ten states stay in the
// detailed scene and the labels.
export type CrowdTier = 'WORKING' | 'IDLE' | 'BREAK'
export function crowdTier(status: OfficeAgentStatus): CrowdTier {
  if (status === 'BREAK') return 'BREAK'
  if (status === 'WORKING' || status === 'PLANNING' || status === 'RESEARCHING' || status === 'COLLABORATING') return 'WORKING'
  return 'IDLE'
}

function latestHandoffAt(task: OfficeTask): number | null {
  let latest: number | null = null
  for (const event of task.events || []) {
    if (!event.message.startsWith('Handoff from ') && !event.message.startsWith('Handed off to ')) continue
    const at = Date.parse(event.at)
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at
  }
  return latest
}

// True only inside the window after a real handoff event pair (3a records
// `Handoff from <name>` on the dependent task and `Handed off to <name>` on
// the prerequisite). A queued task has no handoff event yet — it records
// `Waiting for …` instead — so it can never show as collaborating.
export function isCollaborating(task: OfficeTask | undefined, now: number, windowMs = COLLAB_WINDOW_MS): boolean {
  if (!task || (task.status !== 'running' && task.status !== 'completed')) return false
  const at = latestHandoffAt(task)
  return at !== null && now >= at && now - at < windowMs
}

// Priority (strict): OFFLINE > BLOCKED > ERROR > COMPLETED (8 s terminal
// window, via resolveAgentPose) > COLLABORATING (handoff window) >
// WORKING/PLANNING/RESEARCHING (running phase) > BREAK (at a break stop) >
// IDLE. A queued task is never WORKING: it has no running phase and falls
// through to BREAK/IDLE.
export function resolveAgentStatus(task: OfficeTask | undefined, movement: { stage: MovementStage } | undefined,
  opts: AgentStatusOptions = {}, now = Date.now()): OfficeAgentStatus {
  if (opts.connected === false) return 'OFFLINE'
  if (task?.status === 'running' && task.awaitingApproval) return 'BLOCKED'
  const pose = resolveAgentPose(task, now)
  if (pose === 'error') return 'ERROR'
  if (pose === 'celebrating') return 'COMPLETED'
  if (task && isCollaborating(task, now, opts.collabWindowMs)) return 'COLLABORATING'
  if (task?.status === 'running') {
    if (task.phase === 'thinking' || task.phase === 'idle') return 'PLANNING'
    if (task.phase === 'researching') return 'RESEARCHING'
    return 'WORKING'
  }
  if (movement && (movement.stage === 'coffee' || movement.stage === 'resting')) return 'BREAK'
  return 'IDLE'
}

export function describeAgent(tasks: OfficeTask[], agentId: string, movement: { stage: MovementStage } | undefined,
  opts: AgentStatusOptions = {}, now = Date.now()): AgentStatusEntry {
  const task = selectAgentTask(tasks, agentId, now)
  const status = resolveAgentStatus(task, movement, opts, now)
  return { status, pose: statusToPose(status), task }
}

export type SettledStatus = { status: OfficeAgentStatus; since: number }

// Debounce rapid status churn: a lower-or-equal-priority status must wait
// out STATUS_HOLD_MS before replacing the current one, so the avatar does
// not repeatedly stand up and sit down on a burst of task events. A
// higher-priority status (smaller number) always switches immediately.
export function settleAgentStatus(previous: SettledStatus | undefined, next: OfficeAgentStatus, now: number): SettledStatus {
  if (!previous || previous.status === next) return { status: next, since: previous?.since ?? now }
  if (STATUS_PRIORITY[next] < STATUS_PRIORITY[previous.status]) return { status: next, since: now }
  if (now - previous.since >= STATUS_HOLD_MS) return { status: next, since: now }
  return previous
}
