export type AgentId = string
export type Department = 'architecture' | 'engineering' | 'design' | 'quality' | 'research' | 'operations' | 'security' | 'data' | 'general'
export type ProviderId = 'codex' | 'claude' | 'gemini'
export interface ProviderInfo { id: ProviderId; name: string; available: boolean }
export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'queued'
export type TaskPhase = 'thinking' | 'coding' | 'researching' | 'finishing' | 'idle'
export interface OfficeAgent {
  id: AgentId
  name: string
  role: string
  specialty: string
  color: string
  short: string
  department: Department
}
export interface TaskEvent { id: string; at: string; kind: string; message: string }
export interface OfficeTask {
  id: string
  agentId: AgentId
  agentName?: string
  provider?: ProviderId
  prompt: string
  workspace: string
  status: TaskStatus
  phase: TaskPhase
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  lastMessage: string
  events: TaskEvent[]
  threadId: string | null
  // Phase 3a: handoff lineage + manual approval-wait flag. Both optional so
  // older history files stay valid.
  awaitingApproval?: boolean
  dependsOn?: string
  failure?: string
  exitCode?: number | null
  usage?: { input_tokens?: number; output_tokens?: number } | null
}
export interface ServerState { connected: boolean; codexAvailable: boolean; providers: ProviderInfo[]; defaultWorkspace: string; tasks: OfficeTask[]; agents: OfficeAgent[] }

export const DEFAULT_AGENTS: OfficeAgent[] = [
  { id: 'atlas', name: 'Atlas', role: 'Tech Lead', specialty: 'Architecture & planning', color: '#8b82ff', short: 'AT', department: 'architecture' },
  { id: 'nova', name: 'Nova', role: 'Developer', specialty: 'Code & implementation', color: '#4cd7e6', short: 'NV', department: 'engineering' },
  { id: 'pixel', name: 'Pixel', role: 'Creative', specialty: 'Design & experience', color: '#ffbb72', short: 'PX', department: 'design' },
  { id: 'sentinel', name: 'Sentinel', role: 'QA Engineer', specialty: 'Tests & reliability', color: '#78e4aa', short: 'SN', department: 'quality' },
]

const before = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
export function demoTasks(): OfficeTask[] {
  return [
    { id: 'demo-nova', agentId: 'nova', prompt: 'Build the dashboard components and connect real-time events.', workspace: 'Demo workspace', status: 'running', phase: 'coding', createdAt: before(8), updatedAt: before(1), finishedAt: null, lastMessage: '', threadId: null, events: [
      { id: 'n1', at: before(8), kind: 'info', message: 'Started implementing the dashboard.' },
      { id: 'n2', at: before(3), kind: 'info', message: 'Updated Dashboard.tsx and styles.' },
      { id: 'n3', at: before(1), kind: 'info', message: 'Running type checks.' },
    ] },
    { id: 'demo-atlas', agentId: 'atlas', prompt: 'Review architecture and map the implementation plan.', workspace: 'Demo workspace', status: 'running', phase: 'thinking', createdAt: before(4), updatedAt: before(2), finishedAt: null, lastMessage: '', threadId: null, events: [{ id: 'a1', at: before(2), kind: 'info', message: 'Reviewing dependencies and architecture.' }] },
    { id: 'demo-sentinel', agentId: 'sentinel', prompt: 'Check API health and validate current changes.', workspace: 'Demo workspace', status: 'completed', phase: 'idle', createdAt: before(23), updatedAt: before(12), finishedAt: before(12), lastMessage: 'All checks passed.', threadId: null, events: [{ id: 's1', at: before(12), kind: 'success', message: 'Checks completed successfully.' }] },
  ]
}
