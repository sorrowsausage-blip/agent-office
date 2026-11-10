import express from 'express'
import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverProviders, foldersOverlap, providerCommand } from './providers.mjs'
import { DEFAULT_AGENTS, makeAgent, validStoredAgents, validateAgent } from './agents.mjs'
import { composeAgentPrompt } from './agent-prompt.mjs'
import { isApprovalWaitText, jsonLines, parseMessage, shrink } from './task-output.mjs'
import { terminateProcess } from './processes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
// Installed CLI writes history to a user-writable directory. Source development
// keeps the existing .local/tasks.json location for backwards compatibility.
const STORE = join(process.env.AGENT_OFFICE_DATA_DIR || join(ROOT, '.local'), 'tasks.json')
const AGENT_STORE = join(dirname(STORE), 'agents.json')
const PORT = Number(process.env.PORT || 4300)
const MAX_TASKS = 150
const MAX_PROMPT = 10000
// Idle watchdog (phase 3a): a running task with no stdout JSON for longer
// than this only gets a warning event, never a status change. Overridable
// for tests via AGENT_OFFICE_IDLE_WATCHDOG_MS.
const IDLE_WATCHDOG_MS = (() => {
  const raw = Number(process.env.AGENT_OFFICE_IDLE_WATCHDOG_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000
})()
const INSTANCE_ID = process.env.AGENT_OFFICE_INSTANCE_ID || randomUUID()
let agents = DEFAULT_AGENTS.map(agent => ({ ...agent }))
let agentsPersistChain = Promise.resolve()
const active = new Map()
const clients = new Set()
let tasks = []
let persistTimer
let persistChain = Promise.resolve()
let historyReadable = true
let agentsReadable = true
let historyWriteError = false
let shuttingDown = false
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Port must be between 1 and 65535.')

const providers = discoverProviders()
const app = express()
app.disable('x-powered-by')
app.use((req, res, next) => {
  // Protect static content too: an untrusted Host must not load a usable office.
  const host = req.headers.host
  if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(host)) {
    return res.status(403).json({ error: 'Host não autorizado.' })
  }
  const origin = req.headers.origin
  const allowed = origin && ['127.0.0.1', 'localhost'].some(host =>
    origin === `http://${host}:${PORT}` || origin === `http://${host}:5173`)
  if (origin && !allowed) return res.status(403).json({ error: 'Origem não autorizada.' })
  // Fetch metadata covers browsers which omit Origin; local CLI clients remain supported.
  if (req.path.startsWith('/api') && req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Origem não autorizada.' })
  if (shuttingDown && req.path.startsWith('/api')) return res.status(503).json({ error: 'Office is shutting down.' })
  next()
})
app.use('/api', express.json({ limit: '64kb' }))
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  const emptyTaskAction = req.method === 'POST' && /^\/tasks\/[^/]+\/(cancel|blocked|unblock)$/.test(req.path) &&
    !req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0')
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !emptyTaskAction && !req.is('application/json')) {
    return res.status(415).json({ error: 'Use application/json.' })
  }
  next()
})

const stamp = () => new Date().toISOString()
const visible = task => ({ ...task })

function snapshot() {
  return {
    connected: true,
    instanceId: INSTANCE_ID,
    codexAvailable: providers.find(provider => provider.id === 'codex').available,
    providers: providers.map(({ id, name, available }) => ({ id, name, available })),
    defaultWorkspace: process.env.AGENT_OFFICE_WORKSPACE || ROOT,
    agents,
    tasks: tasks.map(visible),
    storage: { historyReadable, agentsReadable, historyWriteError },
  }
}

// Serialize edits and acknowledge them only after the new roster is safely on disk.
async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(contents); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
  }
  finally { await rm(temporary, { force: true }).catch(() => {}) }
}

function changeAgents(edit) {
  const operation = agentsPersistChain.then(async () => {
    if (!agentsReadable) throw new Error('Existing profiles are unreadable; refusing to overwrite them.')
    const update = edit(agents)
    if (update.error) return update
    const contents = JSON.stringify(update.next, null, 2)
    await atomicWrite(AGENT_STORE, contents)
    agents = update.next
    notifyState()
    return update
  })
  agentsPersistChain = operation.then(() => {}, error => console.error('Could not save agents:', error.message))
  return operation
}

async function loadAgents() {
  try {
    const stored = JSON.parse(await readFile(AGENT_STORE, 'utf8'))
    if (validStoredAgents(stored)) agents = stored.map(agent => makeAgent(agent, agent.id))
    else throw new Error('Invalid agents.json; retained defaults without overwriting the file.')
  } catch (error) {
    if (error.code !== 'ENOENT') { agentsReadable = false; console.error('Could not load agents:', error.message) }
  }
}

function persistHistory() {
  if (!historyReadable) return Promise.reject(new Error('Existing history is unreadable; refusing to overwrite it.'))
  const contents = JSON.stringify(tasks, null, 2)
  const operation = persistChain.then(async () => { await atomicWrite(STORE, contents); historyWriteError = false })
  persistChain = operation.catch(error => {
    historyWriteError = true
    console.error('Could not save task history:', error.message)
    notifyState()
  })
  return operation
}

function notify() {
  notifyState()
  // Fixed deadline: continuous output cannot postpone saving indefinitely.
  if (!persistTimer && historyReadable && !shuttingDown) persistTimer = setTimeout(() => {
    persistTimer = undefined
    void persistHistory().catch(() => {})
  }, 300)
}

function addEvent(task, message, kind = 'info') {
  task.events = [...task.events, { id: randomUUID(), at: stamp(), kind, message: shrink(message, 350) }].slice(-35)
  task.updatedAt = stamp()
  notify()
}

async function loadHistory() {
  try {
    const value = JSON.parse(await readFile(STORE, 'utf8'))
    const object = item => item && typeof item === 'object' && !Array.isArray(item)
    const optionalText = item => item == null || typeof item === 'string'
    if (!Array.isArray(value) || !value.every(task => object(task) &&
      typeof task.id === 'string' && typeof task.agentId === 'string' && typeof task.prompt === 'string' &&
      typeof task.workspace === 'string' && ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'queued'].includes(task.status) &&
      ['thinking', 'coding', 'researching', 'finishing', 'idle'].includes(task.phase) &&
      typeof task.createdAt === 'string' && typeof task.updatedAt === 'string' && optionalText(task.finishedAt) &&
      optionalText(task.agentName) && optionalText(task.failure) &&
      (task.awaitingApproval == null || typeof task.awaitingApproval === 'boolean') &&
      (task.dependsOn == null || typeof task.dependsOn === 'string') &&
      (task.provider == null || ['codex', 'claude', 'gemini'].includes(task.provider)) &&
      (task.usage == null || (object(task.usage) && ['input_tokens', 'output_tokens'].every(key => task.usage[key] == null ||
        (typeof task.usage[key] === 'number' && Number.isFinite(task.usage[key]))))) &&
      (task.events === undefined || (Array.isArray(task.events) && task.events.every(event => object(event) &&
        ['id', 'at', 'kind', 'message'].every(key => typeof event[key] === 'string'))))) ||
      new Set(value.map(task => task.id)).size !== value.length) {
      throw new Error('Invalid task history; the original file was preserved.')
    }
    tasks = value.slice(0, MAX_TASKS).map(task => ({ ...task, provider: task.provider || 'codex', events: task.events || [], finishedAt: task.finishedAt || null,
      ...(task.status === 'running' ? { status: 'interrupted', phase: 'idle', finishedAt: stamp(), updatedAt: stamp() } : {}) }))
  } catch (error) {
    if (error.code !== 'ENOENT') { historyReadable = false; console.error('Could not load history:', error.message) }
  }
}

app.get('/api/state', (_req, res) => res.json(snapshot()))
app.post('/api/agents', async (req, res) => {
  const error = validateAgent(req.body)
  if (error) return res.status(400).json({ error })
  try {
    const { agent } = await changeAgents(current => {
      const agent = makeAgent(req.body)
      return { next: [...current, agent], agent }
    })
    res.status(201).json({ agent })
  } catch { res.status(500).json({ error: 'Could not save agent profile.' }) }
})
app.put('/api/agents/:id', async (req, res) => {
  const error = validateAgent(req.body)
  if (error) return res.status(400).json({ error })
  try {
    const result = await changeAgents(current => {
      if (!current.some(agent => agent.id === req.params.id)) return { status: 404, error: 'Agent not found.' }
      const agent = makeAgent(req.body, req.params.id)
      return { next: current.map(item => item.id === agent.id ? agent : item), agent }
    })
    if (result.error) return res.status(result.status).json({ error: result.error })
    res.json({ agent: result.agent })
  } catch { res.status(500).json({ error: 'Could not save agent profile.' }) }
})
app.delete('/api/agents/:id', async (req, res) => {
  try {
    const result = await changeAgents(current => {
      if (!current.some(agent => agent.id === req.params.id)) return { status: 404, error: 'Agent not found.' }
      if ([...active.values()].some(item => item.task.agentId === req.params.id)) return { status: 409, error: 'Agent is working. Stop or finish their task first.' }
      return { next: current.filter(agent => agent.id !== req.params.id) }
    })
    if (result.error) return res.status(result.status).json({ error: result.error })
    res.json({ ok: true })
  } catch { res.status(500).json({ error: 'Could not save agent profile.' }) }
})

// Roster changes only notify browsers. Task history is written separately.
function notifyState() {
  const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`
  for (const client of clients) {
    if (client.destroyed || client.writableEnded) { clients.delete(client); continue }
    if (client.writableLength > 1024 * 1024) { client.destroy(); clients.delete(client); continue }
    try { client.write(data) } catch { client.destroy(); clients.delete(client) }
  }
}

// Idle watchdog (phase 3a): a running task that produced no stdout JSON for
// longer than IDLE_WATCHDOG_MS only gets a warning event. It never changes
// the task status or the terminal outcome.
function checkIdleWatchdog() {
  const now = Date.now()
  for (const running of active.values()) {
    if (running.task.status !== 'running' || running.idleWarned) continue
    if (now - running.lastOutputAt > IDLE_WATCHDOG_MS) {
      running.idleWarned = true
      addEvent(running.task, 'No output for a long time; the provider may be waiting for input.', 'warning')
    }
  }
}
const idleWatchdog = setInterval(checkIdleWatchdog, 1000)
idleWatchdog.unref()
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`)
  clients.add(res)
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n')
  }, 20000)
  const cleanup = () => { clearInterval(heartbeat); clients.delete(res) }
  res.on('close', cleanup)
  res.on('error', cleanup)
})

const handoffSummary = task => shrink(task.prompt, 120)

// COLLABORATING has exactly one real trigger (phase 3a): a task dependency.
// When a prerequisite completes, both sides get a handoff event; the
// dependent task is then dispatched through the normal launch path.
function recordHandoff(prerequisite, dependent) {
  const fromName = prerequisite.agentName || prerequisite.agentId
  const toName = dependent.agentName || dependent.agentId
  addEvent(dependent, `Handoff from ${fromName}: ${handoffSummary(prerequisite)}`)
  addEvent(prerequisite, `Handed off to ${toName}: ${handoffSummary(dependent)}`)
}

// Add an event only when the previous one does not already say the same
// thing, so repeated sweeps cannot spam a waiting task's timeline.
function noteOnce(task, message, kind = 'info') {
  if (task.events.at(-1)?.message === message) return
  addEvent(task, message, kind)
}

// Try to launch one queued task whose prerequisite completed. Constraint
// misses only record an event and leave the task queued; the next finish (or
// restart) sweeps again. Returns true when the provider started.
async function dispatchQueued(dependent) {
  const prerequisite = tasks.find(item => item.id === dependent.dependsOn)
  if (!prerequisite || prerequisite.status !== 'completed') return false
  const agent = agents.find(item => item.id === dependent.agentId)
  if (!agent) {
    dependent.status = 'failed'; dependent.phase = 'idle'; dependent.finishedAt = stamp()
    dependent.failure = 'Agent no longer exists.'
    addEvent(dependent, dependent.failure, 'error')
    await persistHistory().catch(() => {})
    return false
  }
  const provider = providers.find(item => item.id === (dependent.provider || 'codex'))
  if (!provider || !provider.available) {
    noteOnce(dependent, `${provider?.name || dependent.provider || 'codex'} is not available; handoff waiting.`, 'warning')
    return false
  }
  let canonical
  try { canonical = realpathSync(dependent.workspace) }
  catch {
    dependent.status = 'failed'; dependent.phase = 'idle'; dependent.finishedAt = stamp()
    dependent.failure = 'Project folder is no longer accessible.'
    addEvent(dependent, dependent.failure, 'error')
    await persistHistory().catch(() => {})
    return false
  }
  if ([...active.values()].some(item => item.task.agentId === dependent.agentId)) {
    noteOnce(dependent, `${agent.name} is already working; handoff waiting.`, 'warning')
    return false
  }
  if ([...active.values()].some(item => foldersOverlap(canonical, item.canonical))) {
    noteOnce(dependent, 'Project folder is busy; handoff waiting.', 'warning')
    return false
  }
  dependent.status = 'running'; dependent.phase = 'thinking'; dependent.updatedAt = stamp()
  recordHandoff(prerequisite, dependent)
  return (await launchTask(dependent, agent, provider, canonical)) === 'launched'
}

// Retry every queued handoff whose prerequisite has resolved: dispatch when
// it completed, fail the dependent when it ended any other way. Runs after
// every task finish and once at startup.
async function sweepQueued() {
  let considered = false
  for (const dependent of tasks.filter(item => item.status === 'queued' && typeof item.dependsOn === 'string')) {
    const prerequisite = tasks.find(item => item.id === dependent.dependsOn)
    if (!prerequisite) continue
    considered = true
    if (prerequisite.status === 'completed') {
      await dispatchQueued(dependent)
    } else if (['failed', 'cancelled', 'interrupted'].includes(prerequisite.status)) {
      dependent.status = 'failed'; dependent.phase = 'idle'; dependent.finishedAt = stamp()
      dependent.failure = 'Prerequisite task did not complete.'
      addEvent(dependent, 'Prerequisite task did not complete; handoff cancelled.', 'error')
    }
  }
  if (considered) await persistHistory().catch(() => {})
}

app.post('/api/tasks', async (req, res) => {
  if (!historyReadable) return res.status(503).json({ error: 'Task history is unreadable. Preserve and repair the data file before launching tasks.' })
  if (!agentsReadable) return res.status(503).json({ error: 'Agent profiles are unreadable. Preserve and repair the data file before launching tasks.' })
  const { prompt, agentId, workspace, provider: requestedProvider = 'codex', dependsOn } = req.body || {}
  const provider = providers.find(item => item.id === requestedProvider)
  if (!provider) return res.status(400).json({ error: 'Motor de IA desconhecido.' })
  if (!provider.available) return res.status(503).json({ error: `${provider.name} não encontrado. Instale e autentique o CLI, depois reinicie o escritório.` })
  // An in-flight roster write must finish before resolving the selected agent.
  // Otherwise deletion could commit after this task reserves that same profile.
  await agentsPersistChain
  const agent = agents.find(item => item.id === agentId)
  if (!agent) return res.status(400).json({ error: 'Agente desconhecido.' })
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) return res.status(400).json({ error: 'Tarefa vazia ou extensa demais.' })
  if (typeof workspace !== 'string' || workspace.length > 1000 || workspace.includes('\0') || !isAbsolute(workspace)) return res.status(400).json({ error: 'Informe uma pasta de projeto com caminho absoluto.' })
  try {
    if (!statSync(workspace).isDirectory()) return res.status(400).json({ error: 'A pasta do projeto não é válida.' })
  } catch { return res.status(400).json({ error: 'Pasta do projeto não encontrada.' }) }
  let canonical
  try { canonical = realpathSync(workspace) }
  catch { return res.status(400).json({ error: 'Não foi possível acessar a pasta do projeto.' }) }
  // A dependency must name a real task in this repo's history; an unknown id
  // is rejected, never silently ignored. A prerequisite that already ended
  // without success can never unblock the dependent task.
  let prerequisite
  if (dependsOn !== undefined) {
    if (typeof dependsOn !== 'string' || !dependsOn) return res.status(400).json({ error: 'Prerequisite task is invalid.' })
    prerequisite = tasks.find(item => item.id === dependsOn)
    if (!prerequisite) return res.status(400).json({ error: 'Prerequisite task not found.' })
    if (['failed', 'cancelled', 'interrupted'].includes(prerequisite.status)) return res.status(400).json({ error: 'Prerequisite task did not complete.' })
  }
  // A task waiting on a running prerequisite is only recorded here; it is
  // dispatched by sweepQueued() when the prerequisite completes, so the
  // single-task-per-agent and folder-exclusion constraints are checked then,
  // not now.
  const queued = Boolean(prerequisite && prerequisite.status !== 'completed')
  if (!queued) {
    if ([...active.values()].some(a => a.task.agentId === agentId)) return res.status(409).json({ error: 'Esse agente já está trabalhando.' })
    if ([...active.values()].some(a => foldersOverlap(canonical, a.canonical))) return res.status(409).json({ error: 'Já existe uma tarefa trabalhando nessa pasta (ou numa pasta dentro dela). Aguarde ou escolha outro projeto para evitar conflitos.' })
  }

  const task = {
    id: randomUUID(), agentId, agentName: agent.name, provider: provider.id, prompt, workspace,
    status: queued ? 'queued' : 'running', phase: queued ? 'idle' : 'thinking',
    createdAt: stamp(), updatedAt: stamp(), finishedAt: null, lastMessage: '', events: [], threadId: null, usage: null,
    ...(prerequisite ? { dependsOn: prerequisite.id } : {}),
  }
  tasks.unshift(task)
  // Never evict a running or queued job when trimming history.
  const live = tasks.filter(item => item.status === 'running' || item.status === 'queued')
  tasks = [...live, ...tasks.filter(item => item.status !== 'running' && item.status !== 'queued').slice(0, Math.max(0, MAX_TASKS - live.length))]
  if (prerequisite) {
    if (queued) addEvent(task, `Waiting for ${prerequisite.agentName || prerequisite.agentId} to finish: ${shrink(prerequisite.prompt, 120)}`)
    else recordHandoff(prerequisite, task)
  } else {
    addEvent(task, `Tarefa enviada ao ${provider.name}.`)
  }
  if (queued) {
    try { await persistHistory() }
    catch {
      tasks = tasks.filter(item => item.id !== task.id)
      return res.status(500).json({ error: 'Could not save task history.' })
    }
    return res.status(201).json({ task })
  }
  const outcome = await launchTask(task, agent, provider, canonical)
  if (outcome === 'launched') return res.status(201).json({ task })
  if (outcome === 'stopped') return res.status(409).json({ error: 'Task stopped before launch.' })
  return res.status(500).json({ error: task.failure || 'Could not start task.' })
})

// Shared by POST /api/tasks and the handoff sweep: spawn the provider for an
// already-recorded running task and wire up its output/finish handling.
// Returns 'launched' when the provider started, 'stopped' when shutdown or a
// pre-launch cancel intervened, and 'failed' when durable storage or spawn
// failed. The task record already carries the outcome in the latter cases.
async function launchTask(task, agent, provider, canonical) {
  // Reserve the agent and canonical folder before awaiting durable storage.
  const running = { child: null, task, canonical, stopping: null, lastOutputAt: Date.now(), idleWarned: false }
  active.set(task.id, running)
  try { await persistHistory() }
  catch {
    active.delete(task.id)
    task.status = 'failed'; task.phase = 'idle'; task.finishedAt = stamp()
    task.failure = 'Could not save task history. No provider was launched.'
    addEvent(task, task.failure, 'error')
    return 'failed'
  }
  if (shuttingDown || task.cancelRequested) {
    active.delete(task.id)
    task.status = task.cancelRequested ? 'cancelled' : 'interrupted'
    task.phase = 'idle'; task.finishedAt = stamp()
    addEvent(task, 'Task stopped before launch.')
    await persistHistory().catch(() => {})
    return 'stopped'
  }

  const executionPrompt = composeAgentPrompt(agent, task.prompt)
  const { command, args, input } = providerCommand(provider, canonical, executionPrompt)
  let child
  try { child = spawn(command, args, { cwd: canonical, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch (error) {
    active.delete(task.id)
    task.status = 'failed'; task.phase = 'idle'; task.finishedAt = stamp()
    task.failure = shrink(error.message, 500); addEvent(task, task.failure, 'error')
    await persistHistory().catch(() => {})
    return 'failed'
  }
  running.child = child
  running.done = new Promise(resolve => { running.resolveDone = resolve })
  let stderr = ''
  const reader = jsonLines(data => {
    running.lastOutputAt = Date.now()
    running.idleWarned = false
    parseMessage(task, data, addEvent); notify()
  }, () => {
    task.failure = 'Provider output exceeded the supported record size.'
    addEvent(task, task.failure, 'error')
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => reader.push(chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-1200)
    // Weak approval-wait detection on stderr (see task-output.mjs): only
    // sets the flag, never a terminal state.
    if (!task.awaitingApproval && isApprovalWaitText(chunk)) {
      task.awaitingApproval = true
      addEvent(task, 'Possible approval wait detected in provider output (unconfirmed); handle it in the terminal.', 'warning')
    }
  })
  child.on('error', error => { task.failure = shrink(error.message, 400); addEvent(task, task.failure, 'error') })
  running.finish = async (code, signal) => {
    if (running.finalized) return
    reader.end()
    // Keep the workspace reserved until descendant termination finishes.
    if (running.stopping) {
      try { await running.stopping }
      catch (error) { task.failure = shrink(error.message, 500); return }
    }
    if (running.finalized) return
    active.delete(task.id)
    running.finalized = true
    task.exitCode = code; task.signal = signal || null
    task.status = task.cancelRequested ? 'cancelled' : shuttingDown ? 'interrupted'
      : code === 0 && !task.failure && task.outputComplete ? 'completed' : 'failed'
    task.phase = 'idle'; task.finishedAt = stamp()
    if (task.status === 'failed') task.failure ||= shrink(task.events.filter(e => e.kind === 'error').at(-1)?.message || stderr ||
      (code === 0 ? 'Provider exited without a completion event.' : `${provider.name} saiu com código ${code}.`), 500)
    addEvent(task, task.status === 'completed' ? 'Tarefa concluída.' : task.status === 'cancelled' ? 'Tarefa cancelada.'
      : task.status === 'interrupted' ? 'Task interrupted by office shutdown.' : `Falha: ${task.failure}`, task.status === 'completed' ? 'success' : 'error')
    await persistHistory().catch(() => {})
    // A finished task may unblock queued handoffs (or fail them, when this
    // task did not complete) and frees its agent/folder for a waiting one.
    void sweepQueued()
    running.resolveDone()
  }
  child.on('close', (code, signal) => {
    running.closed = { code, signal }
    void running.finish(code, signal)
  })
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE') { task.failure = shrink(error.message, 400); addEvent(task, task.failure, 'error') }
  })
  child.stdin.end(input)
  return 'launched'
}

app.post('/api/tasks/:id/cancel', async (req, res) => {
  const running = active.get(req.params.id)
  if (!running) return res.status(404).json({ error: 'Tarefa em execução não encontrada.' })
  if (!running.task.cancelRequested) { running.task.cancelRequested = true; addEvent(running.task, 'Cancelamento solicitado.') }
  try {
    running.stopping ||= terminateProcess(running.child)
    await running.stopping
    if (running.closed) await running.finish(running.closed.code, running.closed.signal)
    res.json({ ok: true })
  } catch (error) {
    running.stopping = null
    addEvent(running.task, shrink(error.message, 400), 'error')
    res.status(500).json({ error: 'Could not stop the provider. The workspace remains reserved.' })
  }
})

// Manual approval-wait flag (phase 3a): the primary BLOCKED mechanism, since
// no CLI emits a real approval event. Mirrors the cancel endpoint. Only a
// running task can be flagged; anything else is a 400.
app.post('/api/tasks/:id/blocked', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id)
  if (!task) return res.status(404).json({ error: 'Tarefa não encontrada.' })
  if (task.status !== 'running' || !active.has(task.id)) return res.status(400).json({ error: 'Only a running task can be marked as waiting for approval.' })
  if (!task.awaitingApproval) {
    task.awaitingApproval = true
    addEvent(task, 'Marked as waiting for approval; handle it in the terminal.', 'warning')
  }
  await persistHistory().catch(() => {})
  notifyState()
  res.json({ ok: true, task: visible(task) })
})

app.post('/api/tasks/:id/unblock', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id)
  if (!task) return res.status(404).json({ error: 'Tarefa não encontrada.' })
  if (task.status !== 'running' || !active.has(task.id)) return res.status(400).json({ error: 'Only a running task can be unmarked.' })
  if (task.awaitingApproval) {
    delete task.awaitingApproval
    addEvent(task, 'Approval wait cleared.')
  }
  await persistHistory().catch(() => {})
  notifyState()
  res.json({ ok: true, task: visible(task) })
})

await Promise.all([loadHistory(), loadAgents()])
// Dispatch any handoffs whose prerequisite already completed (e.g. while the
// office was down) and fail ones whose prerequisite ended otherwise.
void sweepQueued()
if (existsSync(join(ROOT, 'dist', 'index.html'))) {
  app.use(express.static(join(ROOT, 'dist')))
  app.get('/', (_req, res) => res.sendFile(join(ROOT, 'dist', 'index.html')))
}
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }))
app.use((error, _req, res, _next) => {
  if (res.headersSent) { res.destroy(); return }
  const status = error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500
  res.status(status).json({ error: status === 413 ? 'Request body is too large.' : status === 400 ? 'Invalid JSON body.' : 'Internal server error.' })
})
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Office API: http://127.0.0.1:${PORT}`)
  for (const provider of providers) console.log(`${provider.name}: ${provider.available ? 'detected' : 'not found'}`)
})

server.on('error', error => { console.error('Could not start Agent Office:', error.message); process.exitCode = 1 })
export const ready = new Promise(resolve => {
  server.once('listening', () => resolve(true))
  server.once('error', () => resolve(false))
})
let shutdownPromise
export function shutdown() {
  return shutdownPromise ||= (async () => {
    shuttingDown = true
    clearInterval(idleWatchdog)
    clearTimeout(persistTimer); persistTimer = undefined
    const closed = new Promise(resolve => server.close(resolve))
    const forceClose = setTimeout(() => server.closeAllConnections(), 3000)
    forceClose.unref()
    for (const client of clients) client.end()
    clients.clear()
    const results = await Promise.allSettled([...active.values()].map(async running => {
      if (!running.child) return
      running.stopping ||= terminateProcess(running.child)
      await running.stopping
      if (running.closed) await running.finish(running.closed.code, running.closed.signal)
      await running.done
    }))
    for (const result of results) if (result.status === 'rejected') { console.error(result.reason.message); process.exitCode = 1 }
    await agentsPersistChain
    if (historyReadable) await persistHistory().catch(() => { process.exitCode = 1 })
    await closed
    clearTimeout(forceClose)
  })()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  void shutdown().catch(error => { console.error('Office shutdown failed:', error.message); process.exitCode = 1 })
})
// The IDE owns a private IPC channel. Let it stop the office gracefully on
// Windows too, before using forced process-tree termination as a fallback.
if (process.channel) {
  process.on('message', message => {
    if (message?.type === 'agent-office:shutdown' && message.instanceId === INSTANCE_ID) {
      void shutdown().then(() => { if (process.connected) process.disconnect() }).catch(error => console.error(error.message))
    }
  })
  process.on('disconnect', () => { void shutdown().catch(error => console.error(error.message)) })
}
