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
 * Its custom settings page lives in `client.ts` and writes the namespace whose
 * id is the loader row id, `telegram-notify`.
 *
 * @module dsh-telegram-notify
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
// Type-only imports carry the session-event augmentations of these plugins.
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'

/** Plugin name; also the loader row id, settings namespace and logger name. */
export const name = 'telegram-notify'

/** Credential resolution is the only required service. Settings is optional. */
export const inject = ['credentials']

const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'
const DEFAULT_API_BASE = 'https://api.telegram.org'
/** Telegram rejects sendMessage text above 4096 characters. */
const MAX_MESSAGE = 4096
/** Delay before a question notification, so an instantly-failing tool call is not announced. */
const QUESTION_SETTLE_MS = 400
/** Delay before an approval notification, so policy-decided asks are not announced. */
const APPROVAL_SETTLE_MS = 400
const USER_SNIPPET = 500
const ASSISTANT_SNIPPET = 900
const DETAIL_SNIPPET = 1500
const REASON_SNIPPET = 400

export const Config = z.object({
  chatId: z
    .union([z.string(), z.number()])
    .default('')
    .description('Telegram chat id that receives the notifications. Quote it when it starts with -.')
    .volatile(),
  tokenRef: z
    .string()
    .role('credential-ref')
    .default(DEFAULT_TOKEN_REF)
    .description('Credential reference holding the Telegram bot token.')
    .volatile(),
  token: z
    .string()
    .role('secret')
    .description('Literal bot token. Prefer tokenRef; use this only for one-off local runs.'),
  apiBase: z.string().default(DEFAULT_API_BASE).description('Bot API base URL. Change only for a local Bot API server.'),
  silent: z.boolean().default(false).description('Send messages without a notification sound.').volatile(),
  notifyTurnComplete: z.boolean().default(true).description('Notify when a turn completes.').volatile(),
  notifyTurnError: z
    .boolean()
    .default(true)
    .description('Notify on turn errors, blocked turns and max-token stops.')
    .volatile(),
  notifyTurnAborted: z.boolean().default(false).description('Notify when a turn is cancelled.').volatile(),
  notifyQuestions: z.boolean().default(true).description('Notify when the agent is waiting for an answer.').volatile(),
  notifyPlanReviews: z
    .boolean()
    .default(true)
    .description('Notify when a plan is waiting for approval.')
    .volatile(),
  notifyApprovals: z
    .boolean()
    .default(true)
    .description('Notify when a tool approval is waiting for the human.')
    .volatile(),
})

/** Raw plugin configuration; every field is optional until normalization. */
export interface ConfigValues {
  chatId?: string | number
  tokenRef?: string
  token?: string
  apiBase?: string
  silent?: boolean
  notifyTurnComplete?: boolean
  notifyTurnError?: boolean
  notifyTurnAborted?: boolean
  notifyQuestions?: boolean
  notifyPlanReviews?: boolean
  notifyApprovals?: boolean
}

/** Normalized settings used by every handler. */
export interface Settings {
  chatId: string
  token: string
  tokenRef: string
  apiBase: string
  silent: boolean
  notifyTurnComplete: boolean
  notifyTurnError: boolean
  notifyTurnAborted: boolean
  notifyQuestions: boolean
  notifyPlanReviews: boolean
  notifyApprovals: boolean
}

// ───────────────────────────── configuration ─────────────────────────────

function normalizeApiBase(value: unknown): string | undefined {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_API_BASE
  let url: URL
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
 * @param raw - user configuration.
 * @returns resolved settings, or `undefined` when a value is unusable.
 */
function unwrap(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const holder = value as { get?: unknown }
  return typeof holder.get === 'function' ? (holder.get as () => unknown)() : value
}

export function resolveSettings(raw: unknown = {}): Settings | undefined {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const apiBase = normalizeApiBase(unwrap(source.apiBase))
  if (apiBase === undefined) return undefined
  const tokenValue = unwrap(source.token)
  const token = typeof tokenValue === 'string' ? tokenValue.trim() : ''
  const refValue = unwrap(source.tokenRef)
  const tokenRef =
    typeof refValue === 'string' && refValue.trim() !== '' ? refValue.trim() : DEFAULT_TOKEN_REF
  if (token === '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenRef)) return undefined
  return {
    chatId: String(unwrap(source.chatId) ?? '').trim(),
    token,
    tokenRef,
    apiBase,
    silent: unwrap(source.silent) === true,
    notifyTurnComplete: unwrap(source.notifyTurnComplete) !== false,
    notifyTurnError: unwrap(source.notifyTurnError) !== false,
    notifyTurnAborted: unwrap(source.notifyTurnAborted) === true,
    notifyQuestions: unwrap(source.notifyQuestions) !== false,
    notifyPlanReviews: unwrap(source.notifyPlanReviews) !== false,
    notifyApprovals: unwrap(source.notifyApprovals) !== false,
  }
}

// ───────────────────────────── text helpers ─────────────────────────────

interface TextBlockLike {
  readonly type?: string
  readonly text?: string
}

interface MessageLike {
  readonly content?: readonly TextBlockLike[]
}

interface SessionState {
  title: string
  user: string
  assistant: string
}

/** Concatenate text blocks from a DSH message. */
export function messageText(message: MessageLike | undefined): string {
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
export function snippet(value: unknown, limit: number = USER_SNIPPET): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/** Clip a value while preserving newlines, for plan and question detail. */
export function clip(value: unknown, limit: number = DETAIL_SNIPPET): string {
  const text = String(value ?? '').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function finalize(lines: readonly string[]): string {
  const text = lines.filter((line) => line !== '').join('\n')
  if (text.length <= MAX_MESSAGE) return text
  return `${text.slice(0, MAX_MESSAGE - 1)}…`
}

function workspaceOf(session: Session | undefined): string {
  const cwd = session?.header.cwd
  if (typeof cwd !== 'string' || cwd === '') return 'DSH'
  const leaf = basename(cwd)
  return leaf === '' ? cwd : leaf
}

function scopeLine(session: Session | undefined, state: SessionState | undefined): string {
  const workspace = workspaceOf(session)
  const title = typeof state?.title === 'string' ? state.title.trim() : ''
  return `📁 ${workspace}${title !== '' && title !== workspace ? ` — ${title}` : ''}`
}

function lastUserLine(state: SessionState | undefined): string {
  const user = snippet(state?.user)
  return user === '' ? '' : `👤 ${user}`
}

function isRootSession(session: Session): boolean {
  const header = session.header
  if (header.origin === 'subagent') return false
  return (header.delegationDepth ?? 0) === 0
}

// ───────────────────────────── formatters ─────────────────────────────

/** Format a completed turn. */
export function formatCompleted(session: Session, state: SessionState): string {
  const assistant = snippet(state.assistant, ASSISTANT_SNIPPET)
  return finalize([
    '✅ Turn complete',
    scopeLine(session, state),
    lastUserLine(state),
    assistant === '' ? '' : `🤖 ${assistant}`,
  ])
}

/** Format a failed turn. */
export function formatError(session: Session, state: SessionState, error: LlmFailure | undefined): string {
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
export function formatWarning(session: Session, state: SessionState, kind: string): string {
  const reason =
    kind === 'max-tokens'
      ? 'the output-token limit was reached'
      : kind === 'blocked'
        ? 'the turn was blocked'
        : `the turn ended (${kind})`
  return finalize(['⚠️ Turn stopped', scopeLine(session, state), lastUserLine(state), `Reason: ${reason}`])
}

/** Format a cancelled turn. */
export function formatAborted(session: Session, state: SessionState, reason: TurnEndReason): string {
  const cause = reason.kind === 'aborted' ? reason.reason.kind : undefined
  return finalize([
    '⏹ Turn cancelled',
    scopeLine(session, state),
    lastUserLine(state),
    typeof cause === 'string' ? `Cause: ${cause}` : '',
  ])
}

interface QuestionOptionLike {
  readonly label?: string
  readonly description?: string
}

interface QuestionLike {
  readonly id?: string
  readonly question?: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly QuestionOptionLike[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind?: string; readonly approve?: string; readonly callId?: string }
}

function optionsBlock(question: QuestionLike): string[] {
  const options = Array.isArray(question.options) ? question.options : []
  if (options.length === 0) return []
  return ['Options:', ...options.map((option) => `• ${snippet(option?.label, 160)}`)]
}

/** Format one or more pending user questions. */
export function formatQuestions(session: Session, state: SessionState, questions: readonly QuestionLike[]): string {
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
function planParts(plan: string | undefined): { heading: string; body: string } {
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
export function formatPlan(session: Session, state: SessionState, plan: string | undefined): string {
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
export function formatApproval(
  session: Session,
  state: SessionState,
  request: { toolName?: string; reason?: string },
): string {
  const tool = snippet(request.toolName, 120)
  const reason = snippet(request.reason, REASON_SNIPPET)
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
export function planFromQuestions(questions: readonly QuestionLike[]): string {
  const question = questions.find((candidate) => candidate?.intent?.kind === 'plan-review')
  return typeof question?.detail === 'string' ? question.detail : ''
}

function parseArguments(value: string | undefined): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function questionsFromArguments(value: string | undefined): QuestionLike[] {
  const parsed = parseArguments(value)
  return Array.isArray(parsed?.questions) ? (parsed.questions as QuestionLike[]) : []
}

// ───────────────────────────── delivery ─────────────────────────────

function tokenIsSafe(token: string): boolean {
  return token !== '' && !/[\s/?#]/.test(token)
}

async function resolveToken(ctx: Context, settings: Settings): Promise<string> {
  if (settings.token !== '') return settings.token
  if (typeof ctx.credentials?.resolve !== 'function') {
    throw new Error(`credential ${settings.tokenRef} is unavailable`)
  }
  let resolved: { value?: string } | undefined
  try {
    resolved = await ctx.credentials.resolve(settings.tokenRef as CredentialRef)
  } catch {
    throw new Error(`credential ${settings.tokenRef} could not be resolved`)
  }
  if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') {
    throw new Error(`credential ${settings.tokenRef} is not set`)
  }
  return resolved.value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Send one message, retrying once when Telegram asks to wait (HTTP 429).
 * @param options - endpoint and message fields.
 */
export async function sendTelegram(options: {
  apiBase: string
  token: string
  chatId: string
  text: string
  silent?: boolean
}): Promise<void> {
  const { apiBase, token, chatId, text, silent = false } = options
  if (!tokenIsSafe(token)) throw new Error('the configured bot token is malformed')
  const endpoint = `${apiBase}/bot${token}/sendMessage`
  const body = {
    chat_id: chatId,
    text,
    disable_notification: silent,
    link_preview_options: { is_disabled: true },
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response
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
    let payload: { description?: string; parameters?: { retry_after?: number } } | undefined
    try {
      payload = (await response.json()) as typeof payload
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

interface LoggerLike {
  warn: (message: string) => void
}

function createDeliverer(ctx: Context, readSettings: () => Settings | undefined, logger: LoggerLike) {
  return async function deliver(text: string): Promise<void> {
    try {
      const settings = readSettings()
      if (settings === undefined || settings.chatId === '') return
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
 * Keep the custom client page as the only settings surface. The Host can
 * otherwise auto-generate a plain form from `Config`; that form would expose
 * the literal `token` field, which we deliberately replace with credential
 * storage in the custom page.
 */
function hideAutoSettingsPage(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (typeof settings?.configure !== 'function') return
    settingsCtx.effect(() => {
      try {
        return settings.configure({ auto: false }, ctx.fiber)
      } catch {
        return () => {}
      }
    }, 'telegram-notify: custom settings page')
  })
}

/**
 * Register session-event handlers. Must never throw into the agent: every
 * handler body is isolated and sends are asynchronous.
 * @param ctx - Cordis context with `credentials` injected.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: unknown): void {
  const logger = ctx.logger(name)
  hideAutoSettingsPage(ctx)

  // Volatile config fields stay live without a remount, so read them at the
  // moment of use instead of snapshotting the value from `apply`.
  const readSettings = (): Settings | undefined => resolveSettings(config)
  const initial = readSettings()
  if (initial === undefined) {
    logger.warn('telegram-notify: unusable configuration (check apiBase and tokenRef); notifications stay disabled')
  } else if (initial.chatId === '') {
    logger.warn('telegram-notify: chatId is not configured; notifications stay disabled')
  }

  const deliver = createDeliverer(ctx, readSettings, logger)
  const sessions = new WeakMap<Session, SessionState>()
  /** Pending settle timers, keyed by `tool:<callId>` or `approval:<id>`. */
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

  function stateFor(session: Session): SessionState {
    let state = sessions.get(session)
    if (state === undefined) {
      state = { title: '', user: '', assistant: '' }
      sessions.set(session, state)
    }
    return state
  }

  function cancel(key: string): void {
    const timer = pending.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      pending.delete(key)
    }
  }

  function settle(key: string, text: string, delayMs: number): void {
    cancel(key)
    const timer = setTimeout(() => {
      pending.delete(key)
      void deliver(text)
    }, delayMs)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
    pending.set(key, timer)
  }

  function onToolCall(session: Session, state: SessionState, data: { callId: string; name: string; arguments: string }): void {
    const settings = readSettings()
    if (settings === undefined || settings.chatId === '') return
    if (typeof data.callId !== 'string') return
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

  function onTurnEnd(session: Session, state: SessionState, data: { turn: number; reason: TurnEndReason }): void {
    const settings = readSettings()
    if (settings === undefined || settings.chatId === '') return
    const reason = data.reason
    const kind = reason.kind
    if (kind === 'completed') {
      if (settings.notifyTurnComplete) void deliver(formatCompleted(session, state))
      return
    }
    if (kind === 'error') {
      if (settings.notifyTurnError) void deliver(formatError(session, state, reason.error))
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

  function onSessionEvent(session: Session, event: SessionEvent): void {
    try {
      if (!isRootSession(session) || typeof event?.type !== 'string') return
      const state = stateFor(session)
      switch (event.type) {
        case 'session/title': {
          const title = event.data.title
          if (typeof title === 'string') state.title = title
          return
        }
        case 'turn/start':
          state.assistant = ''
          return
        case 'user/message': {
          if (event.data.source.kind !== 'user') return
          const text = messageText(event.data)
          if (text !== '') state.user = text
          return
        }
        case 'assistant/message': {
          const text = messageText(event.data.message)
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
          const callId = event.data.message.toolCallId
          if (typeof callId === 'string') cancel(`tool:${callId}`)
          return
        }
        case 'approval/asked': {
          const settings = readSettings()
          if (settings === undefined || settings.chatId === '' || !settings.notifyApprovals) return
          const id = event.data.id
          if (typeof id !== 'string') return
          settle(`approval:${id}`, formatApproval(session, state, event.data), APPROVAL_SETTLE_MS)
          return
        }
        case 'approval/decided': {
          const id = event.data.id
          if (typeof id !== 'string') return
          cancel(`approval:${id}`)
          return
        }
      }
    } catch (error) {
      logger.warn(`telegram-notify: event handling failed (${error instanceof Error ? error.message : 'unknown'})`)
    }
  }

  ctx.on('session/event', onSessionEvent)
}
