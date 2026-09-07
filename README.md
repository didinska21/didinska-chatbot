# didinska-chatbot

Private Telegram coding assistant powered by AgentRouter and deployed on Cloudflare Workers.

## What it does

- Telegram chatbot for coding
- Claude and other AgentRouter-compatible models by manual model ID
- Custom base URL, changeable at runtime from Telegram (no redeploy needed)
- Conversation context stored in Cloudflare D1
- Private Telegram user whitelist
- `/model <model-id>`
- `/models`
- `/seturl <url>` — set base URL globally (applies to all models/projects)
- `/geturl` — show current base URL
- `/project <name>`
- `/clear`
- `/test`
- `/id`
- `/help`
- MQL5-friendly coding system prompt

## Important architecture

- Base URL defaults to `https://agentrouter.org` and can be changed anytime via `/seturl` (stored in D1, applies globally, no redeploy).
- Claude models call `<base_url>/v1/messages` (Anthropic Messages API format).
- Other models call `<base_url>/v1/chat/completions` (OpenAI-compatible format).
- Telegram sends updates to the Worker through a webhook, protected by `TELEGRAM_WEBHOOK_SECRET`. The secret is now mandatory — the Worker rejects all requests if it isn't set.
- API keys are Cloudflare Secrets, not committed to GitHub.

## Deploy from GitHub to Cloudflare Workers

### 1. Create the D1 database

In Cloudflare Dashboard:
Workers & Pages → D1 SQL database → Create database.

Name it:

`didinska-chatbot-db`

Copy its database ID and replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.toml`.

Run the migration from your machine:

```bash
npm install
npx wrangler d1 migrations apply didinska-chatbot-db --remote
```

This applies both `0001_init.sql` (conversations table) and `0002_settings.sql` (global settings table, used by `/seturl`).

If you use Cloudflare's Git integration, the database must exist before deployment and the `database_id` must be correct.

### 2. Connect GitHub

Push this folder to a GitHub repository, for example:

`didinska-chatbot`

Then in Cloudflare:
Workers & Pages → Create application → Workers → Import from Git / GitHub.

Build/deploy command:

```text
npx wrangler deploy
```

The repository already contains `wrangler.toml`.

### 3. Add Cloudflare secrets

In Worker → Settings → Variables and Secrets, add:

```text
TELEGRAM_BOT_TOKEN
AGENTROUTER_API_KEY
TELEGRAM_ALLOWED_USER_ID
TELEGRAM_WEBHOOK_SECRET
```

Use **Secret** for all four.

`TELEGRAM_ALLOWED_USER_ID` is your numeric Telegram user ID.

`TELEGRAM_WEBHOOK_SECRET` should be a random string, for example 32+ random characters.

### 4. Get the Worker URL

After deployment you will have something like:

`https://didinska-chatbot.<your-subdomain>.workers.dev`

Do not hard-code the example URL; use the actual URL shown by Cloudflare.

### 5. Set Telegram webhook

Replace the placeholders and run this once:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_WORKER_URL","secret_token":"YOUR_TELEGRAM_WEBHOOK_SECRET","drop_pending_updates":true}'
```

Then verify:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Never commit the real token or secret to GitHub.

## First use

Send the bot:

```text
/start
```

Then:

```text
/model claude-opus-5
/project XAUUSD_EA
```

Now send normal coding requests.

## Security

The bot checks `TELEGRAM_ALLOWED_USER_ID` before AI requests. API keys stay in Cloudflare Secrets. The webhook can also verify Telegram's `X-Telegram-Bot-Api-Secret-Token` header.

## Local development

Create `.dev.vars` (never commit it):

```text
TELEGRAM_BOT_TOKEN=...
AGENTROUTER_API_KEY=...
TELEGRAM_ALLOWED_USER_ID=...
TELEGRAM_WEBHOOK_SECRET=...
```

Then:

```bash
npm install
npx wrangler dev
```

For D1 local development, use a local D1 database or point the Worker at a test database. Production should use the remote D1 database.
