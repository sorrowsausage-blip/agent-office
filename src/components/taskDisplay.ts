import { BrainCircuit, Code2, Layers3, ShieldCheck, Network, Library, Users, Database, LockKeyhole } from 'lucide-react';
import type { OfficeTask, TaskPhase } from '../types';

export const statusName: Record<string, string> = { running: 'In progress', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', queued: 'Queued', idle: 'Available' };
export const phaseName: Record<TaskPhase, string> = { thinking: 'Thinking', coding: 'Coding', researching: 'Researching', finishing: 'Finishing', idle: 'Idle' };
export const bundledDemoIds = new Set(['demo-nova', 'demo-atlas', 'demo-sentinel']);
export function displayPrompt(task: OfficeTask, translate: (text: string) => string): string {
    return bundledDemoIds.has(task.id) ? translate(task.prompt) : task.prompt;
}
export function displayEvent(task: OfficeTask, message: string, translate: (text: string) => string): string {
    return task.id.startsWith('demo-') ? translate(message) : message;
}
export const icons = { architecture: BrainCircuit, engineering: Code2, design: Layers3, quality: ShieldCheck, research: Library, operations: Network, security: LockKeyhole, data: Database, general: Users };
