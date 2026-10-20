import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  Config,
  apply,
  clip,
  formatCompleted,
  formatError,
  formatPlan,
  formatQuestions,
  messageText,
  resolveSettings,
  sendTelegram,
  snippet,
} from '../index.js'

// ───────────────────────────── harness ─────────────────────────────

async function startStub(handler) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
    const request = { path: req.url, method: req.method, body: parsed }
    requests.push(request)
    const reply = await handler?.(request, requests.length)
    res.statusCode = reply?.status ?? 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(reply?.body ?? { ok: true, result: { message_id: requests.length } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    requests,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function createContext({ token = 'test-token', resolve } = {}) {
  const handlers = new Map()
  const logs = []
  const ctx = {
    logger: () => ({
      info: (...args) => logs.push(['info', args.join(' ')]),
      warn: (...args) => logs.push(['warn', args.join(' ')]),
      error: (...args) => logs.push(['error', args.join(' ')]),
      debug: () => {},
    }),
    on: (eventName, callback) => {
      handlers.set(eventName, callback)
    },
    credentials: {
      resolve: resolve ?? (async () => ({ value: token, source: 'test' })),
    },
  }
  return { ctx, handlers, logs }
}

function session(cwd = '/Users/ruben/dsh-plugins', overrides = {}) {
  const id = overrides.id ?? `session-${Math.random().toString(16).slice(2)}`
  return {
    id,
    header: {
      version: 4,
      id,
      createdAt: 0,
      cwd,
      isSeeded: false,
      ...overrides,
    },
  }
}

function emit(handlers, target, type, data) {
  const handler = handlers.get('session/event')
  assert.equal(typeof handler, 'function', 'session/event handler should be registered')
  handler(target, { type, seq: 0, time: Date.now(), data })
}

function userMessage(text) {
  return { role: 'user', id: 'u1', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMessage(text) {
  return { role: 'assistant', id: 'a1', content: [{ type: 'text', text }], source: { kind: 'model' } }
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for the expected message')
}

async function settle(ms = 550) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function mount({ base, chatId = '42', config = {}, token, resolve } = {}) {
  const harness = createContext({ token, resolve })
  apply(harness.ctx, {
    apiBase: base,
    chatId,
    token: 'test-token',
    ...config,
  })
  return harness
}

// ───────────────────────────── format helpers ─────────────────────────────

test('messageText keeps text blocks and skips reasoning/tool blocks', () => {
  assert.equal(
    messageText({
      content: [
        { type: 'text', text: 'first' },
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'second' },
      ],
    }),
    'first\nsecond',
  )
})

test('snippet collapses whitespace and clip preserves newlines', () => {
  assert.equal(snippet('  a\n\n b  '), 'a b')
  assert.equal(clip('a\n\nb'), 'a\n\nb')
})

test('resolveSettings applies defaults and rejects unusable values', () => {
  const settings = resolveSettings({ chatId: 123 })
  assert.equal(settings.chatId, '123')
  assert.equal(settings.tokenRef, 'TELEGRAM_BOT_TOKEN')
  assert.equal(settings.apiBase, 'https://api.telegram.org')
  assert.equal(settings.notifyTurnComplete, true)
  assert.equal(settings.notifyTurnAborted, false)

  assert.equal(resolveSettings({ apiBase: 'ftp://example.com' }), undefined)
  assert.equal(resolveSettings({ tokenRef: 'not a reference' }), undefined)
  assert.equal(resolveSettings({ tokenRef: 'not a reference', token: 'literal' }).token, 'literal')
})

test('formatters stay within the Telegram limit', () => {
  const long = 'x'.repeat(20_000)
  const completed = formatCompleted(session(), { title: '', user: long, assistant: long })
  assert.ok(completed.length <= 4096)
  assert.match(completed, /Turn complete/)

  const questions = formatQuestions(
    session(),
    { user: long },
    Array.from({ length: 4 }, (_, index) => ({
      id: `q${index}`,
      question: long,
      detail: long,
      options: Array.from({ length: 10 }, (_, option) => ({ label: `${option}-${long}` })),
    })),
  )
  assert.ok(questions.length <= 4096)
  assert.ok(questions.endsWith('…'))

  const plan = formatPlan(session(), {}, long)
  assert.ok(plan.length <= 4096)
  assert.match(plan, /Plan ready for approval/)
})

test('exact-limit text is not truncated', () => {
  const text = 'a'.repeat(4096)
  assert.equal(snippet(text, 4096), text)
  assert.equal(clip(text, 100), `${'a'.repeat(99)}…`)
})

// ───────────────────────────── event wiring ─────────────────────────────

test('completed turn sends session context and final answer', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    const target = session('/Users/ruben/project')
    emit(handlers, target, 'session/title', { title: 'Fix login', messageSeqs: [], source: { kind: 'fallback' } })
    emit(handlers, target, 'user/message', userMessage('Why is login broken?'))
    emit(handlers, target, 'turn/start', { turn: 1 })
    emit(handlers, target, 'assistant/message', {
      turn: 1,
      step: 1,
      message: assistantMessage('Found the expired token.'),
      stream: [],
    })
    emit(handlers, target, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

    await waitFor(() => server.requests.length === 1)
    const [request] = server.requests
    assert.equal(request.method, 'POST')
    assert.equal(request.path, '/bottest-token/sendMessage')
    assert.equal(request.body.chat_id, '42')
    assert.match(request.body.text, /✅ Turn complete/)
    assert.match(request.body.text, /project — Fix login/)
    assert.match(request.body.text, /Why is login broken\?/)
    assert.match(request.body.text, /Found the expired token\./)
    assert.equal(request.body.disable_notification, false)
    assert.deepEqual(request.body.link_preview_options, { is_disabled: true })
  } finally {
    await server.close()
  }
})

test('a failed turn sends the error message and code', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    const target = session()
    emit(handlers, target, 'user/message', userMessage('Run the tests'))
    emit(handlers, target, 'turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'Provider exploded', code: 'PROVIDER', status: 502 } },
    })
    await waitFor(() => server.requests.length === 1)
    const text = server.requests[0].body.text
    assert.match(text, /❌ Turn failed/)
    assert.match(text, /Provider exploded \(PROVIDER\) · HTTP 502/)
  } finally {
    await server.close()
  }
})

test('max-token and blocked turns produce warnings', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    emit(handlers, session(), 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    emit(handlers, session(), 'turn/end', { turn: 2, reason: { kind: 'blocked' } })
    await waitFor(() => server.requests.length === 2)
    assert.match(server.requests[0].body.text, /output-token limit/)
    assert.match(server.requests[1].body.text, /turn was blocked/)
  } finally {
    await server.close()
  }
})

test('cancelled turns stay quiet unless enabled', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    emit(handlers, session(), 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await settle(150)
    assert.equal(server.requests.length, 0)

    emit(handlers, session(), 'turn/end', {
      turn: 2,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    // Re-mount with the toggle to exercise the enabled path.
    const enabled = await mount({ base: server.base, config: { notifyTurnAborted: true } })
    emit(enabled.handlers, session(), 'turn/end', {
      turn: 3,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    await waitFor(() => server.requests.length === 1)
    assert.match(server.requests[0].body.text, /⏹ Turn cancelled[\s\S]*Cause: user/)
  } finally {
    await server.close()
  }
})

test('subagent sessions are ignored', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    emit(handlers, session('/tmp/child', { origin: 'subagent', delegationDepth: 1 }), 'turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    })
    await settle(200)
    assert.equal(server.requests.length, 0)
  } finally {
    await server.close()
  }
})

test('missing chatId registers nothing and warns once', async () => {
  const { ctx, handlers, logs } = createContext()
  apply(ctx, { chatId: '', apiBase: 'https://api.telegram.org', token: 'test-token' })
  assert.equal(handlers.size, 0)
  assert.ok(logs.some(([level, message]) => level === 'warn' && /chatId/.test(message)))
})

test('event toggles disable individual notifications', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({
      base: server.base,
      config: { notifyTurnComplete: false, notifyTurnError: false, notifyApprovals: false },
    })
    emit(handlers, session(), 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    emit(handlers, session(), 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'X' } } })
    emit(handlers, session(), 'approval/asked', { id: 'a1', toolName: 'bash' })
    await settle(700)
    assert.equal(server.requests.length, 0)
  } finally {
    await server.close()
  }
})

test('question and plan toggles disable those notifications', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({
      base: server.base,
      config: { notifyQuestions: false, notifyPlanReviews: false },
    })
    emit(handlers, session(), 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'q-off',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Hidden?' }] }),
    })
    emit(handlers, session(), 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'plan-off',
      name: 'exit_plan_mode',
      arguments: JSON.stringify({ plan: '# Hidden plan' }),
    })
    await settle(700)
    assert.equal(server.requests.length, 0)
  } finally {
    await server.close()
  }
})

// ───────────────────────────── questions and plans ─────────────────────────────

test('ask_user_question sends the question and options', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    const target = session()
    emit(handlers, target, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [
          {
            id: 'q1',
            header: 'Deploy',
            question: 'Deploy to production now?',
            options: [{ label: 'Deploy' }, { label: 'Wait' }],
          },
        ],
      }),
    })
    await waitFor(() => server.requests.length === 1)
    const text = server.requests[0].body.text
    assert.match(text, /❓ Waiting for your input/)
    assert.match(text, /Deploy to production now\?/)
    assert.match(text, /• Deploy/)
    assert.match(text, /• Wait/)
  } finally {
    await server.close()
  }
})

test('a question whose tool result arrives first is not announced', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    const target = session()
    emit(handlers, target, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-fast',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Quick?' }] }),
    })
    emit(handlers, target, 'tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'call-fast', isError: true, content: [] },
      error: { name: 'Error', code: 'NO_ANSWERER' },
    })
    await settle(700)
    assert.equal(server.requests.length, 0)
  } finally {
    await server.close()
  }
})

test('exit_plan_mode sends the plan for approval', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    emit(handlers, session(), 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'plan-1',
      name: 'exit_plan_mode',
      arguments: JSON.stringify({ plan: '# Ship notifications\n\nAdd the plugin and test it.' }),
    })
    await waitFor(() => server.requests.length === 1)
    const text = server.requests[0].body.text
    assert.match(text, /📋 Plan ready for approval/)
    assert.match(text, /Ship notifications/)
    assert.match(text, /Add the plugin and test it\./)
    assert.match(text, /approve or keep planning/)
  } finally {
    await server.close()
  }
})

test('a plan-review ask_user_question uses the plan format', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    emit(handlers, session(), 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'plan-2',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [
          {
            id: 'review',
            header: 'Plan review',
            question: 'Approve this plan and leave plan mode?',
            detail: '# Refactor auth\n\nSplit the session handling.',
            intent: { kind: 'plan-review', approve: 'Approve' },
          },
        ],
      }),
    })
    await waitFor(() => server.requests.length === 1)
    const text = server.requests[0].body.text
    assert.match(text, /📋 Plan ready for approval/)
    assert.match(text, /Refactor auth/)
    assert.doesNotMatch(text, /Waiting for your input/)
  } finally {
    await server.close()
  }
})

// ───────────────────────────── approvals ─────────────────────────────

test('a pending approval is announced after the settle window', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    emit(handlers, session(), 'approval/asked', {
      id: 'approval-1',
      toolName: 'bash',
      reason: 'writes outside the workspace',
    })
    await settle(150)
    assert.equal(server.requests.length, 0, 'should not announce before the settle window')
    await waitFor(() => server.requests.length === 1)
    const text = server.requests[0].body.text
    assert.match(text, /🔐 Approval needed/)
    assert.match(text, /Tool: bash/)
    assert.match(text, /writes outside the workspace/)
  } finally {
    await server.close()
  }
})

test('an approval decided by policy is not announced', async () => {
  const server = await startStub()
  try {
    const { handlers } = await mount({ base: server.base })
    emit(handlers, session(), 'approval/asked', { id: 'approval-2', toolName: 'bash' })
    emit(handlers, session(), 'approval/decided', { id: 'approval-2', outcome: 'rejected' })
    await settle(700)
    assert.equal(server.requests.length, 0)
  } finally {
    await server.close()
  }
})

// ───────────────────────────── transport ─────────────────────────────

test('a 429 response is retried once after retry_after', async () => {
  const server = await startStub((_request, count) =>
    count === 1
      ? { status: 429, body: { ok: false, parameters: { retry_after: 0.01 } } }
      : { body: { ok: true, result: { message_id: 2 } } },
  )
  try {
    await sendTelegram({ apiBase: server.base, token: 'test-token', chatId: '42', text: 'hello' })
    assert.equal(server.requests.length, 2)
    assert.equal(server.requests[1].body.text, 'hello')
  } finally {
    await server.close()
  }
})

test('a missing credential is logged without leaking the token', async () => {
  const server = await startStub()
  try {
    const { handlers, logs } = await mount({
      base: server.base,
      token: undefined,
      config: { token: '' },
      resolve: async () => undefined,
    })
    emit(handlers, session(), 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await waitFor(() => logs.some(([level]) => level === 'warn'))
    assert.equal(server.requests.length, 0)
    const warning = logs.find(([level]) => level === 'warn')[1]
    assert.match(warning, /TELEGRAM_BOT_TOKEN is not set/)
    assert.doesNotMatch(warning, /test-token/)
  } finally {
    await server.close()
  }
})

test('the Config schema applies the documented defaults', () => {
  const parsed = Config({ chatId: '42' })
  assert.equal(parsed.chatId, '42')
  assert.equal(parsed.tokenRef, 'TELEGRAM_BOT_TOKEN')
  assert.equal(parsed.apiBase, 'https://api.telegram.org')
  assert.equal(parsed.notifyTurnComplete, true)
  assert.equal(parsed.notifyTurnAborted, false)
})
