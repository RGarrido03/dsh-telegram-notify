# dsh-telegram-notify

[![npm](https://img.shields.io/npm/v/dsh-telegram-notify)](https://www.npmjs.com/package/dsh-telegram-notify)
[![ci](https://github.com/RGarrido03/dsh-telegram-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/RGarrido03/dsh-telegram-notify/actions/workflows/ci.yml)

One-way Telegram notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
When you are away from the DSH UI, the bot tells you that a turn finished,
failed, is waiting for an answer, has a plan ready for review, or needs a tool
approval. It never reads Telegram updates, so the bot stays send-only.

The plugin ships its own **Settings → Telegram** page: paste the bot token,
enter the chat id, and pick which events notify you. No YAML editing needed.

## Events

| Event | Message | Toggle |
| --- | --- | --- |
| A turn completes | ✅ Turn complete | `notifyTurnComplete` |
| A turn fails, is blocked, or hits the token limit | ❌ / ⚠️ | `notifyTurnError` |
| A turn is cancelled | ⏹ Turn cancelled | `notifyTurnAborted` (off by default) |
| `ask_user_question` waits for an answer | ❓ Waiting for your input | `notifyQuestions` |
| A plan is presented for approval (`exit_plan_mode` / plan-review question) | 📋 Plan ready for approval | `notifyPlanReviews` |
| A tool approval waits for a human | 🔐 Approval needed | `notifyApprovals` |

Subagent sessions are ignored. Approval and question notifications wait 400 ms
and are cancelled if the corresponding decision/tool result arrives first, so
instantly rejected approvals and instantly failing tool calls stay quiet.

Messages are fire-and-forget. A Telegram outage is logged as a warning and
never fails, blocks, or delays an agent turn.

## Install

```bash
dsh plugin --profile web add dsh-telegram-notify
```

If your app runs the `desktop` profile, use `--profile desktop`. From a local
checkout (before the npm release), use `dsh plugin --profile web add link:$PWD`.

Enable the bundle by adding `"dsh-telegram-notify"` to `dsh.profile.bundles` in
`~/.dsh/profiles/web/package.json` (or enable it from the DSH Plugin Manager).
The bundle patch mounts the `telegram-notify` row.

Restart DSH, open **Settings → Telegram**, and:

1. Paste the bot token and press **Save token**. It is stored in the DSH
   credential store under the reference shown on the page
   (`TELEGRAM_BOT_TOKEN` by default), never in the plugin configuration.
2. Enter the chat id and press **Save settings**.
3. Pick the events you want and save again.

### Getting a bot and chat id

Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
Send the bot a message first, then ask a helper bot such as
[@userinfobot](https://t.me/userinfobot) for your numeric id. For a group, add
the bot to the group and use the group's negative id (for example
`-1001234567890`); `@channelusername` also works for public channels.

The plugin only calls `sendMessage`. It never calls `getUpdates`, so it cannot
consume messages meant for another Telegram integration.

## Configuration reference

The Settings page writes the profile patch for the `telegram-notify` row. The
same fields remain editable in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: telegram-notify
  config:
    chatId: "123456789"
    tokenRef: TELEGRAM_BOT_TOKEN
    notifyTurnComplete: true
    notifyTurnError: true
    notifyTurnAborted: false
    notifyQuestions: true
    notifyPlanReviews: true
    notifyApprovals: true
    silent: false
```

| Field | Default | Meaning |
| --- | --- | --- |
| `chatId` | `""` (disabled) | Target chat id, or `@channelusername`. |
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | Credential reference holding the bot token. |
| `token` | unset | Literal token for headless/one-off runs. The Settings page never writes this; prefer `tokenRef`. |
| `apiBase` | `https://api.telegram.org` | Bot API base URL; only change for a local Bot API server. |
| `silent` | `false` | Send without a notification sound. |
| `notifyTurnComplete` | `true` | Completed turns. |
| `notifyTurnError` | `true` | Failed, blocked, and max-token turns. |
| `notifyTurnAborted` | `false` | Cancelled turns. |
| `notifyQuestions` | `true` | Pending user questions. |
| `notifyPlanReviews` | `true` | Plans waiting for approval. |
| `notifyApprovals` | `true` | Pending tool approvals. |

The editable page fields are schemastery `volatile` config, so saves apply to
the running plugin without a restart. Messages are plain text (no parse mode),
so model output cannot break formatting or inject markup; text is clipped to
Telegram's 4096-character limit.

If you also run a two-way Telegram bridge such as `dsh-im`, sessions handled by
that bridge produce their own replies, and this plugin will additionally send
turn notifications for them. Disable the bridge or turn off the turn toggles
if that is noisy.

## How it works

The Host half subscribes to `session/event`. It formats messages from
`turn/end`, `tool/call` (`ask_user_question`, `exit_plan_mode`),
`approval/asked`/`approval/decided`, `assistant/message`, `user/message`, and
`session/title`, and posts them with `fetch`. The browser half registers a
`settings.section` slot and reads/writes the `telegram-notify` namespace through
`ctx.configForms`; the token goes through the credentials remote. The Host
plugin disables the auto-generated config form so the secret `token` field is
never exposed by a generic page.

## Development

```bash
pnpm install
pnpm check        # typecheck, build, node:test
```

Source layout: `src/index.ts` (Host), `src/client.ts` (browser settings page,
compiled as a classic module-loader script), `test/` (Host event pipeline,
client registration, and server-rendered settings page). No test touches
Telegram; the transport tests use a local HTTP stub.

The first npm publish must authenticate with a token (trusted publishing can
only be configured after the package exists):

```bash
npm login
npm publish --access public
```

Then add this repository as a trusted publisher for `dsh-telegram-notify` on
npm (package settings → Trusted publishing → GitHub Actions, workflow
`publish.yml`). Subsequent releases publish through OIDC from
`.github/workflows/publish.yml` when a GitHub release is published.

## License

MIT
