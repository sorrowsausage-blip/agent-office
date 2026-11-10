import type { AgentId, OfficeTask, TaskPhase } from '../types'

export type AgentPose = TaskPhase | 'celebrating' | 'error' | 'blocked' | 'collaborating' | 'offline'

// A finished task briefly triggers an acknowledgement, then the avatar rests.
// This is a visualization of the task's reported state, not proof of actions.
export const TERMINAL_POSE_MS = 8_000

export function resolveAgentPose(task?: OfficeTask, now = Date.now()): AgentPose {
  if (!task) return 'idle'
  if (task.status === 'running') return task.phase === 'idle' ? 'thinking' : task.phase
  if (!task.finishedAt) return 'idle'
  const finished = Date.parse(task.finishedAt)
  if (!Number.isFinite(finished) || now < finished || now - finished >= TERMINAL_POSE_MS) return 'idle'
  if (task.status === 'completed') return 'celebrating'
  if (task.status === 'failed' || task.status === 'interrupted') return 'error'
  return 'idle'
}

// Active work outranks a terminal reaction from the preceding task. Otherwise
// a fresh task could appear idle/failed while the backend is actually running.
export function selectAgentTask(tasks: OfficeTask[], agentId: AgentId, now = Date.now()): OfficeTask | undefined {
  const assigned = tasks.filter(task => task.agentId === agentId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return assigned.find(task => task.status === 'running') ??
    assigned.find(task => ['celebrating', 'error'].includes(resolveAgentPose(task, now))) ?? assigned[0]
}
