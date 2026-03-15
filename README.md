# Ephememe

A personal agent runtime on Cloudflare Workers. It talks to you through Telegram, remembers things by writing markdown files, and can wake itself up to reflect on what it knows.

## How it works

Each Telegram user gets their own [Durable Object](https://developers.cloudflare.com/durable-objects/) — an isolated runtime with its own filesystem and SQLite tables. Incoming work is first recorded in a per-user mailbox. The agent drains that mailbox one batch at a time: it reads memory files, thinks with a language model, replies if needed, updates memory, and goes back to sleep.

Memory is stored as plain files — `identity.md`, `preferences.md`, `open-loops.md`, `recent-turns.jsonl`. The agent reads and writes these files using tools available to the model. There are no embeddings, no vector stores. The serialization format for identity is natural language.

External pages can also be imported into the workspace under `/memory/imports`. Search results stay in model context; scraped pages become files the agent can inspect incrementally with `readFile` or `bash`.

The agent can schedule its own future wake-ups. Maintenance wakes are silent — the agent reviews recent conversations, updates its context files, and goes back to sleep. Outbound wakes deliver a message the user explicitly asked for. If follow-up Telegram messages arrive while the agent is already busy, they are queued and drained after the current run instead of being dropped. Multiple queued Telegram follow-ups are handled as one burst and produce one reply.

## Architecture

```
Telegram → Hono Worker → per-user PersonalAgent Durable Object
                              ├── AgentFS (file memory)
                              ├── SQLite (coordination, mailbox, logs)
                              ├── ToolLoopAgent (model reasoning)
                              └── Scheduled wakes (self-directed)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Memory layout

```
/memory/
  profile/
    identity.md              # Durable facts about the user
    preferences.md           # Learned preferences
    communication-style.md   # How to talk to this user
  derived/
    active-context.md        # Synthesized from recent activity
    recent-summary.md        # Auto-updated after each run
  journal/
    recent-turns.jsonl       # Conversation log (last 80 turns)
  inbox/
    open-loops.md            # Unresolved tasks and threads
  imports/
    <host>/*.md             # Scraped external pages saved for later inspection
```

## Tools available to the model

| Tool | Purpose |
|------|---------|
| `bash` | Shell commands inside `/memory` (no network, no JS/Python) |
| `readFile` | Read files from the workspace |
| `writeFile` | Write files to the workspace |
| `search` | Search the web for pages to inspect |
| `scrape` | Scrape a page into `/memory/imports/...` and return its saved path |
| `schedule` | Create, list, or cancel future wake-ups |
| `getTime` | Current time |

Mailbox drain priority is: queued Telegram bursts first, then outbound scheduled messages, then maintenance wakes.

## Endpoints

```
GET  /                              Landing page
GET  /health                        Health check
POST /telegram/webhook              Telegram webhook receiver
GET  /admin/agents/:id              Agent state inspection (auth required)
GET  /admin/agents/:id/memory       Memory file/directory inspection (auth required)
POST /admin/agents/:id/wake         Enqueue maintenance wake (auth required)
```

## Setup

### Secrets

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put FIRECRAWL_API_KEY
npx wrangler secret put ADMIN_API_TOKEN
npx wrangler secret put BOT_INFO              # JSON from Telegram getMe
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # optional
```

### Telegram webhook

```bash
curl -X POST \
  "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<WORKER_URL>/telegram/webhook"
```

### Local development

```bash
npm run dev        # Start local Wrangler dev server
npm run deploy     # Deploy to Cloudflare
npm run cf-typegen # Regenerate worker types
npm test -- --run  # Run tests
```

## Tech stack

| Component | Role |
|-----------|------|
| [Hono](https://hono.dev) | Worker routing |
| [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) | Durable Object runtime + scheduling |
| [AgentFS](https://www.npmjs.com/package/agentfs-sdk) | Durable filesystem |
| [just-bash](https://www.npmjs.com/package/just-bash) | Shell over AgentFS |
| [AI SDK](https://sdk.vercel.ai) | Model tool loop |
| [grammY](https://grammy.dev) | Telegram bot framework |
