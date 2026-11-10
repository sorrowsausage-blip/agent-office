export const shrink = (value, max = 190) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value : ''

// Weak approval-wait detection (phase 3a). The three CLIs are launched with
// approval prompts disabled (Claude `--permission-prompts none`, Gemini
// `--approval-mode auto_edit`, Codex `-s workspace-write`; see
// docs/LIVING-OFFICE-PLAN.md §4), so no CLI currently emits a real approval
// event and this will rarely fire. It only ever sets task.awaitingApproval
// and adds a warning event; it never changes the task status or terminal
// outcome. Only structured fields are scanned, never free agent text, to
// keep false positives low.
const APPROVAL_WAIT = /approval|permission|awaiting|confirm/i
const APPROVAL_WAIT_TYPES = new Set(['permission_request', 'approval_request', 'awaiting_input', 'awaiting_approval', 'confirmation_required'])
export function isApprovalWaitText(value) {
  return APPROVAL_WAIT.test(String(value ?? ''))
}
function detectApprovalWait(task, data, addEvent) {
  if (task.awaitingApproval) return
  const typeHit = APPROVAL_WAIT_TYPES.has(data.type) ||
    (typeof data.subtype === 'string' && APPROVAL_WAIT_TYPES.has(data.subtype))
  const textHit = [data.subtype, data.message, data.error?.message]
    .some(value => typeof value === 'string' && APPROVAL_WAIT.test(value))
  if (!typeHit && !textHit) return
  task.awaitingApproval = true
  addEvent(task, 'Possible approval wait detected in provider output (unconfirmed); handle it in the terminal.', 'warning')
}

export function parseMessage(task, data, addEvent) {
  if (!object(data)) return
  const message = value => { if (text(value)) task.lastMessage = shrink(value, 500) }
  const failure = value => { task.failure = shrink(value, 500); addEvent(task, task.failure, 'error') }
  if (task.provider === 'claude') {
    detectApprovalWait(task, data, addEvent)
    if (data.type === 'system' && text(data.session_id)) task.threadId = data.session_id
    if (data.type === 'assistant') {
      for (const block of Array.isArray(data.message?.content) ? data.message.content : []) {
        if (!object(block)) continue
        if (block.type === 'tool_use' && text(block.name)) {
          task.phase = /WebSearch|WebFetch/i.test(block.name) ? 'researching' : 'coding'
          addEvent(task, `Claude usou ${shrink(block.name)}.`)
        } else if (block.type === 'text' && text(block.text)) {
          message(block.text); addEvent(task, 'Claude respondeu: ' + shrink(block.text, 140))
        }
      }
    }
    if (data.type === 'result') {
      message(data.result)
      if (object(data.usage)) task.usage = data.usage
      if (data.is_error || (text(data.subtype) && data.subtype !== 'success')) {
        failure(text(data.result) || (Array.isArray(data.errors) ? data.errors.filter(item => text(item)).join('; ') : '') || 'Claude Code relatou erro.')
      }
      task.phase = 'finishing'; task.outputComplete = true
    }
    return
  }
  if (task.provider === 'gemini') {
    detectApprovalWait(task, data, addEvent)
    if (data.type === 'init' && text(data.session_id)) task.threadId = data.session_id
    if (data.type === 'tool_use' && text(data.tool_name)) {
      task.phase = /search|web/i.test(data.tool_name) ? 'researching' : 'coding'
      addEvent(task, `Gemini usou ${shrink(data.tool_name)}.`)
    }
    if (data.type === 'message' && data.role === 'assistant' && text(data.content)) {
      // Streaming Gemini messages are chunks, not complete answers.
      task.lastMessage = shrink(data.delta ? (task.lastMessage || '') + data.content : data.content, 500)
      addEvent(task, 'Gemini respondeu: ' + shrink(data.content, 140))
    }
    if (data.type === 'error') addEvent(task, shrink(data.message || 'Gemini CLI relatou erro.', 500), 'error')
    if (data.type === 'result') {
      message(data.response)
      if (object(data.stats)) task.usage = data.stats
      if (data.status === 'error' || data.error) failure(text(data.error?.message) || text(data.error) || 'Gemini CLI falhou.')
      task.phase = 'finishing'; task.outputComplete = true
    }
    return
  }
  // Default branch: Codex provider records.
  detectApprovalWait(task, data, addEvent)
  if (data.type === 'thread.started' && text(data.thread_id)) task.threadId = data.thread_id
  else if (data.type === 'turn.started') { task.phase = 'thinking'; addEvent(task, 'Codex iniciou a execução.') }
  else if (['item.started', 'item.updated', 'item.completed'].includes(data.type)) {
    const item = object(data.item) ? data.item : {}
    const verb = data.type === 'item.started' ? 'Iniciando' : data.type === 'item.completed' ? 'Concluiu' : 'Atualizando'
    if (item.type === 'command_execution') {
      task.phase = 'coding'
      if (data.type !== 'item.updated') addEvent(task, `${verb} comando: ${shrink(item.command)}`)
    } else if (item.type === 'file_change') {
      task.phase = 'coding'
      if (data.type !== 'item.updated') addEvent(task, `${verb} alteração de arquivos.`)
    } else if (item.type === 'agent_message' && data.type === 'item.completed') {
      message(item.text); addEvent(task, 'Agente respondeu: ' + shrink(item.text, 140))
    } else if (item.type === 'web_search' && data.type !== 'item.updated') {
      task.phase = 'researching'; addEvent(task, `${verb} pesquisa na web.`)
    } else if (item.type === 'reasoning' && data.type === 'item.started') task.phase = 'thinking'
  } else if (data.type === 'turn.completed') {
    task.usage = object(data.usage) ? data.usage : null
    task.phase = 'finishing'; task.outputComplete = true
  } else if (data.type === 'turn.failed') {
    failure(text(data.error?.message) || text(data.message) || 'Codex não concluiu a tarefa.')
  } else if (data.type === 'error') {
    addEvent(task, shrink(data.error?.message || data.message || 'Problema temporário no Codex.', 500), 'error')
  }
}

export function jsonLines(onMessage, onOversize = () => {}, max = 1024 * 1024) {
  let buffer = '', dropping = false
  const emit = line => { try { onMessage(JSON.parse(line)) } catch { /* Non-JSON CLI diagnostics. */ } }
  return {
    push(chunk) {
      // Bound individual records, rather than discarding earlier valid records
      // whenever Node happens to deliver a large chunk.
      for (const part of chunk.split(/(?<=\n)/)) {
        const ends = part.endsWith('\n')
        if (!dropping) {
          if (buffer.length + part.length > max) { dropping = true; buffer = ''; onOversize() }
          else buffer += part
        }
        if (ends) { if (!dropping) emit(buffer.trim()); buffer = ''; dropping = false }
      }
    },
    end() { if (buffer.trim() && !dropping) emit(buffer.trim()); buffer = ''; dropping = false },
  }
}
