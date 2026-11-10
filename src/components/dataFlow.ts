import type { OfficeTask, ServerState } from '../types';
import { validateDemoAgent } from '../demo/roster';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string';
const validUsage = (value: unknown) => value == null || (object(value) && ['input_tokens', 'output_tokens'].every(key =>
  value[key] == null || (typeof value[key] === 'number' && Number.isFinite(value[key]))));
export function isOfficeTask(value: unknown): value is OfficeTask {
  if (!object(value)) return false;
  return text(value.id) && text(value.agentId) && text(value.prompt) && text(value.workspace) &&
    ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'queued'].includes(String(value.status)) &&
    ['thinking', 'coding', 'researching', 'finishing', 'idle'].includes(String(value.phase)) &&
    text(value.createdAt) && text(value.updatedAt) && (value.finishedAt === null || text(value.finishedAt)) &&
    (value.agentName == null || text(value.agentName)) && (value.failure == null || text(value.failure)) &&
    (value.awaitingApproval == null || typeof value.awaitingApproval === 'boolean') &&
    (value.dependsOn == null || text(value.dependsOn)) &&
    (value.provider == null || ['codex', 'claude', 'gemini'].includes(String(value.provider))) &&
    validUsage(value.usage) &&
    Array.isArray(value.events) && value.events.every(event => object(event) && text(event.id) && text(event.at) && text(event.kind) && text(event.message));
}
export function isServerState(value: unknown): value is ServerState {
  return object(value) && typeof value.connected === 'boolean' && typeof value.codexAvailable === 'boolean' && text(value.defaultWorkspace) &&
    Array.isArray(value.agents) && value.agents.every(validateDemoAgent) && new Set(value.agents.map(agent => agent.id)).size === value.agents.length &&
    Array.isArray(value.tasks) && value.tasks.every(isOfficeTask) && new Set(value.tasks.map(task => task.id)).size === value.tasks.length &&
    Array.isArray(value.providers) && value.providers.every(provider => object(provider) &&
      ['codex', 'claude', 'gemini'].includes(String(provider.id)) && text(provider.name) && typeof provider.available === 'boolean');
}

export function isAbsoluteWorkspace(path: string): boolean {
  return path.length <= 1000 && (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path));
}

/** Never expose a proxy's HTML page as an application error. */
export async function readResponse(response: Response, fallback: string): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(object(body) && text(body.error) && body.error.trim()
    ? body.error : `${fallback} (HTTP ${response.status})`);
  if (!object(body)) throw new Error(fallback);
  return body;
}
