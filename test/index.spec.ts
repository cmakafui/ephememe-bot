import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  resetRuntimeOverrides,
  setRuntimeOverrides,
} from "../src/runtime-overrides";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Ephememe runtime", () => {
  let agentCounter = 0;

  beforeEach(() => {
    agentCounter += 1;
    Object.assign(env as Record<string, unknown>, {
      BOT_TOKEN: "test-bot-token",
      OPENAI_API_KEY: "test-openai-key",
      FIRECRAWL_API_KEY: "test-firecrawl-key",
      ADMIN_API_TOKEN: "test-admin-token",
      TELEGRAM_WEBHOOK_SECRET: undefined,
    });
    resetRuntimeOverrides();
  });

  it("returns health status", async () => {
    const response = await dispatch(new IncomingRequest("https://example.com/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "ephememe-runtime",
      botUsername: "ephememe_bot",
    });
  });

  it("rejects invalid telegram payloads", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nope: true }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "missing numeric update_id",
    });
  });

  it("rejects admin requests without a valid bearer token", async () => {
    const { agentId } = nextIdentity();
    const response = await dispatch(
      new IncomingRequest(`https://example.com/admin/agents/${encodeURIComponent(agentId)}`),
    );

    expect(response.status).toBe(401);
  });

  it("processes a private telegram message, seeds memory, and sends one reply", async () => {
    const { agentId, userId } = nextIdentity();
    const outboundMessages: Array<{ chatId: number; text: string }> = [];
    const model = new MockLanguageModelV3({
      doGenerate: [textResult("Hello from the durable agent.")],
    });

    setRuntimeOverrides({
      modelFactory: () => model,
      telegramSender: async ({ chatId, text }) => {
        outboundMessages.push({ chatId, text });
        return { messageId: 9001 };
      },
    });

    const webhookResponse = await dispatch(
      new IncomingRequest("https://example.com/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeTelegramUpdate(userId, 1001, "hello there")),
      }),
    );

    expect(webhookResponse.status).toBe(200);
    expect(await webhookResponse.text()).toBe("ok");

    const snapshotResponse = await dispatch(
      new IncomingRequest(
        `https://example.com/admin/agents/${encodeURIComponent(agentId)}`,
        {
          headers: {
            authorization: "Bearer test-admin-token",
          },
        },
      ),
    );

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(outboundMessages).toEqual([
      { chatId: 4242, text: "Hello from the durable agent." },
    ]);

    const snapshot = (await snapshotResponse.json()) as {
      contactLog: Array<{ text: string }>;
      recentRuns: Array<{ outcome: string }>;
    };
    expect(snapshot.contactLog[0]?.text).toBe("Hello from the durable agent.");
    expect(snapshot.recentRuns[0]?.outcome).toBe("replied");

    const memoryResponse = await dispatch(
      new IncomingRequest(
        `https://example.com/admin/agents/${encodeURIComponent(
          agentId,
        )}/memory?path=${encodeURIComponent("/memory")}`,
        {
          headers: {
            authorization: "Bearer test-admin-token",
          },
        },
      ),
    );

    expect(await memoryResponse.json()).toMatchObject({
      path: "/memory",
      type: "directory",
      entries: expect.arrayContaining(["derived", "inbox", "profile"]),
    });
  });

  it("deduplicates telegram updates", async () => {
    const { agentId, userId } = nextIdentity();
    const outboundMessages: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: [textResult("Only once.")],
    });

    setRuntimeOverrides({
      modelFactory: () => model,
      telegramSender: async ({ text }) => {
        outboundMessages.push(text);
        return { messageId: 9002 };
      },
    });

    const update = makeTelegramUpdate(userId, 1002, "dedupe me");

    await dispatch(
      new IncomingRequest("https://example.com/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      }),
    );

    await dispatch(
      new IncomingRequest("https://example.com/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      }),
    );

    const snapshotResponse = await dispatch(
      new IncomingRequest(
        `https://example.com/admin/agents/${encodeURIComponent(agentId)}`,
        {
          headers: {
            authorization: "Bearer test-admin-token",
          },
        },
      ),
    );

    const snapshot = (await snapshotResponse.json()) as {
      contactLog: Array<{ text: string }>;
      recentRuns: Array<{ outcome: string }>;
    };

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(outboundMessages).toEqual(["Only once."]);
    expect(snapshot.contactLog).toHaveLength(1);
    expect(snapshot.recentRuns[0]?.outcome).toBe("duplicate-update");
  });

  it("handles a silent admin wake that writes memory and schedules a follow-up", async () => {
    const { agentId } = nextIdentity();
    const outboundMessages: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallResult("writeFile", {
          path: "/memory/derived/active-context.md",
          content: "# Active Context\n\nMaintenance updated this summary.",
        }),
        toolCallResult("schedule", {
          action: "create",
          when: "3600",
          payload: { notes: "revisit active context" },
        }),
        textResult("[[silence]]"),
      ],
    });

    setRuntimeOverrides({
      modelFactory: () => model,
      telegramSender: async ({ text }) => {
        outboundMessages.push(text);
        return { messageId: 9003 };
      },
    });

    const wakeResponse = await dispatch(
      new IncomingRequest(
        `https://example.com/admin/agents/${encodeURIComponent(agentId)}/wake`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-admin-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            reason: "test-maintenance",
            notes: "refresh derived context",
          }),
        },
      ),
    );

    expect(wakeResponse.status).toBe(200);
    expect(await wakeResponse.json()).toMatchObject({
      blocked: false,
      outcome: "silent",
      replySent: false,
    });

    const snapshotResponse = await dispatch(
      new IncomingRequest(
        `https://example.com/admin/agents/${encodeURIComponent(agentId)}`,
        {
          headers: {
            authorization: "Bearer test-admin-token",
          },
        },
      ),
    );
    const snapshot = (await snapshotResponse.json()) as {
      schedules: Array<{ callback: string }>;
      contactLog: unknown[];
      recentRuns: Array<{ outcome: string }>;
    };

    expect(outboundMessages).toEqual([]);
    expect(snapshot.schedules).toHaveLength(1);
    expect(snapshot.schedules[0]?.callback).toBe("onScheduledWakeUp");
    expect(snapshot.contactLog).toHaveLength(0);
    expect(snapshot.recentRuns[0]?.outcome).toBe("silent");

    const fileResponse = await dispatch(
      new IncomingRequest(
        `https://example.com/admin/agents/${encodeURIComponent(
          agentId,
        )}/memory?path=${encodeURIComponent("/memory/derived/active-context.md")}`,
        {
          headers: {
            authorization: "Bearer test-admin-token",
          },
        },
      ),
    );

    expect(await fileResponse.json()).toMatchObject({
      path: "/memory/derived/active-context.md",
      type: "file",
      content: "# Active Context\n\nMaintenance updated this summary.",
    });
  });

  function nextIdentity() {
    const userId = 10_000 + agentCounter;
    return {
      userId,
      agentId: `tg-user:${userId}`,
    };
  }
});

async function dispatch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function makeTelegramUpdate(
  userId: number,
  updateId: number,
  text: string,
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 10,
      text,
      chat: {
        id: 4242,
        type: "private",
      },
      from: {
        id: userId,
        is_bot: false,
        first_name: "Test",
      },
    },
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: {
      unified: "stop" as const,
      raw: "stop",
    },
    usage: usage(),
    warnings: [],
  };
}

function toolCallResult(toolName: string, input: Record<string, unknown>) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `${toolName}-call`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: {
      unified: "tool-calls" as const,
      raw: "tool-calls",
    },
    usage: usage(),
    warnings: [],
  };
}

function usage() {
  return {
    inputTokens: {
      total: 10,
      noCache: 10,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: 10,
      text: 10,
      reasoning: undefined,
    },
  };
}
