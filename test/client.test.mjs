import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = new URL('..', import.meta.url)
const clientSource = readFileSync(new URL('lib/client.js', root), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

/** Evaluate the classic client bundle once and capture its loader definition. */
let definition
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      definition = value
    },
  },
}
vm.runInThisContext(clientSource, { filename: 'lib/client.js' })

test('client bundle is a classic module-loader script', () => {
  assert.match(clientSource, /__ModuleLoader__/)
  assert.doesNotMatch(clientSource, /^\s*(?:import|export)\b/m)
  assert.equal(definition.id, packageJson.name)
  assert.equal(typeof definition.factory, 'function')
})

function fakeContext() {
  const copies = new Map()
  const state = { registration: undefined, localeCopies: copies }
  const form = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      revision: 1,
      value: {
        chatId: '123456789',
        tokenRef: 'TELEGRAM_BOT_TOKEN',
        notifyTurnComplete: true,
        notifyTurnError: true,
        notifyTurnAborted: false,
        notifyQuestions: true,
        notifyPlanReviews: true,
        notifyApprovals: true,
        silent: false,
      },
    }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const ctx = {
    effect: (run) => {
      const dispose = run()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: (ns, copy) => {
        copies.set(ns, copy)
        return () => {}
      },
      bind: (ns) => (key) => copies.get(ns)?.en?.[key] ?? key,
    },
    slots: {
      inject: (slot, register) => {
        assert.equal(slot, 'settings.section')
        register()
        return () => {}
      },
      register: (options, component) => {
        state.registration = { options, component }
        return () => {}
      },
    },
    configForms: {
      get: (ns) => {
        assert.equal(ns, 'telegram-notify')
        return form
      },
    },
    remote: {
      $on: () => () => {},
      credentials: {
        describe: async () => ({ ok: true, value: { TELEGRAM_BOT_TOKEN: { configured: true, writable: true } } }),
        set: async () => ({ ok: true }),
        unset: async () => ({ ok: true }),
      },
    },
  }
  return { ctx, state, form }
}

test('client apply registers the Telegram settings section', () => {
  const { ctx, state } = fakeContext()
  const exports = definition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected client require: ${specifier}`)
  })
  assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms', 'remote'])
  exports.apply(ctx)

  const registration = state.registration
  assert.ok(registration)
  assert.equal(registration.options.name, 'settings.section')
  assert.equal(registration.options.id, 'telegram-notify')
  assert.equal(registration.options.order, 30)
  assert.equal(registration.options.locale, 'settings.telegram')
  assert.equal(registration.options.label(), 'Telegram')
  assert.ok(state.localeCopies.get('settings.telegram').en.title)
})

test('the settings section renders the connection, events and delivery controls', () => {
  const { ctx, state } = fakeContext()
  const exports = definition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected client require: ${specifier}`)
  })
  exports.apply(ctx)

  const props = state.registration.options.inject()
  const html = renderToStaticMarkup(React.createElement(state.registration.component, props))

  assert.match(html, /Telegram notifications/)
  assert.match(html, /Bot token/)
  assert.match(html, /Chat id/)
  assert.match(html, /Credential reference/)
  assert.match(html, /Turn completed/)
  assert.match(html, /Plan ready for review/)
  assert.match(html, /Approval needed/)
  assert.match(html, /Silent notifications/)
  assert.match(html, /Save settings/)
  assert.match(html, /123456789/)
  assert.match(html, /role="switch"/)
})

test('the settings section reports an unavailable namespace', () => {
  const { ctx, state, form } = fakeContext()
  form.getSnapshot = () => ({ status: 'unavailable', writable: false })
  const exports = definition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected client require: ${specifier}`)
  })
  exports.apply(ctx)

  const props = state.registration.options.inject()
  const html = renderToStaticMarkup(React.createElement(state.registration.component, props))
  assert.match(html, /Telegram notifications/)
  assert.match(html, /not loaded in this deployment/)
})
