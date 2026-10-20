# dsh-telegram-notify

One-way Telegram notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
When you are away from the DSH Web UI, the bot tells you that a turn finished,
a turn failed, the agent is waiting for an answer, a plan is ready for review,
or a tool approval needs you. It never reads Telegram updates, so the bot stays
send-only and there is no chat command surface.

## What triggers a message

| Event | Message | Toggle |
| --- | --- | --- |
| A turn completes | ✅ Turn complete | `notifyTurnComplete` |
| A turn fails, is blocked, or hits the token limit | ❌ / ⚠️ | `notifyTurnError` |
| A turn is cancelled | ⏹ Turn cancelled | `notifyTurnAborted` (off by default) |
| `ask_user_question` waits for an answer | ❓ Waiting for your input | `notifyQuestions` |
| A plan is presented for approval (`exit_plan_mode` / plan-review question) | 📋 Plan ready for approval | `notifyPlanReviews` |
| A tool approval waits for a human | 🔐 Approval needed | `notifyApprovals` |

Subagent sessions are ignored, and approvals that DSH decides instantly
(policy `never`/`always`) are not announced: the plugin waits 400 ms and
cancels the notification when the corresponding `approval/decided` event
arrives first. Question notifications use the same settle window, so a tool
call that fails before asking is not announced.

Messages are sent fire-and-forget. A Telegram outage is logged as a warning and
never fails, blocks, or delays an agent turn.

## Install

1. Install the package into your DSH profile:

   ```sh
   dsh plugin --profile web add link:/Users/ruben/dsh-plugins/dsh-telegram-notify
   ```

   (Use `add dsh-telegram-notify` instead once it is published.)

2. Enable the bundle by adding `"dsh-telegram-notify"` to `dsh.profile.bundles`
   in `~/.dsh/profiles/web/package.json`. The bundle patch inserts the
   `telegram-notify` row.

3. Configure the row in `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - id: telegram-notify
     config:
       chatId: "123456789"
       tokenRef: DSH_TELEGRAM_BOT_TOKEN_A87AE09EFB7C74512EE89279
   ```

   `tokenRef` defaults to `TELEGRAM_BOT_TOKEN`, so omit it when that is the
   reference that holds your bot token. `chatId` is required; while it is empty
   the plugin loads but stays disabled and logs one warning.

4. Restart the DSH app (`dsh web` or the desktop app).

### Finding the chat id

Send any message to your bot first, then ask a helper bot such as
`@userinfobot` for your numeric id. For a group, add the bot to the group and
use the group's negative id (for example `-1001234567890`) — quote it in YAML.
The plugin only sends; it does not consume `getUpdates`.

### Bot token

The plugin resolves the token through DSH credentials on every send, so
rotating the token does not need a restart. The default reference is
`TELEGRAM_BOT_TOKEN`. No token is written to logs or error messages.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `chatId` | `""` (disabled) | Target chat id. |
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | Credential reference holding the bot token. |
| `token` | unset | Literal token for one-off local runs. Prefer `tokenRef`. |
| `apiBase` | `https://api.telegram.org` | Bot API base URL; only change for a local Bot API server. |
| `silent` | `false` | Send without a notification sound. |
| `notifyTurnComplete` | `true` | Completed turns. |
| `notifyTurnError` | `true` | Failed/blocked/max-token turns. |
| `notifyTurnAborted` | `false` | Cancelled turns. |
| `notifyQuestions` | `true` | Pending user questions. |
| `notifyPlanReviews` | `true` | Plans waiting for approval. |
| `notifyApprovals` | `true` | Pending tool approvals. |

Messages are plain text (no parse mode), so model output cannot break
formatting or inject markup. Text is clipped to Telegram's 4096-character
limit; long plans and answers are truncated with `…`.

## Tests

```sh
pnpm install
pnpm test
```

The suite mounts the plugin with a fake Cordis context and a local HTTP stub
for `sendMessage`. It covers completed/error/cancelled turns, question and plan
formatting, approval settle-and-cancel behavior, subagent filtering, toggles,
truncation, and the HTTP 429 retry. No test touches Telegram.

## License

MIT
