import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, Command, Info, Wifi, WifiOff, X } from 'lucide-react';
import { demoTasks, type AgentId, type OfficeAgent, type OfficeTask, type ProviderId, type ServerState } from './types';
import { AgentsContext } from './agents';
import { useLanguage } from './locales/i18n';
import type { View } from './views/types';
import { Dot } from './components/Avatar';
import { Sidebar } from './components/Sidebar';
import { NewTask } from './components/NewTask';
import { isAbsoluteWorkspace, isOfficeTask, isServerState, readResponse } from './components/dataFlow';
import { bundledDemoIds } from './components/taskDisplay';
import { Studio } from './views/Studio';
import { TaskList } from './views/Tasks';
import { Team } from './views/Team';
import { Settings } from './views/Settings';
import { OfficePreferencesContext } from './scene/OfficePreferencesContext';
import { loadOfficePreferences, normalizeOfficePreferences, OFFICE_PREFERENCES_KEY } from './scene/officePreferences';
import { loadDemoRoster, makeDemoAgent, saveDemoRoster, validateDemoAgent } from './demo/roster';

const PUBLIC_DEMO = import.meta.env.MODE === 'public-demo';
const EMPTY_AGENTS: OfficeAgent[] = [];
type Toast = { message: string; kind: 'success' | 'error' | 'info' };

export default function App() {
  const { t: tr, formatTime } = useLanguage();
  const [view, setView] = useState<View>('studio');
  const [selected, setSelected] = useState<AgentId>('nova');
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [demo, setDemo] = useState(true);
  const [demoData, setDemoData] = useState(demoTasks);
  const [server, setServer] = useState<ServerState | null>(null);
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(!PUBLIC_DEMO);
  const [stateError, setStateError] = useState(false);
  const [demoRoster, setDemoRoster] = useState<OfficeAgent[]>(loadDemoRoster);
  const [workspace, setWorkspace] = useState('');
  const [officePreferences, setOfficePreferences] = useState(loadOfficePreferences);
  const [provider, setProvider] = useState<ProviderId>(() => {
    try { const stored = localStorage.getItem('agent-office-provider'); if (stored === 'claude' || stored === 'gemini') return stored; } catch { /* Storage disabled */ }
    return 'codex';
  });
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [now, setNow] = useState(() => new Date());
  const toastTimer = useRef<number | undefined>(undefined);
  const demoTimers = useRef<number[]>([]);
  const starting = useRef(false);
  const mutations = useRef(new Set<string>());
  const mounted = useRef(false);
  const snapshotVersion = useRef(0);
  const pendingState = useRef<AbortController | null>(null);
  const workspaceTouched = useRef(false);
  const agents = demo ? demoRoster : server?.agents ?? EMPTY_AGENTS;
  // Created-task history survives agent removal; bundled samples belong to the sample crew only.
  const tasks = useMemo(() => demo ? demoData.filter(task => !bundledDemoIds.has(task.id) || agents.some(agent => agent.id === task.agentId)) : server?.tasks ?? [], [demo, demoData, server, agents]);
  const resolvedSelected = agents.some(agent => agent.id === selected) ? selected : agents[0]?.id ?? '';
  const inspectedAgent = tasks.find(task => task.id === selectedTask)?.agentId ?? resolvedSelected;
  const cliReady = Boolean(online && server?.providers.some(item => item.available));

  function updateOfficePreferences(update: Partial<typeof officePreferences>) {
    setOfficePreferences(current => {
      const next = normalizeOfficePreferences({ ...current, ...update });
      try { localStorage.setItem(OFFICE_PREFERENCES_KEY, JSON.stringify(next)); } catch { /* Storage disabled */ }
      return next;
    });
  }
  function notice(message: string, kind: Toast['kind'] = 'success') {
    window.clearTimeout(toastTimer.current);
    setToast({ message, kind });
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }
  function chooseProvider(value: ProviderId) {
    setProvider(value); setTaskError('');
    try { localStorage.setItem('agent-office-provider', value); } catch { /* Storage disabled */ }
  }
  function selectAgent(id: AgentId) { setSelected(id); setSelectedTask(null); setTaskError(''); }
  function editWorkspace(value: string) { workspaceTouched.current = true; setWorkspace(value); setTaskError(''); }
  function changeMode(value: boolean) {
    if (PUBLIC_DEMO || starting.current) return;
    setDemo(value); setSelectedTask(null); setModal(false); setTaskError('');
    notice(tr(value ? 'Showing demo preview' : 'Showing real AI events'), 'info');
  }
  const acceptState = useCallback((data: unknown) => {
    if (!isServerState(data)) throw new Error('Invalid state');
    snapshotVersion.current++;
    setServer(data); setOnline(data.connected); setLoading(false); setStateError(!data.connected);
    if (!workspaceTouched.current) setWorkspace(data.defaultWorkspace);
  }, []);
  const reloadState = useCallback(async () => {
    pendingState.current?.abort();
    const controller = new AbortController();
    pendingState.current = controller;
    const version = snapshotVersion.current;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/state', { signal: controller.signal });
      if (!response.ok) throw new Error('State unavailable');
      const data: unknown = await response.json();
      // Stream updates and disconnects supersede the HTTP request that preceded them.
      if (mounted.current && pendingState.current === controller && version === snapshotVersion.current) acceptState(data);
    } catch {
      if (mounted.current && pendingState.current === controller && version === snapshotVersion.current) {
        setOnline(false); setStateError(true);
      }
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current && pendingState.current === controller) setLoading(false);
    }
  }, [acceptState]);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const previewTimers = demoTimers.current;
    let stream: EventSource | undefined;
    if (!PUBLIC_DEMO) {
      // Skip the StrictMode probe mount before opening its initial HTTP request.
      queueMicrotask(() => { if (active) void reloadState(); });
      stream = new EventSource('/api/events');
      stream.addEventListener('state', event => {
        if (!active) return;
        try { acceptState(JSON.parse((event as MessageEvent).data)); }
        catch { snapshotVersion.current++; setStateError(true); setOnline(false); setLoading(false); }
      });
      stream.onerror = () => {
        if (!active) return;
        snapshotVersion.current++; setOnline(false); setStateError(true); setLoading(false);
      };
    }
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => {
      mounted.current = false;
      active = false;
      pendingState.current?.abort(); stream?.close(); window.clearInterval(timer);
      window.clearTimeout(toastTimer.current);
      previewTimers.forEach(window.clearTimeout);
    };
  }, [acceptState, reloadState]);
  useEffect(() => { saveDemoRoster(demoRoster); }, [demoRoster]);

  function showNew(agent?: AgentId) {
    if (!agents.length) { setView('team'); notice(tr('Add an agent to create tasks'), 'info'); return; }
    selectAgent(agent || resolvedSelected); setModal(true);
  }
  async function start(prompt: string, dependsOn?: string) {
    if (starting.current || !prompt.trim() || prompt.length > 10000 || !agents.some(agent => agent.id === resolvedSelected)) return;
    const blocked = !demo && (!online ? 'API OFFLINE' : !server?.providers.some(item => item.id === provider && item.available) ? 'Choose an available AI provider.'
      : tasks.some(task => task.agentId === resolvedSelected && task.status === 'running') ? 'Agent is already working.'
      : !isAbsoluteWorkspace(workspace) ? 'Enter an absolute project path.' : '');
    if (blocked) { setTaskError(tr(blocked)); return; }
    starting.current = true; setBusy(true); setTaskError('');
    try {
      if (demo) {
        const id = 'demo-' + crypto.randomUUID(), stamp = new Date().toISOString();
        const task: OfficeTask = { id, prompt: prompt.trim(), agentId: resolvedSelected, agentName: agents.find(agent => agent.id === resolvedSelected)?.name, provider, workspace: 'Demo workspace', status: 'running', phase: 'thinking', createdAt: stamp, updatedAt: stamp, finishedAt: null, lastMessage: '', threadId: null, ...(dependsOn ? { dependsOn } : {}), events: [{ id: id + 'e', at: stamp, kind: 'info', message: 'Preview started. No code is executed.' }] };
        setDemoData(value => [task, ...value]); setSelectedTask(id);
        notice(tr('Demo task started · preview only'));
        const advance = (complete: boolean) => setDemoData(value => value.map(item => {
          if (item.id !== id || item.status !== 'running') return item;
          const at = new Date().toISOString();
          return { ...item, phase: complete ? 'idle' : 'coding', status: complete ? 'completed' : 'running', updatedAt: at, finishedAt: complete ? at : null,
            events: [...item.events, { id: id + (complete ? 'g' : 'f'), at, kind: complete ? 'success' : 'info', message: complete ? 'Preview task completed.' : 'Simulating agent activity...' }] };
        }));
        demoTimers.current.push(window.setTimeout(() => advance(false), 2000), window.setTimeout(() => advance(true), 7000));
      } else {
        let response: Response;
        try {
          response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: resolvedSelected, provider, prompt: prompt.trim(), workspace, ...(dependsOn ? { dependsOn } : {}) }), signal: AbortSignal.timeout(15000) });
        } catch { throw new Error(tr('No confirmation received. Check task history before trying again.')); }
        const result = await readResponse(response, tr(response.ok ? 'No confirmation received. Check task history before trying again.' : 'Could not start task'));
        if (!isOfficeTask(result.task) || result.task.agentId !== resolvedSelected) throw new Error(tr('No confirmation received. Check task history before trying again.'));
        const task = result.task;
        if (!mounted.current) return;
        // Keep a newer streamed version, but display a newly acknowledged task immediately.
        setServer(value => value && ({ ...value, tasks: value.tasks.some(item => item.id === task.id) ? value.tasks : [task, ...value.tasks] }));
        setSelectedTask(task.id);
        notice((server?.providers.find(item => item.id === provider)?.name || provider) + ' · ' + tr('Task started'));
      }
      setModal(false); setView('studio');
    } catch (error) {
      if (mounted.current) setTaskError(error instanceof Error ? error.message : tr('Could not start task'));
    } finally { starting.current = false; if (mounted.current) setBusy(false); }
  }
  async function cancel(id: string) {
    if (!tasks.some(task => task.id === id && task.status === 'running') || mutations.current.has(id)) return;
    if (demo) {
      const at = new Date().toISOString();
      setDemoData(value => value.map(task => task.id === id && task.status === 'running' ? { ...task, status: 'cancelled', phase: 'idle', finishedAt: at, updatedAt: at,
        events: [...task.events, { id: crypto.randomUUID(), at, kind: 'info', message: 'Preview stopped' }] } : task));
      notice(tr('Preview stopped')); return;
    }
    if (!online) { notice(tr('API OFFLINE'), 'error'); return; }
    mutations.current.add(id);
    try {
      const response = await fetch('/api/tasks/' + encodeURIComponent(id) + '/cancel', { method: 'POST', signal: AbortSignal.timeout(15000) });
      const result = await readResponse(response, tr('Cancellation failed'));
      if (result.ok !== true) throw new Error(tr('Cancellation failed'));
      notice(tr('Cancellation requested'), 'info'); void reloadState();
    } catch (error) { notice(error instanceof Error ? error.message : tr('Cancellation failed'), 'error'); }
    finally { mutations.current.delete(id); }
  }
  async function saveAgent(input: Omit<OfficeAgent, 'id' | 'short'>, id?: string) {
    if (demo) {
      const agent = makeDemoAgent(input, id);
      if (!validateDemoAgent(agent) || (id && !agents.some(item => item.id === id))) { notice(tr('Invalid agent details'), 'error'); return false; }
      if (!id && demoRoster.length >= 1000) { notice(tr('Preview is limited to 1000 agents'), 'error'); return false; }
      setDemoRoster(current => id ? current.map(item => item.id === id ? agent : item) : [...current, agent]);
      selectAgent(agent.id); notice(tr(id ? 'Agent updated' : 'Agent created')); return true;
    }
    if (!online) { notice(tr('API OFFLINE'), 'error'); return false; }
    const version = snapshotVersion.current;
    try {
      const response = await fetch(id ? '/api/agents/' + encodeURIComponent(id) : '/api/agents', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
      const result = await readResponse(response, tr('Unable to save agent'));
      if (!validateDemoAgent(result.agent) || (id && result.agent.id !== id)) throw new Error(tr('Unable to save agent'));
      const agent = result.agent;
      // A delayed response must neither overwrite a newer streamed edit nor resurrect a removed agent.
      if (version === snapshotVersion.current) setServer(value => value && ({ ...value, agents: value.agents.some(item => item.id === agent.id)
        ? value.agents.map(item => item.id === agent.id ? agent : item) : [...value.agents, agent] }));
      selectAgent(agent.id); notice(tr(id ? 'Agent updated' : 'Agent created')); return true;
    } catch (error) { notice(error instanceof Error ? error.message : tr('Unable to save agent'), 'error'); return false; }
  }
  async function deleteAgent(id: string) {
    if (tasks.some(task => task.agentId === id && task.status === 'running')) { notice(tr('Agent is already working.'), 'error'); return false; }
    if (demo) setDemoRoster(current => current.filter(item => item.id !== id));
    else {
      if (!online) { notice(tr('API OFFLINE'), 'error'); return false; }
      try {
        const response = await fetch('/api/agents/' + encodeURIComponent(id), { method: 'DELETE', signal: AbortSignal.timeout(15000) });
        const result = await readResponse(response, tr('Unable to remove agent'));
        if (result.ok !== true) throw new Error(tr('Unable to remove agent'));
        setServer(value => value && ({ ...value, agents: value.agents.filter(item => item.id !== id) }));
      } catch (error) { notice(error instanceof Error ? error.message : tr('Unable to remove agent'), 'error'); return false; }
    }
    if (id === selected) selectAgent(agents.find(item => item.id !== id)?.id || '');
    notice(tr('Agent removed')); return true;
  }
  const ToastIcon = toast?.kind === 'error' ? AlertCircle : toast?.kind === 'info' ? Info : CheckCircle2;
  return <OfficePreferencesContext.Provider value={{ preferences: officePreferences, updatePreferences: updateOfficePreferences }}><AgentsContext.Provider value={agents}>
    <div className="shell">
      <a className="skip-link" href="#main-content">{tr('Skip to content')}</a>
      <Sidebar view={view} setView={setView} onNew={() => showNew()}/>
      <div className="app-main">
        <header className="topbar"><div className="crumb"><span><Command size={15}/></span>{' ' + tr('My workspace') + ' '}<b>/</b><strong>{tr(view === 'studio' ? 'Office studio' : view === 'tasks' ? 'Activity & tasks' : view === 'team' ? 'Agent team' : 'Settings')}</strong><ChevronDown size={13}/></div>
          <div className="topbar-actions"><time>{formatTime(now)}</time><i/>{PUBLIC_DEMO ? <span className="api-badge on"><Wifi size={14}/>{tr('Demo environment')}</span> : <span className={cliReady ? 'api-badge on' : 'api-badge'}>{cliReady ? <Wifi size={14}/> : <WifiOff size={14}/>} {tr(cliReady ? 'READY' : online ? 'NOT FOUND' : 'API OFFLINE')}</span>}
            {PUBLIC_DEMO ? <span className="mode-btn demo"><Dot status="amber"/>{tr('DEMO MODE')}</span> : <button className={demo ? 'mode-btn demo' : 'mode-btn live'} aria-pressed={demo} onClick={() => changeMode(!demo)}><Dot status={demo ? 'amber' : online ? 'running' : 'failed'}/>{tr(demo ? 'DEMO MODE' : 'LIVE MODE')} <ChevronDown size={13}/></button>}
          </div>
        </header>
        <main id="main-content" className="page-content" tabIndex={-1}>
          {!demo && (loading || stateError || !online) && <div className="connection-message" role={stateError ? 'alert' : 'status'}>
            <span>{tr(loading ? 'Loading workspace…' : server ? 'Showing saved activity; the API is offline.' : 'Unable to load workspace')}</span>
            {!loading && <button type="button" onClick={() => { setLoading(true); void reloadState(); }}>{tr('Retry')}</button>}
          </div>}
          {view === 'studio' && <Studio tasks={tasks} selected={inspectedAgent} setSelected={selectAgent} selectedTask={selectedTask} setSelectedTask={setSelectedTask} onNew={() => showNew()} demo={demo} ready={cliReady} connected={demo ? undefined : online}/>}
          {view === 'tasks' && <TaskList tasks={tasks} onSelect={(id, taskId) => { setSelected(id); setSelectedTask(taskId); setView('studio'); }} cancel={cancel} canCancel={demo || online}/>}
          {view === 'team' && <Team tasks={tasks} onTask={showNew} onSave={saveAgent} onDelete={deleteAgent} connected={demo || online} demo={demo}/>}
          {view === 'settings' && <Settings workspace={workspace} setWorkspace={editWorkspace} demo={demo} setDemo={changeMode} server={server} online={online} publicPreview={PUBLIC_DEMO}/>}
        </main>
        <footer><span>© 2026 Agent Office <b>✳</b>{' ' + tr('Made for builders')}</span><span>v0.4.0 <i>·</i>{' ' + tr('Open source')}</span></footer>
      </div>
      {modal && agents.length > 0 && <NewTask agent={resolvedSelected} setAgent={selectAgent} provider={provider} setProvider={chooseProvider} providers={server?.providers || []} workspace={workspace} setWorkspace={editWorkspace} close={() => setModal(false)} start={start} busy={busy} demo={demo} online={online} agentBusy={tasks.some(task => task.agentId === resolvedSelected && task.status === 'running')} error={taskError} tasks={tasks}/>}
      {toast && <div className={'toast toast-' + toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'}><ToastIcon size={17}/>{toast.message}<button onClick={() => { window.clearTimeout(toastTimer.current); setToast(null); }} aria-label={tr('Dismiss toast')}><X size={14}/></button></div>}
    </div>
  </AgentsContext.Provider></OfficePreferencesContext.Provider>;
}
