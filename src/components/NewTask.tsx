import { useState } from 'react';
import { ArrowRight, Check, ShieldCheck, X } from 'lucide-react';
import type { AgentId, OfficeTask, ProviderId, ProviderInfo } from '../types';
import { useAgents } from '../agents';
import { useLanguage } from '../locales/i18n';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { isAbsoluteWorkspace } from './dataFlow';

const defaultProviders: ProviderInfo[] = [
  { id: 'codex', name: 'Codex CLI', available: false },
  { id: 'claude', name: 'Claude Code', available: false },
  { id: 'gemini', name: 'Gemini CLI', available: false },
];

export function NewTask({ agent, setAgent, workspace, setWorkspace, close, start, busy, demo, provider, setProvider, providers, online, agentBusy, error, tasks }: {
  agent: AgentId;
  setAgent: (a: AgentId) => void;
  workspace: string;
  setWorkspace: (v: string) => void;
  close: () => void;
  start: (prompt: string, dependsOn?: string) => void;
  busy: boolean;
  demo: boolean;
  provider: ProviderId;
  setProvider: (p: ProviderId) => void;
  providers: ProviderInfo[];
  online: boolean;
  agentBusy: boolean;
  error: string;
  tasks: OfficeTask[];
}) {
  const { t: tr } = useLanguage();
  const agents = useAgents();
  const [prompt, setPrompt] = useState('');
  const [dependsOn, setDependsOn] = useState('');
  // Handoff source: another agent's recently completed tasks, newest first.
  const handoffOptions = tasks.filter(item => item.status === 'completed' && item.agentId !== agent).slice(0, 10);
  const options = providers.length ? providers : defaultProviders;
  const blocked = demo ? '' : !online ? 'API OFFLINE' : !options.some(item => item.available) ? 'No AI provider is available.'
    : !options.some(item => item.id === provider && item.available) ? 'Choose an available AI provider.'
    : agentBusy ? 'Agent is already working.' : !isAbsoluteWorkspace(workspace) ? 'Enter an absolute project path.' : '';

  return <Modal close={close} busy={busy} labelledBy="new-mission">
    <form onSubmit={event => { event.preventDefault(); if (!busy && !blocked && prompt.trim() && agents.some(item => item.id === agent)) start(prompt, dependsOn || undefined); }}>
      <div className="modal-title">
        <div><span className="eyebrow"><span /> {tr('A NEW MISSION')}</span><h2 id="new-mission">{tr('Create a task')} <b>✳</b></h2></div>
        <button type="button" onClick={close} disabled={busy} aria-label={tr('Close')}><X size={19}/></button>
      </div>
      <fieldset disabled={busy}>
      <label htmlFor="prompt">{tr('WHAT DO YOU WANT TO BUILD?')}</label>
      <textarea id="prompt" maxLength={10000} required data-autofocus rows={5} placeholder={tr('Example: Analyze this project, identify performance bottlenecks and improve them...')} value={prompt} onChange={event => setPrompt(event.target.value)} aria-describedby={error ? 'task-error' : undefined}/>
      <span id="assign-to" className="field-label">{tr('ASSIGN TO')}</span>
      <div className="modal-agent-list" role="group" aria-labelledby="assign-to">
        {agents.map(item => <button type="button" aria-pressed={agent === item.id} key={item.id} className={agent === item.id ? 'selected' : ''} onClick={() => setAgent(item.id)}>
          <Avatar id={item.id} size="sm"/>{item.name}{agent === item.id && <Check size={14}/>}
        </button>)}
      </div>
      <label htmlFor="task-provider">{tr('AI provider')}</label>
      <select id="task-provider" className="language-picker" value={provider} onChange={event => setProvider(event.target.value as ProviderId)}>
        {options.map(item => <option key={item.id} value={item.id} disabled={!demo && !item.available}>
          {item.name}{!demo && !item.available ? ` (${tr('NOT FOUND')})` : ''}
        </option>)}
      </select>
      <label htmlFor="task-handoff">{tr('HANDOFF FROM')}</label>
      <select id="task-handoff" className="language-picker" value={dependsOn} onChange={event => setDependsOn(event.target.value)}>
        <option value="">{tr('None — start fresh')}</option>
        {handoffOptions.map(item => <option key={item.id} value={item.id}>
          {(agents.find(a => a.id === item.agentId)?.name || item.agentId) + ': ' + item.prompt.slice(0, 60) + (item.prompt.length > 60 ? '…' : '')}
        </option>)}
      </select>
      {!import.meta.env.MODE.includes('public-demo') && <><label htmlFor="mission-dir">{tr('PROJECT DIRECTORY')}</label>
      <input id="mission-dir" maxLength={1000} value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder={tr('Absolute project path')} disabled={demo}/></>}
      </fieldset>
      {blocked && <p id="task-blocked" className="form-error" role="status">{tr(blocked)}</p>}
      {error && <p id="task-error" className="form-error" role="alert">{error}</p>}
      <div className="modal-bottom">
        <span><ShieldCheck size={15}/>{demo ? tr('Preview only · no real execution') : tr('Runs locally with selected CLI')}</span>
        <button type="submit" className="primary-btn" disabled={!prompt.trim() || busy || Boolean(blocked) || !agents.some(item => item.id === agent)} aria-describedby={blocked ? 'task-blocked' : undefined}>
          {busy ? tr('Starting...') : tr('Launch task')} <ArrowRight size={17}/>
        </button>
      </div>
    </form>
  </Modal>;
}
