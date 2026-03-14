import { getAgentByName } from "agents";
import { Bot, webhookCallback } from "grammy";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ScheduledWakePayload, TelegramTrigger } from "./types";
import { PersonalAgent, type PersonalAgentEnv } from "./personal-agent";

export type Env = PersonalAgentEnv & {
  BOT_TOKEN: string;
  OPENAI_API_KEY: string;
  ADMIN_API_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  PERSONAL_AGENT: DurableObjectNamespace<PersonalAgent>;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  const botInfo = safeParseBotInfo(c.env.BOT_INFO);
  const username = botInfo?.username ?? "unknown";

  return c.html(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ephememe Runtime</title>
    <style>
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        background: linear-gradient(180deg, #f6f0e8 0%, #e7dccd 100%);
        color: #241f1a;
      }
      main {
        max-width: 720px;
        margin: 0 auto;
        padding: 64px 24px;
      }
      h1 {
        font-size: 3rem;
        margin: 0 0 16px;
      }
      p {
        line-height: 1.6;
        font-size: 1.1rem;
      }
      .card {
        margin-top: 32px;
        padding: 24px;
        border: 1px solid rgba(36, 31, 26, 0.15);
        background: rgba(255, 252, 247, 0.72);
      }
      code {
        font-family: "SFMono-Regular", Consolas, monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Ephememe Runtime</h1>
      <p>Transport edge is online. Telegram ingress is routed into a per-user durable agent runtime.</p>
      <div class="card">
        <p><strong>Bot:</strong> <code>@${username}</code></p>
        <p><strong>Webhook:</strong> <code>POST /telegram/webhook</code></p>
        <p><strong>Health:</strong> <code>GET /health</code></p>
      </div>
    </main>
  </body>
</html>`);
});

app.get("/health", (c) => {
  const botInfo = safeParseBotInfo(c.env.BOT_INFO);
  return c.json({
    ok: true,
    service: "ephememe-runtime",
    botUsername: botInfo?.username ?? null,
  });
});

app.post("/telegram/webhook", async (c) => {
  assertWebhookSecret(c.req.header("x-telegram-bot-api-secret-token"), c.env);
  const bot = createWebhookBot(c.env, c.executionCtx);
  return webhookCallback(bot, "cloudflare-mod")(c.req.raw);
});

app.get("/admin/agents/:id", async (c) => {
  assertAdminAuth(c.req.header("authorization"), c.env);
  const agent = await getAgentByName<PersonalAgentEnv, PersonalAgent>(
    c.env.PERSONAL_AGENT,
    c.req.param("id"),
  );
  return c.json(await agent.getAdminSnapshot());
});

app.get("/admin/agents/:id/memory", async (c) => {
  assertAdminAuth(c.req.header("authorization"), c.env);
  const path = c.req.query("path") ?? "/memory";
  const agent = await getAgentByName<PersonalAgentEnv, PersonalAgent>(
    c.env.PERSONAL_AGENT,
    c.req.param("id"),
  );
  return c.json(await agent.readMemory(path));
});

app.post("/admin/agents/:id/wake", async (c) => {
  assertAdminAuth(c.req.header("authorization"), c.env);

  let body: unknown = {};
  try {
    if (c.req.header("content-type")?.includes("application/json")) {
      body = await c.req.json();
    }
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const payload = parseAdminWakePayload(body);
  const agent = await getAgentByName<PersonalAgentEnv, PersonalAgent>(
    c.env.PERSONAL_AGENT,
    c.req.param("id"),
  );
  return c.json(await agent.onScheduledWakeUp(payload));
});

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  console.error("Unhandled worker error", error);
  return c.json({ error: "internal server error" }, 500);
});

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export default worker;
export { PersonalAgent };

function createWebhookBot(
  env: Env,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
) {
  const bot = new Bot(env.BOT_TOKEN, {
    botInfo: safeParseBotInfo(env.BOT_INFO) as never,
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) {
      return;
    }

    const trigger: TelegramTrigger = {
      type: "telegram",
      updateId: ctx.update.update_id,
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      messageId: ctx.msg.message_id,
      text: ctx.msg.text,
      receivedAt: new Date().toISOString(),
      rawUpdate: ctx.update,
    };

    const agent = await getAgentByName<PersonalAgentEnv, PersonalAgent>(
      env.PERSONAL_AGENT,
      `tg-user:${trigger.userId}`,
    );

    executionCtx.waitUntil(
      agent.onTelegramUpdate(trigger).catch((error) => {
        console.error("Telegram handoff failed", error);
      }),
    );
  });

  bot.catch((error) => {
    console.error("grammY webhook error", error.error);
  });

  return bot;
}

function assertAdminAuth(authorization: string | undefined, env: Env): void {
  const expected = env.ADMIN_API_TOKEN;
  if (!expected || authorization !== `Bearer ${expected}`) {
    throw new HTTPException(401, {
      message: "unauthorized",
    });
  }
}

function assertWebhookSecret(secret: string | undefined, env: Env): void {
  if (
    env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    throw new HTTPException(401, {
      message: "invalid webhook secret",
    });
  }
}

function parseAdminWakePayload(body: unknown): ScheduledWakePayload {
  if (!body || typeof body !== "object") {
    return {
      type: "scheduled",
      kind: "maintenance",
      reason: "admin-wake",
      scheduledFor: new Date().toISOString(),
      source: "admin",
      allowSend: false,
    };
  }

  const value = body as Record<string, unknown>;
  return {
    type: "scheduled",
    kind: "maintenance",
    reason: typeof value.reason === "string" ? value.reason : "admin-wake",
    scheduledFor: new Date().toISOString(),
    source: "admin",
    notes: typeof value.notes === "string" ? value.notes : undefined,
    allowSend: false,
  };
}

function safeParseBotInfo(raw: string): { username?: string } | null {
  try {
    return JSON.parse(raw) as { username?: string };
  } catch {
    return null;
  }
}
