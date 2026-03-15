# Architecture

## In one sentence

Hono receives Telegram webhooks, routes each private user to a per-user `PersonalAgent` Durable Object, which owns memory, judgment, and self-directed scheduling.

## Product invariants

1. A private inbound message should usually get a reply.
2. The bot should feel alive while thinking (typing indicator).
3. Durable memory should help continuity without complex routing.
4. Scheduled work should not degrade the chat experience.
5. The system should stay small enough to debug from traces and admin inspection.

If a design choice conflicts with these, the design choice loses.

## Components

### Hono Worker (`src/index.ts`)

Transport and control only:

- Receives `POST /telegram/webhook`, validates, dispatches via grammY
- Ignores non-private chats
- Resolves per-user agent with `getAgentByName("tg-user:<userId>")`
- Hands off work with `executionCtx.waitUntil()`
- Exposes authenticated admin routes under `/admin/agents/:id`

### PersonalAgent Durable Object (`src/personal-agent.ts`)

The stateful runtime. One instance per user.

- Deduplicates Telegram `update_id`
- Seeds and maintains the `/memory` filesystem
- Runs `ToolLoopAgent` inside `keepAliveWhile()`
- Decides whether to reply (inbound) or stay silent (maintenance wakes)
- Manages scheduling via the Agents SDK
- Exposes admin inspection methods

## Trigger types

- **Telegram** — inbound private text messages. May produce a reply.
- **Scheduled maintenance** — silent wakes where the agent reflects on recent activity, updates context files, prunes stale open loops, and ensures the next nightly wake is scheduled.
- **Scheduled outbound** — delivers a message the user explicitly asked to receive later.
- **Admin wake** — manual maintenance trigger via the admin API.

## Runtime loop

1. Receive trigger
2. Gate checks (dedupe, lease, staleness)
3. Ensure memory spine exists
4. Build manifest from spine files + trigger data + recent turns
5. Run `ToolLoopAgent` with tools: `bash`, `readFile`, `writeFile`, `search`, `scrape`, `schedule`, `getTime`
6. Persist side effects (memory writes, turn log, summary)
7. Optionally send Telegram reply
8. Return to idle

## Gate behavior

- Reject duplicate Telegram `update_id`
- Reject if another run lease is active
- Reject stale scheduled wakes (>30 minutes old)
- Ignore non-private Telegram chats

Gate state lives in SQLite tables inside the Durable Object.

## Durable state

### SQLite coordination tables

- `coordination_state` — last inbound/outbound times, active run lease
- `processed_updates` — Telegram update deduplication
- `run_log` — audit trail of all runs
- `contact_log` — record of all outbound Telegram messages

### Filesystem memory

Stored in AgentFS. Seeded on first use:

```
/memory/profile/identity.md
/memory/profile/preferences.md
/memory/profile/communication-style.md
/memory/derived/active-context.md
/memory/derived/recent-summary.md
/memory/journal/recent-turns.jsonl
/memory/inbox/open-loops.md
```

The model can create additional files and directories. The spine above is the guaranteed minimum.

When the agent imports external material, it stores it under `/memory/imports/<host>/...`. These files are working-set artifacts for later inspection, not durable user memory by default.

### Memory loop

After each run:
1. Append turn records to `recent-turns.jsonl`
2. Include only the last 12 turns in the next prompt (80 stored max)
3. Refresh `recent-summary.md`

For explicit web lookup requests:
1. `search` returns compact results directly in context
2. `scrape` saves full page content into `/memory/imports/...`
3. The agent can revisit imported files with `readFile` or `bash` without reloading whole pages into prompt context

During maintenance wakes, the agent also:
1. Reviews `recent-turns.jsonl` for patterns
2. Rewrites `active-context.md` with synthesized observations
3. Prunes resolved items from `open-loops.md`
4. Backfills `identity.md` and `preferences.md` if sparse
5. Ensures a nightly maintenance wake is scheduled

## Scheduling

- Agents SDK `schedule()` / `getSchedules()` / `cancelSchedule()`
- Two kinds: `maintenance` (silent) and `outbound-message` (sends stored text)
- Same-kind schedules are collapsed — new one replaces old
- Outbound schedules require explicit `chatId` and message text

## Telegram integration

- grammY for both inbound webhook parsing and outbound API calls
- `typing` action sent before model deliberation
- Fallback replies for greetings and empty model output
- `[[silence]]` token allows the model to opt out of replying

## Admin surface

Requires `Authorization: Bearer <ADMIN_API_TOKEN>`.

- `GET /admin/agents/:id` — coordination state, schedules, recent runs, contact log
- `GET /admin/agents/:id/memory?path=...` — read memory files/directories
- `POST /admin/agents/:id/wake` — trigger a maintenance wake

## Explicit deferrals

Not in v1:

- Skills system / remote skill fetch
- JavaScript execution in the sandbox
- Observability integrations
- Broad autonomous outbound messaging
- Quiet-hours / cooldown policies
- Capability registries

These are worth adding only after the conversation loop is strong.
