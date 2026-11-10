import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHandoffFixture as fixture, sleep, until } from './test-server-fixture.mjs'

test('dependsOn pointing at an unknown task is rejected with 400', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const result = await f.launch({ dependsOn: 'does-not-exist' })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /Prerequisite task not found/)
  assert.equal((await f.request('/api/state')).body.tasks.length, 0)
  await assert.rejects(readFile(f.capture), { code: 'ENOENT' })
})

test('dependsOn a failed prerequisite is rejected with 400', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const failed = await f.launch({ prompt: 'Doomed task [fail]' })
  assert.equal(failed.status, 201)
  const done = await until(async () => { const item = await f.task(failed.body.task.id); return item.status !== 'running' && item })
  assert.equal(done.status, 'failed')
  const result = await f.launch({ agentId: 'nova', dependsOn: done.id })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /did not complete/)
})

test('dependsOn a completed task launches immediately and records a handoff on both sides', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const first = await f.launch({ prompt: 'Plan the dashboard' })
  assert.equal(first.status, 201)
  const prereq = await until(async () => { const item = await f.task(first.body.task.id); return item.status !== 'running' && item })
  assert.equal(prereq.status, 'completed')
  const second = await f.launch({ agentId: 'nova', prompt: 'Build the dashboard', dependsOn: prereq.id })
  assert.equal(second.status, 201)
  assert.equal(second.body.task.status, 'running', 'A completed prerequisite must not queue the dependent')
  assert.equal(second.body.task.dependsOn, prereq.id)
  const dependent = await until(async () => { const item = await f.task(second.body.task.id); return item.status !== 'running' && item })
  assert.equal(dependent.status, 'completed')
  assert.ok(dependent.events.some(event => event.message.startsWith('Handoff from Atlas:')), 'Dependent must record the handoff')
  const prereqAfter = await f.task(prereq.id)
  assert.ok(prereqAfter.events.some(event => event.message.startsWith('Handed off to Nova:')), 'Prerequisite must record the handoff')
})

test('a queued dependent is dispatched when its prerequisite completes', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const first = await f.launch({ prompt: 'Plan the dashboard [delayed]' })
  assert.equal(first.status, 201)
  const prereqId = first.body.task.id
  const second = await f.launch({ agentId: 'nova', prompt: 'Dependent follow-up work', dependsOn: prereqId })
  assert.equal(second.status, 201)
  assert.equal(second.body.task.status, 'queued')
  assert.equal(second.body.task.dependsOn, prereqId)
  const queued = await f.task(second.body.task.id)
  assert.ok(queued.events.some(event => /Waiting for Atlas/.test(event.message)))
  const prereq = await until(async () => { const item = await f.task(prereqId); return item.status !== 'running' && item })
  assert.equal(prereq.status, 'completed')
  const dependent = await until(async () => { const item = await f.task(second.body.task.id); return item.status === 'completed' && item })
  assert.equal(dependent.status, 'completed')
  assert.ok(dependent.events.some(event => event.message.startsWith('Handoff from Atlas:')))
  const prereqAfter = await f.task(prereqId)
  assert.ok(prereqAfter.events.some(event => event.message.startsWith('Handed off to Nova:')))
  const capture = JSON.parse(await readFile(f.capture, 'utf8'))
  assert.ok(capture.prompt.includes('Dependent follow-up work'), 'The dependent task must really have been executed')
})

test('a busy agent only defers the handoff until its task finishes', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const blocker = await f.launch({ agentId: 'nova', prompt: 'Long Nova work [hold]' })
  assert.equal(blocker.status, 201)
  // The prerequisite needs its own folder: same-folder tasks are mutually
  // exclusive, so sharing the blocker's workspace would 409 the launch.
  const workspace2 = join(f.root, 'project2'); await mkdir(workspace2)
  const first = await f.launch({ workspace: workspace2, prompt: 'Plan the dashboard [delayed]' })
  assert.equal(first.status, 201)
  const second = await f.launch({ agentId: 'nova', workspace: workspace2, prompt: 'Dependent follow-up work', dependsOn: first.body.task.id })
  assert.equal(second.status, 201)
  assert.equal(second.body.task.status, 'queued')
  const prereq = await until(async () => { const item = await f.task(first.body.task.id); return item.status !== 'running' && item })
  assert.equal(prereq.status, 'completed')
  const stillQueued = await f.task(second.body.task.id)
  assert.equal(stillQueued.status, 'queued', 'A busy agent must not be force-started')
  assert.ok(stillQueued.events.some(event => /already working/.test(event.message)))
  const cancel = await f.request(`/api/tasks/${blocker.body.task.id}/cancel`, 'POST')
  assert.equal(cancel.status, 200)
  const blocked = await until(async () => { const item = await f.task(blocker.body.task.id); return item.status !== 'running' && item })
  assert.equal(blocked.status, 'cancelled')
  const dependent = await until(async () => { const item = await f.task(second.body.task.id); return item.status === 'completed' && item })
  assert.ok(dependent.events.some(event => event.message.startsWith('Handoff from Atlas:')))
})

test('blocked/unblock only apply to running tasks and survive a restart', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const launched = await f.launch({ prompt: 'Long Atlas work [hold]' })
  assert.equal(launched.status, 201)
  const id = launched.body.task.id
  assert.equal((await f.request(`/api/tasks/nope/blocked`, 'POST')).status, 404)
  const blocked = await f.request(`/api/tasks/${id}/blocked`, 'POST')
  assert.equal(blocked.status, 200)
  assert.equal(blocked.body.task.awaitingApproval, true)
  assert.equal((await f.task(id)).awaitingApproval, true)
  await until(async () => (await readFile(join(f.data, 'tasks.json'), 'utf8')).includes('"awaitingApproval": true'))
  assert.equal((await f.request(`/api/tasks/${id}/blocked`, 'POST')).status, 200, 'Blocking twice must stay idempotent')
  const unblocked = await f.request(`/api/tasks/${id}/unblock`, 'POST')
  assert.equal(unblocked.status, 200)
  assert.equal(unblocked.body.task.awaitingApproval, undefined)
  assert.equal((await f.task(id)).awaitingApproval, undefined)
  await f.request(`/api/tasks/${id}/blocked`, 'POST')
  await f.stop(); await f.start()
  const reloaded = await f.task(id)
  assert.equal(reloaded.awaitingApproval, true, 'The flag must survive a restart')
  assert.equal(reloaded.status, 'interrupted', 'A running task is interrupted by shutdown')
  assert.equal((await f.request(`/api/tasks/${id}/blocked`, 'POST')).status, 400, 'An interrupted task can no longer be flagged')
  const finished = await f.launch({ prompt: 'Quick work' })
  const done = await until(async () => { const item = await f.task(finished.body.task.id); return item.status !== 'running' && item })
  assert.equal(done.status, 'completed')
  assert.equal((await f.request(`/api/tasks/${done.id}/blocked`, 'POST')).status, 400)
  assert.equal((await f.request(`/api/tasks/${done.id}/unblock`, 'POST')).status, 400)
})

test('history whitelist accepts the new fields and the startup sweep dispatches a seeded handoff', { timeout: 60000 }, async t => {
  const stamp = new Date().toISOString()
  const prereqId = 'seeded-prereq', dependentId = 'seeded-dependent'
  const f = await fixture(t, workspace => ({
    'tasks.json': JSON.stringify([
      { id: prereqId, agentId: 'atlas', agentName: 'Atlas', provider: 'codex', prompt: 'Seeded plan', workspace, status: 'completed', phase: 'idle', createdAt: stamp, updatedAt: stamp, finishedAt: stamp, lastMessage: '', threadId: null, events: [{ id: 'e1', at: stamp, kind: 'success', message: 'Seeded plan done.' }] },
      { id: dependentId, agentId: 'nova', agentName: 'Nova', provider: 'codex', prompt: 'Seeded follow-up', workspace, status: 'queued', phase: 'idle', createdAt: stamp, updatedAt: stamp, finishedAt: null, lastMessage: '', threadId: null, awaitingApproval: false, dependsOn: prereqId, events: [{ id: 'e2', at: stamp, kind: 'info', message: 'Waiting for Atlas to finish.' }] },
    ]),
  }))
  const state = await f.request('/api/state')
  assert.equal(state.body.storage.historyReadable, true, 'Seeded history with the new fields must load')
  assert.equal(state.body.tasks.length, 2)
  const dependent = await until(async () => { const item = await f.task(dependentId); return item.status === 'completed' && item })
  assert.equal(dependent.status, 'completed', 'The startup sweep must dispatch a queued task whose prerequisite completed')
  assert.equal(dependent.dependsOn, prereqId)
  assert.ok(dependent.events.some(event => event.message.startsWith('Handoff from Atlas:')))
  const prereq = await f.task(prereqId)
  assert.ok(prereq.events.some(event => event.message.startsWith('Handed off to Nova:')))
})

test('idle watchdog warns without changing the terminal outcome', { timeout: 60000 }, async t => {
  const f = await fixture(t, {}, { AGENT_OFFICE_IDLE_WATCHDOG_MS: '400' })
  const launched = await f.launch({ prompt: 'Quiet work [silent]' })
  assert.equal(launched.status, 201)
  const id = launched.body.task.id
  const warned = await until(async () => {
    const item = await f.task(id)
    return item.status === 'running' && item.events.some(event => event.kind === 'warning' && /waiting for input/.test(event.message)) && item
  }, 8000)
  assert.equal(warned.status, 'running', 'The watchdog must not change the task status')
  assert.equal(warned.failure, undefined, 'The watchdog must not fail the task')
  const cancel = await f.request(`/api/tasks/${id}/cancel`, 'POST')
  assert.equal(cancel.status, 200)
  const cancelled = await until(async () => { const item = await f.task(id); return item.status !== 'running' && item })
  assert.equal(cancelled.status, 'cancelled')
})

test('stderr approval keywords only set the flag and never fail the task', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const launched = await f.launch({ prompt: 'Work needing a nod [stderr-approval]' })
  assert.equal(launched.status, 201)
  const done = await until(async () => { const item = await f.task(launched.body.task.id); return item.status !== 'running' && item })
  assert.equal(done.status, 'completed', 'A suspected wait must not become a terminal failure')
  assert.equal(done.awaitingApproval, true)
})

test('a queued task can be cancelled and is never dispatched afterwards', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const first = await f.launch({ prompt: 'Plan the dashboard [delayed]' })
  assert.equal(first.status, 201)
  const prereqId = first.body.task.id
  const second = await f.launch({ agentId: 'nova', prompt: 'Dependent follow-up work', dependsOn: prereqId })
  assert.equal(second.status, 201)
  assert.equal(second.body.task.status, 'queued')
  const cancel = await f.request(`/api/tasks/${second.body.task.id}/cancel`, 'POST')
  assert.equal(cancel.status, 200)
  assert.equal(cancel.body.task.status, 'cancelled')
  assert.ok(cancel.body.task.finishedAt, 'a cancelled queued task must record when it ended')
  assert.equal(cancel.body.task.phase, 'idle')
  const cancelled = await f.task(second.body.task.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.ok(cancelled.events.some(event => /cancelled/i.test(event.message)), 'the cancellation must be recorded as an event')
  await until(async () => (await readFile(join(f.data, 'tasks.json'), 'utf8')).includes('"status": "cancelled"'))
  // The prerequisite still completes, but the sweep must not revive the
  // cancelled dependent — and the provider must never have run it.
  const prereq = await until(async () => { const item = await f.task(prereqId); return item.status !== 'running' && item })
  assert.equal(prereq.status, 'completed')
  await sleep(500)
  assert.equal((await f.task(second.body.task.id)).status, 'cancelled', 'sweepQueued must not dispatch a cancelled queued task')
  const capture = JSON.parse(await readFile(f.capture, 'utf8'))
  assert.ok(!capture.prompt.includes('Dependent follow-up work'), 'the cancelled dependent must never have been executed')
  assert.equal((await f.request(`/api/tasks/${second.body.task.id}/cancel`, 'POST')).status, 404, 'cancelling twice must not resurrect the task')
})

test('cancelling an unknown or finished task still returns 404', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/tasks/does-not-exist/cancel', 'POST')).status, 404)
  const finished = await f.launch({ prompt: 'Quick work' })
  const done = await until(async () => { const item = await f.task(finished.body.task.id); return item.status !== 'running' && item })
  assert.equal(done.status, 'completed')
  assert.equal((await f.request(`/api/tasks/${done.id}/cancel`, 'POST')).status, 404, 'a completed task is not running or queued')
})
