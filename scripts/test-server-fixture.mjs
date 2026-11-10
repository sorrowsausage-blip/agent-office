// Shared isolated-API fixture for the server behaviour tests.
//
// One disposable server per test: a temp data dir, a temp workspace, and
// fake provider CLIs (CODEX_BIN / CLAUDE_BIN / GEMINI_BIN) so no installed
// AI CLI is ever launched. The fake CLI picks its behaviour from a marker
// in the prompt, so one server can run every scenario:
//   [hold]            stay alive, emitting progress (cancellable)
//   [silent]          one message, then no output while still running
//   [delayed]         progress twice, then complete after ~900 ms
//   [fail]            structured provider failure
//   [slow-fail]       progress twice, then the same failure after ~900 ms
//   [stderr-approval] write an approval keyword to stderr, then complete
//   [coding]          also emit one provider-native coding record up
//   front, so the task really flips phase thinking -> coding (and the
//   status PLANNING -> WORKING). Without it the fake only ever emits
//   agent_message progress, which task-output.mjs deliberately does not
//   treat as coding — so no fixture task could ever read WORKING. The
//   record is the same shape a real CLI emits when it runs a command
//   (codex command_execution, claude tool_use, gemini tool_use).
//   (no marker)       complete promptly
// Extracted verbatim from scripts/test-task-handoff.mjs (phase 6) so the
// linkage tests reuse the same harness instead of copying ~100 lines.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const sleep = ms => new Promise(done => setTimeout(done, ms))

export async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await sleep(30) }
  throw new Error('Timed out waiting for isolated fixture')
}

// Every subprocess in this harness is either the local API or disposable Node
// code. Explicit overrides prevent any installed AI CLI from being launched.
// The fake CLI picks its behaviour from a marker in the prompt, so one
// server can run every scenario in this file:
//   [hold]            stay alive, emitting progress (cancellable)
//   [silent]          one message, then no output while still running
//   [delayed]         progress twice, then complete after ~900 ms
//   [fail]            structured provider failure
//   [slow-fail]       progress twice, then the same failure after ~900 ms
//                     (the plain [fail] lands ~50 ms after launch, too fast
//                     to observe the agent sitting down first)
//   [stderr-approval] write an approval keyword to stderr, then complete
//   [coding]          also emit one provider-native coding record up
//   front, so the task really flips phase thinking -> coding (and the
//   status PLANNING -> WORKING). Without it the fake only ever emits
//   agent_message progress, which task-output.mjs deliberately does not
//   treat as coding — so no fixture task could ever read WORKING. The
//   record is the same shape a real CLI emits when it runs a command
//   (codex command_execution, claude tool_use, gemini tool_use).
//   (no marker)       complete promptly
export async function createHandoffFixture(t, files = {}, extraEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-office-handoff-'))
  const data = join(root, 'data'), workspace = join(root, 'project')
  await mkdir(data); await mkdir(workspace)
  // `files` may be an object of name -> contents, or a function of the
  // workspace path (for seeding a tasks.json that must name a real folder).
  const resolvedFiles = typeof files === 'function' ? files(workspace) : files
  for (const [name, contents] of Object.entries(resolvedFiles)) await writeFile(join(data, name), contents)
  const fake = join(root, 'fake.cjs'), capture = join(root, 'capture.json')
  await writeFile(fake, `
const fs = require('node:fs')
const args = process.argv.slice(2)
const provider = args.includes('exec') ? 'codex' : args.includes('--print') ? 'claude' : 'gemini'
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', value => prompt += value)
process.stdin.on('end', () => {
  if (provider === 'gemini') prompt = args[args.indexOf('-p') + 1] || prompt
  fs.writeFileSync(process.env.AO_CAPTURE, JSON.stringify({ args, prompt, cwd: process.cwd(), pid: process.pid }))
  const result = provider === 'codex' ? { type: 'turn.completed', usage: { input_tokens: 2 } }
    : provider === 'claude' ? { type: 'result', status: 'success', subtype: 'success' }
    : { type: 'result', status: 'success', subtype: 'success' }
  const progress = count => ({ type: 'item.completed', item: { type: 'agent_message', text: 'progress ' + count } })
  const coding = () => provider === 'codex' ? { type: 'item.completed', item: { type: 'command_execution', command: 'fixture coding' } }
    : provider === 'claude' ? { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }
    : { type: 'tool_use', tool_name: 'run_shell_command' }
  if (prompt.includes('[coding]')) emit(coding())
  if (prompt.includes('[hold]')) {
    process.on('SIGTERM', () => {})
    let count = 0
    setInterval(() => emit(progress(++count)), 40)
    return
  }
  if (prompt.includes('[silent]')) {
    emit(progress(1))
    setInterval(() => {}, 1000)
    return
  }
  if (prompt.includes('[stderr-approval]')) process.stderr.write('Awaiting approval to proceed with the change.\\n')
  if (prompt.includes('[fail]')) {
    emit(provider === 'codex' ? { type: 'turn.failed', error: { message: 'fixture failed' } }
      : provider === 'claude' ? { type: 'result', subtype: 'error_max_turns', errors: ['fixture failed'] }
      : { type: 'result', status: 'error', error: { message: 'fixture failed' } })
    return
  }
  if (prompt.includes('[slow-fail]')) {
    let count = 0
    const timer = setInterval(() => {
      count++
      if (count < 3) { emit(progress(count)); return }
      clearInterval(timer)
      emit(provider === 'codex' ? { type: 'turn.failed', error: { message: 'fixture failed' } }
        : provider === 'claude' ? { type: 'result', subtype: 'error_max_turns', errors: ['fixture failed'] }
        : { type: 'result', status: 'error', error: { message: 'fixture failed' } })
      setTimeout(() => process.exit(0), 50)
    }, 300)
    return
  }
  if (prompt.includes('[delayed]')) {
    let count = 0
    const timer = setInterval(() => {
      count++
      if (count < 3) { emit(progress(count)); return }
      clearInterval(timer)
      emit(result)
      setTimeout(() => process.exit(0), 50)
    }, 300)
    return
  }
  emit({ type: 'error', message: 'recoverable warning' })
  process.stdout.write(JSON.stringify(result)) // Intentionally no final newline.
})
`)
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; await new Promise(done => listener.close(done))
  const wrapper = join(root, 'server-wrapper.mjs')
  await writeFile(wrapper, `import { ready } from ${JSON.stringify(pathToFileURL(resolve('server/index.mjs')).href)}; await ready;`)
  let server
  const base = `http://127.0.0.1:${port}`
  const start = async () => {
    server = spawn(process.execPath, [wrapper], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
      ...process.env, PORT: String(port), AGENT_OFFICE_DATA_DIR: data, AGENT_OFFICE_WORKSPACE: workspace,
      AGENT_OFFICE_INSTANCE_ID: `fixture-${port}`,
      CODEX_BIN: fake, CLAUDE_BIN: fake, GEMINI_BIN: fake, AO_CAPTURE: capture, ...extraEnv,
    } })
    let errors = ''
    server.stderr.on('data', chunk => errors += chunk)
    await until(async () => {
      if (server.exitCode !== null) throw new Error('Fixture API exited: ' + errors)
      try { return (await fetch(base + '/api/state', { signal: AbortSignal.timeout(200) })).ok } catch { return false }
    })
  }
  const stop = async () => {
    if (!server || server.exitCode !== null) return
    const exited = once(server, 'exit')
    server.send({ type: 'agent-office:shutdown', instanceId: `fixture-${port}` })
    await Promise.race([exited, sleep(5000).then(() => { throw new Error('Fixture shutdown timed out') })])
  }
  t.after(async () => {
    await stop()
    assert.ok(root.startsWith(join(tmpdir(), 'agent-office-handoff-')))
    await rm(root, { recursive: true, force: true })
  })
  await start()
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4000) })
    return { status: response.status, body: await response.json() }
  }
  const launch = async (changes = {}) => request('/api/tasks', 'POST', { provider: 'codex', agentId: 'atlas', workspace, prompt: 'Safe fixture task', ...changes })
  const task = async id => (await request('/api/state')).body.tasks.find(item => item.id === id)
  return { root, data, workspace, capture, base, request, launch, task, start, stop }
}

