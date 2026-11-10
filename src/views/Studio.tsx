import { lazy, Suspense, useState } from 'react';
import { Activity, ArrowRight, ArrowUpRight, Box, CheckCircle2, CircleHelp, Cpu, Eye, Maximize2, MoreHorizontal, MousePointer2, Plus, Radio, Terminal, Users } from 'lucide-react';
import type { AgentId, OfficeTask } from '../types';
import { displayAgentText, useAgents } from '../agents';
import { useLanguage } from '../locales/i18n';
import { Avatar, Dot } from '../components/Avatar';
import { TaskTile } from '../components/TaskTile';
import { icons } from '../components/taskDisplay';
import { ExecutionInspector } from '../components/ExecutionInspector';
const OfficeScene = lazy(() => import('../scene/OfficeScene'));

export function Studio({ tasks, selected, setSelected, selectedTask, setSelectedTask, onNew, demo, ready, connected }: {
    tasks: OfficeTask[];
    selected: AgentId;
    setSelected: (a: AgentId) => void;
    selectedTask: string | null;
    setSelectedTask: (v: string | null) => void;
    onNew: () => void;
    demo: boolean;
    ready: boolean;
    // Live API/SSE reachability (App `online`; undefined in demo mode, where
    // agents are never OFFLINE). Passed to the 3D scene for OFFLINE status.
    connected?: boolean;
}) {
    const { t: tr } = useLanguage();
    const agents = useAgents();
    const [viewMode, setViewMode] = useState<'auto' | 'overview' | 'focus'>('auto');
    // Introduce the whole team before the user chooses an individual workstation.
    const viewAll = viewMode === 'overview' || (viewMode === 'auto' && agents.length > 1);
    const active = tasks.filter(t => t.status === 'running');
    const done = tasks.filter(t => t.status === 'completed');
    const focus = tasks.find(t => t.id === selectedTask)
      ?? tasks.find(t => t.agentId === selected && t.status === 'running')
      ?? tasks.find(t => t.agentId === selected);
    const removedTask = focus && !agents.some(agent => agent.id === focus.agentId) ? focus : null;
    const agent = removedTask ? { id: removedTask.agentId, name: removedTask.agentName || removedTask.agentId, role: 'Former agent', specialty: '', color: '#9ba9c2', short: '—', department: 'general' as const }
      : agents.find(a => a.id === (focus?.agentId ?? selected)) ?? agents[0] ?? { id: '', name: '—', role: '', specialty: '', color: '#9ba9c2', short: '', department: 'general' as const };
    const Icon = icons[agent.department];
    const selectAgent = (id: AgentId) => { setSelectedTask(null); setSelected(id); setViewMode('focus'); };
    return <><div className="intro"><div><div className="eyebrow"><span />{" " + tr("WELCOME TO YOUR WORKSPACE")}</div><h1>{tr("Mission control") + " "}<b>✳</b></h1><p>{tr("Your agents are ready to bring ideas to life. Here's what's happening.")}</p></div><button className="primary-btn" onClick={onNew} aria-label={tr("New task")}><Plus size={18}/>{" " + tr("New task") + " "}<ArrowUpRight size={16}/></button></div>
    <div className="stat-grid"><div className="stat"><div>{tr("Total agents") + " "}<Users size={17}/></div><strong>{String(agents.length).padStart(2, '0')} <small>{tr("agents")}</small></strong><span><Dot status="purple"/>{" " + tr("Ready to collaborate")}</span></div><div className="stat"><div>{tr("Working now") + " "}<Cpu size={17}/></div><strong>{String(active.length).padStart(2, '0')} <small>{tr('active')}</small></strong><span><Dot status="running"/> {active.length ? tr("Making progress") : tr("Waiting for a mission")}</span></div><div className="stat"><div>{tr("Tasks completed") + " "}<CheckCircle2 size={17}/></div><strong>{String(done.length).padStart(2, '0')} <small>{tr("tasks")}</small></strong><span><Dot status="cyan"/>{" " + tr("Across your workspace")}</span></div><div className="stat"><div>{tr("Workspace status") + " "}<Radio size={17}/></div><strong className="stat-word">{demo ? tr("Demo mode") : ready ? tr("Connected") : tr("Offline")}</strong><span><Dot status={demo ? 'amber' : ready ? 'running' : 'failed'}/>{demo ? tr("Sample activity only") : ready ? tr('AI CLI is available') : tr("Check local API")}</span></div></div>
    <div className="workspace-grid"><section className="office-section"><div className="section-head"><div><h2>{tr("Live office") + " "}<span>●</span></h2><p>{tr("A little world where big things happen")}</p></div><div className="section-tags"><span className="stream-badge"><Dot status="running"/>{demo ? tr("DEMO FEED") : tr("LIVE FEED")}</span><span className="view-badge"><Box size={15}/>{" " + tr("3D VIEW")}</span></div></div>
      <div className="scene-frame"><Suspense fallback={<div className="scene-loading" role="status">{tr("Loading 3D office\u2026")}</div>}><OfficeScene selected={selected} tasks={tasks} onSelect={selectAgent} overview={viewAll} connected={connected}/></Suspense><div className="scene-top-left"><Eye size={15}/> {tr('OFFICE 01')} <span>/ {tr("MAIN FLOOR")}</span></div><div className="scene-top-right"><Dot status="running"/>{active.length} / {agents.length} {tr("agents working")}</div><div className="scene-hint"><MousePointer2 size={13}/>{" " + tr("Click an agent to inspect") + " "}<i>·</i>{" " + tr("Drag to orbit") + " "}<i>·</i>{" " + tr("Scroll to zoom")}</div><button type="button" className="scene-overview-btn" disabled={viewAll} onClick={() => setViewMode('overview')} title={tr('Show entire office')} aria-label={tr('Show entire office')}><Maximize2 size={16}/></button></div>
      <div className="crew-header"><div><h3>{tr("Meet your crew")}</h3><p>{tr("Click any team member to see what they're up to.")}</p></div><span>{agents.length} {tr("MEMBERS")} <ArrowRight size={15}/></span></div>
      <div className="crew-grid">{agents.map(a => { const working = tasks.some(t => t.agentId === a.id && t.status === 'running'); return <button className={`crew-card ${selected === a.id ? 'chosen' : ''}`} key={a.id} aria-pressed={selected === a.id} onClick={() => selectAgent(a.id)}><Avatar id={a.id} size="lg"/><span className="crew-meta"><strong>{a.name}</strong><small>{displayAgentText(a, 'role', tr)}</small><span><Dot status={working ? 'running' : 'idle'}/>{working ? tr("Working") : tr("Available")}</span></span><ArrowUpRight size={14}/></button>; })}</div>
    </section><aside className="ops"><div className="ops-title"><h2>{tr("Operations")}</h2><MoreHorizontal size={19}/></div><div className="agent-inspector"><div className="inspector-top"><span style={{ color: agent.color, background: `${agent.color}20` }}><Icon size={21}/></span><small><Dot status="running"/>{" " + tr("SELECTED AGENT")}</small></div><div className="inspector-person"><Avatar id={agent.id} size="lg"/><div><strong>{agent.name}</strong><span>{removedTask ? tr('Former agent') : displayAgentText(agent, 'role', tr)}</span></div></div><p>{displayAgentText(agent, 'specialty', tr)}</p><div className="inspector-status"><span>{tr("Current status")}</span><strong><Dot status={tasks.some(t => t.agentId === agent.id && t.status === 'running') ? 'running' : 'idle'}/>{tasks.some(t => t.agentId === agent.id && t.status === 'running') ? tr("Working on a task") : tr("Available for work")}</strong></div><button className="assign-btn" disabled={!agents.length || Boolean(removedTask)} onClick={onNew}><Plus size={16}/>{" " + tr("Assign a task") + " "}<ArrowRight size={15}/></button></div>
      <ExecutionInspector task={focus}/><div className="feed-head"><div><h3>{tr("Task feed")}</h3><span>{tasks.length}{" " + tr("tasks")}</span></div><Activity size={17}/></div><div className="feed-list">{tasks.length ? tasks.slice(0, 5).map(t => <TaskTile key={t.id} task={t} selected={focus?.id === t.id} onClick={() => { setSelected(t.agentId); setSelectedTask(t.id); }}/>) : <div className="feed-empty"><Terminal size={28}/><strong>{tr("A clean slate")}</strong><p>{tr("Assign a task to see your team in action.")}</p></div>}</div>
      <div className="ops-foot"><span><Dot status={demo ? "amber" : ready ? "running" : "failed"}/>{" " + tr(demo ? "Preview only · no real execution" : ready ? "Local connection monitored" : "API OFFLINE")}</span><CircleHelp size={15}/></div>
    </aside></div>
  </>;
}
