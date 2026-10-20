/**
 * dsh-telegram-notify — one-way Telegram notifications for DeepSeek Harness.
 *
 * The plugin listens to the durable session event stream and pushes a short
 * Telegram message when:
 *
 *   - a turn completes, fails, or is cancelled;
 *   - the model asks a question and the turn waits for the human;
 *   - `exit_plan_mode` presents a plan for approval;
 *   - an approval request waits for the human (auto-decided asks are skipped).
 *
 * It never reads Telegram updates, so the bot stays send-only. Sends are
 * fire-and-forget: a Telegram outage can never fail or delay an agent turn.
 *
 * @module dsh-telegram-notify
 */

import { basename } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Plugin name; also the loader row id and logger name. */
export const name = 'telegram-notify'

/** Credential resolution is the only service dependency. */
export const inject = ['credentials']

const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'
const DEFAULT_API_BASE = 'https://api.telegram.org'
/** Telegram rejects sendMessage text above 4096 characters. */
const MAX_MESSAGE = 4096
/** Delay before a question notification, so an instantly-failing tool call is not announced. */
const QUESTION_SETTLE_MS = 400
/** Delay before an approval notification, so policy-decided asks (never/always) are not announced. */
const APPROVAL_SETTLE_MS = 400
const USER_SNIPPET = 500
const ASSISTANT_SNIPPET = 900
const DETAIL_SNIPPET = 1500
const REASON_SNIPPET = 400

export const Config = z.object({
  chatId: z
    .union([z.string(), z.number()])
    .default('')
    .description('Telegram chat id that receives the notifications. Quote it when it starts with -.'),
  tokenRef: z
    .string()
    .role('credential-ref')
    .default(DEFAULT_TOKEN_REF)
    .description('Credential reference holding the Telegram bot token.'),
  token: z
    .string()
    .role('secret')
    .description('Literal bot token. Prefer tokenRef; use this only for one-off local runs.'),
  apiBase: z.string().default(DEFAULT_API_BASE).description('Bot API base URL. Change only for a local Bot API server.'),
  silent: z.boolean().default(false).description('Send messages without a notification sound.'),
  notifyTurnComplete: z.boolean().default(true).description('Notify when a turn completes.'),
  notifyTurnError: z.boolean().default(true).description('Notify on turn errors, blocked turns, and max-token stops.'),
  notifyTurnAborted: z.boolean().default(false).description('Notify when a turn is cancelled.'),
  notifyQuestions: z.boolean().default(true).description('Notify when the agent is waiting for an answer.'),
  notifyPlanReviews: z.boolean().default(true).description('Notify when a plan is waiting for approval.'),
  notifyApprovals: z.boolean().default(true).description('Notify when a tool approval is waiting for the human.'),
})

// ───────────────────────────── configuration ─────────────────────────────

function normalizeApiBase(value) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_API_BASE
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return raw.replace(/\/+$/, '')
}

/**
 * Normalize user config into the shape the handlers read. Kept separate from
 * the schemastery schema because tests and direct mounts may call `apply`
 * with a plain object.
 * @param {Record<string, unknown> | undefined} raw - user configuration.
 * @returns resolved settings, or `undefined` when a value is unusable.
 */
export function resolveSettings(raw = {}) {
  const apiBase = normalizeApiBase(raw.apiBase)
  if (apiBase === undefined) return undefined
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  const tokenRef =
    typeof raw.tokenRef === 'string' && raw.tokenRef.trim() !== '' ? raw.tokenRef.trim() : DEFAULT_TOKEN_REF
  if (token === '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenRef)) return undefined
  return {
    chatId: String(raw.chatId ?? '').trim(),
    token,
    tokenRef,
    apiBase,
    silent: raw.silent === true,
    notifyTurnComplete: raw.notifyTurnComplete !== false,
    notifyTurnError: raw.notifyTurnError !== false,
    notifyTurnAborted: raw.notifyTurnAborted === true,
    notifyQuestions: raw.notifyQuestions !== false,
    notifyPlanReviews: raw.notifyPlanReviews !== false,
    notifyApprovals: raw.notifyApprovals !== false,
  }
}

// ───────────────────────────── text helpers ─────────────────────────────

/** Concatenate text blocks from a DSH message. */
export function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text += (text === '' ? '' : '\n') + block.text
    }
  }
  return text.trim()
}

/** Collapse a multi-line value into a compact one-line snippet. */
export function snippet(value, limit = USER_SNIPPET) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/** Clip a value while preserving newlines, for plan and question detail. */
export function clip(value, limit = DETAIL_SNIPPET) {
  const text = String(value ?? '').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function finalize(lines) {
  const text = lines.filter((line) => typeof line === 'string' && line !== '').join('\n')
  if (text.length <= MAX_MESSAGE) return text
  return `${text.slice(0, MAX_MESSAGE - 1)}…`
}

function workspaceOf(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return 'DSH'
  const leaf = basename(cwd)
  return leaf === '' ? cwd : leaf
}

function scopeLine(session, state) {
  const workspace = workspaceOf(session)
  const title = typeof state?.title === 'string' ? state.title.trim() : ''
  return `📁 ${workspace}${title !== '' && title !== workspace ? ` — ${title}` : ''}`
}

function lastUserLine(state) {
  const user = snippet(state?.user)
  return user === '' ? '' : `👤 ${user}`
}

function isRootSession(session) {
  const header = session?.header
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return false
  return (header.delegationDepth ?? 0) === 0
}

// ───────────────────────────── formatters ─────────────────────────────

/** Format a completed turn. */
export function formatCompleted(session, state) {
  const assistant = snippet(state?.assistant, ASSISTANT_SNIPPET)
  return finalize([
    '✅ Turn complete',
    scopeLine(session, state),
    lastUserLine(state),
    assistant === '' ? '' : `🤖 ${assistant}`,
  ])
}

/** Format a failed turn. */
export function formatError(session, state, error) {
  const message = snippet(error?.message ?? 'The turn failed.', REASON_SNIPPET)
  const code = typeof error?.code === 'string' && error.code !== '' ? ` (${error.code})` : ''
  const status = typeof error?.status === 'number' ? ` · HTTP ${error.status}` : ''
  return finalize([
    '❌ Turn failed',
    scopeLine(session, state),
    lastUserLine(state),
    `⚠️ ${message}${code}${status}`,
  ])
}

/** Format a turn that stopped without an error (max tokens or blocked). */
export function formatWarning(session, state, kind) {
  const reason =
    kind === 'max-tokens'
      ? 'the output-token limit was reached'
      : kind === 'blocked'
        ? 'the turn was blocked'
        : `the turn ended (${String(kind)})`
  return finalize(['⚠️ Turn stopped', scopeLine(session, state), lastUserLine(state), `Reason: ${reason}`])
}

/** Format a cancelled turn. */
export function formatAborted(session, state, reason) {
  const cause = reason?.reason?.kind
  return finalize([
    '⏹ Turn cancelled',
    scopeLine(session, state),
    lastUserLine(state),
    typeof cause === 'string' ? `Cause: ${cause}` : '',
  ])
}

function isPlanQuestion(question) {
  return question?.intent?.kind === 'plan-review'
}

function optionsBlock(question) {
  const options = Array.isArray(question?.options) ? question.options : []
  if (options.length === 0) return []
  return ['Options:', ...options.map((option) => `• ${snippet(option?.label, 160)}`)]
}

/** Format one or more pending user questions. */
export function formatQuestions(session, state, questions) {
  const lines = ['❓ Waiting for your input', scopeLine(session, state)]
  for (const question of questions.slice(0, 4)) {
    const header = snippet(question?.header, 120)
    if (header !== '') lines.push(`— ${header}`)
    lines.push(snippet(question?.question, 500) || 'The agent asked a question.')
    const detail = clip(question?.detail, DETAIL_SNIPPET)
    if (detail !== '') lines.push(detail)
    lines.push(...optionsBlock(question))
  }
  lines.push('Reply in the DSH UI to continue.')
  return finalize(lines)
}

/** Split a markdown plan into a one-line title and the remaining body. */
function planParts(plan) {
  const text = String(plan ?? '').trim()
  const newline = text.indexOf('\n')
  const first = (newline === -1 ? text : text.slice(0, newline)).trim()
  if (!first.startsWith('#')) return { heading: '', body: clip(text, DETAIL_SNIPPET) }
  return {
    heading: snippet(first.replace(/^#+\s*/, ''), 160),
    body: clip(text.slice(first.length).trim(), DETAIL_SNIPPET),
  }
}

/** Format a plan waiting for approval. */
export function formatPlan(session, state, plan) {
  const { heading, body } = planParts(plan)
  return finalize([
    '📋 Plan ready for approval',
    scopeLine(session, state),
    lastUserLine(state),
    heading === '' ? '' : `📌 ${heading}`,
    body,
    'Review it in the DSH UI to approve or keep planning.',
  ])
}

/** Format a pending tool approval. */
export function formatApproval(session, state, request) {
  const tool = snippet(request?.toolName, 120)
  const reason = snippet(request?.reason, REASON_SNIPPET)
  return finalize([
    '🔐 Approval needed',
    scopeLine(session, state),
    lastUserLine(state),
    tool === '' ? '' : `Tool: ${tool}`,
    reason === '' ? '' : `Reason: ${reason}`,
    'Approve or reject it in the DSH UI.',
  ])
}

/** Find the reviewed plan carried by a plan-review question, including its detail. */
export function planFromQuestions(questions) {
  const question = questions.find(isPlanQuestion)
  return typeof question?.detail === 'string' ? question.detail : ''
}

function parseArguments(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function questionsFromArguments(value) {
  const parsed = parseArguments(value)
  return Array.isArray(parsed?.questions) ? parsed.questions : []
}

// ───────────────────────────── delivery ─────────────────────────────

function tokenIsSafe(token) {
  return typeof token === 'string' && token !== '' && !/[\s/?#]/.test(token)
}

async function resolveToken(ctx, settings) {
  if (settings.token !== '') return settings.token
  if (typeof ctx.credentials?.resolve !== 'function') {
    throw new Error(`credential ${settings.tokenRef} is unavailable`)
  }
  let resolved
  try {
    resolved = await ctx.credentials.resolve(settings.tokenRef)
  } catch {
    throw new Error(`credential ${settings.tokenRef} could not be resolved`)
  }
  if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') {
    throw new Error(`credential ${settings.tokenRef} is not set`)
  }
  return resolved.value
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Send one message, retrying once when Telegram asks to wait (HTTP 429).
 * @param {object} options - endpoint and message fields.
 */
export async function sendTelegram({ apiBase, token, chatId, text, silent = false }) {
  if (!tokenIsSafe(token)) throw new Error('the configured bot token is malformed')
  const endpoint = `${apiBase}/bot${token}/sendMessage`
  const body = {
    chat_id: chatId,
    text,
    disable_notification: silent === true,
    link_preview_options: { is_disabled: true },
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new Error('the Telegram API is unreachable')
    }
    if (response.ok) return
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(payload?.parameters?.retry_after)
      await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000, 5000))
      continue
    }
    const description = snippet(payload?.description, 200)
    throw new Error(
      `Telegram sendMessage failed: HTTP ${response.status}${description === '' ? '' : ` (${description})`}`,
    )
  }
}

function createDeliverer(ctx, settings, logger) {
  return async function deliver(text) {
    try {
      const token = await resolveToken(ctx, settings)
      await sendTelegram({
        apiBase: settings.apiBase,
        token,
        chatId: settings.chatId,
        text,
        silent: settings.silent,
      })
    } catch (error) {
      // Never include the endpoint (it carries the token) or the token itself.
      logger.warn(`telegram-notify: ${error instanceof Error ? error.message : 'send failed'}`)
    }
  }
}

// ───────────────────────────── plugin ─────────────────────────────

/**
 * Register session-event handlers. Must never throw into the agent: every
 * handler body is isolated and sends are asynchronous.
 * @param {object} ctx - Cordis context with `credentials` injected.
 * @param {object} config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const logger = ctx.logger(name)
  const settings = resolveSettings(config)
  if (settings === undefined) {
    logger.warn('telegram-notify: unusable configuration (check apiBase and tokenRef); notifications are disabled')
    return
  }
  if (settings.chatId === '') {
    logger.warn('telegram-notify: chatId is not configured; notifications are disabled')
    return
  }

  const deliver = createDeliverer(ctx, settings, logger)
  const sessions = new WeakMap()
  /** Pending settle timers, keyed by `tool:<callId>` or `approval:<id>`. */
  const pending = new Map()

  function stateFor(session) {
    let state = sessions.get(session)
    if (state === undefined) {
      state = { title: '', user: '', assistant: '' }
      sessions.set(session, state)
    }
    return state
  }

  function cancel(key) {
    const timer = pending.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      pending.delete(key)
    }
  }

  function settle(key, text, delayMs) {
    cancel(key)
    const timer = setTimeout(() => {
      pending.delete(key)
      void deliver(text)
    }, delayMs)
    timer.unref?.()
    pending.set(key, timer)
  }

  function onToolCall(session, state, data) {
    if (typeof data?.callId !== 'string') return
    if (data.name === 'ask_user_question') {
      const questions = questionsFromArguments(data.arguments)
      if (questions.length === 0) return
      const plan = planFromQuestions(questions)
      if (plan !== '') {
        if (!settings.notifyPlanReviews) return
        settle(`tool:${data.callId}`, formatPlan(session, state, plan), QUESTION_SETTLE_MS)
        return
      }
      if (!settings.notifyQuestions) return
      settle(`tool:${data.callId}`, formatQuestions(session, state, questions), QUESTION_SETTLE_MS)
      return
    }
    if (data.name === 'exit_plan_mode') {
      if (!settings.notifyPlanReviews) return
      const plan = parseArguments(data.arguments)?.plan
      if (typeof plan !== 'string' || plan.trim() === '') return
      settle(`tool:${data.callId}`, formatPlan(session, state, plan), QUESTION_SETTLE_MS)
    }
  }

  function onTurnEnd(session, state, data) {
    const reason = data?.reason
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
    if (kind === 'completed') {
      if (settings.notifyTurnComplete) void deliver(formatCompleted(session, state))
      return
    }
    if (kind === 'error') {
      if (settings.notifyTurnError) void deliver(formatError(session, state, reason?.error))
      return
    }
    if (kind === 'max-tokens' || kind === 'blocked') {
      if (settings.notifyTurnError) void deliver(formatWarning(session, state, kind))
      return
    }
    if (kind === 'aborted') {
      if (settings.notifyTurnAborted) void deliver(formatAborted(session, state, reason))
    }
  }

  function onSessionEvent(session, event) {
    try {
      if (!isRootSession(session) || typeof event?.type !== 'string') return
      const state = stateFor(session)
      switch (event.type) {
        case 'session/title': {
          const title = event.data?.title
          if (typeof title === 'string') state.title = title
          return
        }
        case 'turn/start':
          state.assistant = ''
          return
        case 'user/message': {
          if (event.data?.source?.kind !== 'user') return
          const text = messageText(event.data)
          if (text !== '') state.user = text
          return
        }
        case 'assistant/message': {
          const text = messageText(event.data?.message)
          if (text !== '') state.assistant = text
          return
        }
        case 'turn/end':
          onTurnEnd(session, state, event.data)
          return
        case 'tool/call':
          onToolCall(session, state, event.data)
          return
        case 'tool/result': {
          const callId = event.data?.message?.toolCallId
          if (typeof callId === 'string') cancel(`tool:${callId}`)
          return
        }
        case 'approval/asked': {
          if (!settings.notifyApprovals) return
          const id = event.data?.id
          if (typeof id !== 'string') return
          settle(`approval:${id}`, formatApproval(session, state, event.data), APPROVAL_SETTLE_MS)
          return
        }
        case 'approval/decided': {
          const id = event.data?.id
          if (typeof id === 'string') cancel(`approval:${id}`)
          return
        }
      }
    } catch (error) {
      logger.warn(`telegram-notify: event handling failed (${error instanceof Error ? error.message : 'unknown'})`)
    }
  }

  ctx.on('session/event', onSessionEvent)
}
