import { Agent, type AgentContext } from "agents";
import { stepCountIs, ToolLoopAgent, tool } from "ai";
import path from "node:path";
import { z } from "zod";
import { AgentFS, type CloudflareStorage } from "agentfs-sdk/cloudflare";
import { Bash } from "just-bash";
import {
  createAgentModel,
  sendTelegramChatAction,
  sendTelegramMessage,
  type RuntimeEnv,
} from "./runtime-overrides";
import { AgentFsBashAdapter } from "./agentfs-bash-adapter";
import type {
  AgentAdminSnapshot,
  CoordinationState,
  MemoryInspectionResult,
  ScheduledWakeKind,
  ScheduledWakePayload,
  SessionTrigger,
  TelegramTrigger,
  TriggerType,
} from "./types";

const MEMORY_ROOT = "/memory";
const SCHEDULE_STALE_AFTER_MS = 30 * 60 * 1000;
const RUN_LEASE_MS = 2 * 60 * 1000;
const SILENCE_TOKEN = "[[silence]]";

const SPINE_FILES: Record<string, string> = {
  "/memory/profile/identity.md": [
    "# Identity",
    "",
    "The user's profile is still sparse.",
    "Capture durable facts here when they remain relevant over time.",
  ].join("\n"),
  "/memory/profile/preferences.md": [
    "# Preferences",
    "",
    "- Communication preferences are not known yet.",
    "- Learn from repeated patterns rather than single interactions.",
  ].join("\n"),
  "/memory/profile/communication-style.md": [
    "# Communication Style",
    "",
    "- Be concise and clear.",
    "- Avoid being annoying or overly eager.",
  ].join("\n"),
  "/memory/derived/active-context.md": [
    "# Active Context",
    "",
    "No durable context has been summarized yet.",
  ].join("\n"),
  "/memory/derived/recent-summary.md": [
    "# Recent Summary",
    "",
    "No recent interactions have been summarized yet.",
  ].join("\n"),
  "/memory/journal/recent-turns.jsonl": "",
  "/memory/inbox/open-loops.md": [
    "# Open Loops",
    "",
    "No open loops recorded yet.",
  ].join("\n"),
};
const MANIFEST_SPINE_PATHS = [
  "/memory/profile/identity.md",
  "/memory/profile/preferences.md",
  "/memory/profile/communication-style.md",
  "/memory/derived/active-context.md",
  "/memory/derived/recent-summary.md",
  "/memory/inbox/open-loops.md",
] as const;
const MAX_RECENT_TURNS_IN_PROMPT = 12;
const MAX_RECENT_TURNS_STORED = 80;

export type PersonalAgentEnv = Cloudflare.Env & RuntimeEnv;

type SessionResult = {
  blocked: boolean;
  outcome: string;
  replySent: boolean;
};

export class PersonalAgent extends Agent<PersonalAgentEnv> {
  private fs: AgentFS;
  private bashPromise?: Promise<Bash>;

  constructor(ctx: AgentContext, env: PersonalAgentEnv) {
    super(ctx, env);
    this.fs = AgentFS.create(ctx.storage as unknown as CloudflareStorage);
    this.initializeSchema();
  }

  async onTelegramUpdate(trigger: TelegramTrigger): Promise<SessionResult> {
    return this.runSession(trigger);
  }

  async onScheduledWakeUp(
    payload: ScheduledWakePayload,
  ): Promise<SessionResult> {
    return this.runSession(payload);
  }

  async getAdminSnapshot(): Promise<AgentAdminSnapshot> {
    const coordination = this.getCoordinationState();
    const recentRuns = this.sql<{
      id: number;
      trigger_type: TriggerType;
      started_at: string;
      finished_at: string | null;
      reply_sent: number;
      outcome: string;
      error_text: string | null;
    }>`
      SELECT id, trigger_type, started_at, finished_at, reply_sent, outcome, error_text
      FROM run_log
      ORDER BY id DESC
      LIMIT 20
    `.map((row) => ({
      id: row.id,
      triggerType: row.trigger_type,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      replySent: row.reply_sent,
      outcome: row.outcome,
      error: row.error_text,
    }));

    const contactLog = this.sql<{
      id: number;
      chat_id: string;
      sent_at: string;
      text: string;
      trigger_type: TriggerType;
    }>`
      SELECT id, chat_id, sent_at, text, trigger_type
      FROM contact_log
      ORDER BY id DESC
      LIMIT 20
    `.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      sentAt: row.sent_at,
      text: row.text,
      triggerType: row.trigger_type,
    }));

    return {
      agentId: this.getAgentInstanceName(),
      coordination,
      schedules: this.getSchedules(),
      recentRuns,
      contactLog,
    };
  }

  async readMemory(path: string): Promise<MemoryInspectionResult> {
    await this.ensureMemorySeeded();

    const normalizedPath = normalizeMemoryPath(path);
    const stats = await this.fs.stat(normalizedPath);

    if (stats.isDirectory()) {
      return {
        path: normalizedPath,
        type: "directory",
        entries: await this.fs.readdir(normalizedPath),
      };
    }

    return {
      path: normalizedPath,
      type: "file",
      content: await this.fs.readFile(normalizedPath, "utf8"),
    };
  }

  private async runSession(trigger: SessionTrigger): Promise<SessionResult> {
    await this.ensureMemorySeeded();

    const runId = this.insertRunLog(trigger.type);
    let replySent = false;
    let leaseAcquired = false;

    try {
      const gate = this.checkGate(trigger);
      if (gate.blocked) {
        this.finishRunLog(runId, {
          replySent: false,
          outcome: gate.reason,
          errorText: null,
        });
        return {
          blocked: true,
          outcome: gate.reason,
          replySent: false,
        };
      }

      leaseAcquired = true;
      if (trigger.type === "scheduled" && isScheduledOutbound(trigger)) {
        await sendTelegramMessage({
          token: this.env.BOT_TOKEN,
          chatId: trigger.chatId,
          text: trigger.outboundText,
        });
        replySent = true;
        this.recordOutbound(trigger.chatId, trigger.outboundText, trigger.type);
        await this.refreshMemoryLoop(trigger, trigger.outboundText, true);
        this.finishRunLog(runId, {
          replySent: true,
          outcome: "replied",
          errorText: null,
        });

        return {
          blocked: false,
          outcome: "replied",
          replySent: true,
        };
      }

      if (trigger.type === "telegram") {
        try {
          await sendTelegramChatAction({
            token: this.env.BOT_TOKEN,
            chatId: trigger.chatId,
            action: "typing",
          });
        } catch (error) {
          console.warn("Failed to send Telegram typing action", error);
        }
      }

      const bash = await this.getBash();
      const deliberationAgent = new ToolLoopAgent({
        model: createAgentModel(this.env),
        instructions: buildSystemInstructions(trigger),
        tools: {
          bash: this.makeBashTool(bash),
          readFile: this.makeReadFileTool(),
          writeFile: this.makeWriteFileTool(),
          schedule: this.makeScheduleTool(trigger),
          getTime: this.makeGetTimeTool(),
        },
        stopWhen: stepCountIs(12),
      });

      const result = await this.keepAliveWhile(async () =>
        deliberationAgent.generate({
          prompt: await this.buildManifest(trigger),
        }),
      );

      const finalText =
        trigger.type === "telegram"
          ? normalizeTelegramReply(result.text, trigger.text)
          : result.text.trim();

      if (trigger.type === "telegram" && shouldSendReply(finalText)) {
        await sendTelegramMessage({
          token: this.env.BOT_TOKEN,
          chatId: trigger.chatId,
          text: finalText,
          replyToMessageId: trigger.messageId,
        });
        replySent = true;
        this.recordOutbound(trigger.chatId, finalText, trigger.type);
      }

      await this.refreshMemoryLoop(trigger, finalText, replySent);

      if (trigger.type === "telegram") {
        this.markProcessedUpdateDone(trigger.updateId);
      }

      this.finishRunLog(runId, {
        replySent,
        outcome: replySent ? "replied" : "silent",
        errorText: null,
      });

      return {
        blocked: false,
        outcome: replySent ? "replied" : "silent",
        replySent,
      };
    } catch (error) {
      if (trigger.type === "telegram") {
        this.deleteProcessedUpdate(trigger.updateId);
      }

      this.finishRunLog(runId, {
        replySent,
        outcome: "error",
        errorText: toErrorMessage(error),
      });

      throw error;
    } finally {
      if (leaseAcquired) {
        this.releaseRunLease();
      }
    }
  }

  private initializeSchema(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS coordination_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_inbound_at TEXT,
        last_outbound_at TEXT,
        active_run_lease_until TEXT
      )
    `;

    this.sql`
      INSERT OR IGNORE INTO coordination_state (
        id,
        last_inbound_at,
        last_outbound_at,
        active_run_lease_until
      )
      VALUES (1, NULL, NULL, NULL)
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS processed_updates (
        update_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        completed_at TEXT
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS run_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        reply_sent INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL,
        error_text TEXT
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS contact_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        text TEXT NOT NULL,
        trigger_type TEXT NOT NULL
      )
    `;
  }

  private getCoordinationState(): CoordinationState {
    const [row] = this.sql<{
      last_inbound_at: string | null;
      last_outbound_at: string | null;
      active_run_lease_until: string | null;
    }>`
      SELECT last_inbound_at, last_outbound_at, active_run_lease_until
      FROM coordination_state
      WHERE id = 1
    `;

    return {
      lastInboundAt: row?.last_inbound_at ?? null,
      lastOutboundAt: row?.last_outbound_at ?? null,
      activeRunLeaseUntil: row?.active_run_lease_until ?? null,
    };
  }

  private checkGate(
    trigger: SessionTrigger,
  ): { blocked: true; reason: string } | { blocked: false } {
    const now = new Date();

    if (trigger.type === "telegram") {
      const existing = this.sql<{ update_id: number }>`
        SELECT update_id
        FROM processed_updates
        WHERE update_id = ${trigger.updateId}
        LIMIT 1
      `;
      if (existing.length > 0) {
        return { blocked: true, reason: "duplicate-update" };
      }
    }

    if (
      trigger.type === "scheduled" &&
      Date.now() - Date.parse(trigger.scheduledFor) > SCHEDULE_STALE_AFTER_MS
    ) {
      return { blocked: true, reason: "stale-scheduled-wake" };
    }

    const coordination = this.getCoordinationState();
    if (
      coordination.activeRunLeaseUntil &&
      Date.parse(coordination.activeRunLeaseUntil) > Date.now()
    ) {
      return { blocked: true, reason: "run-already-active" };
    }

    this.sql`
      UPDATE coordination_state
      SET active_run_lease_until = ${new Date(
        now.getTime() + RUN_LEASE_MS,
      ).toISOString()}
      WHERE id = 1
    `;

    if (trigger.type === "telegram") {
      this.sql`
        INSERT INTO processed_updates (
          update_id,
          status,
          first_seen_at,
          completed_at
        )
        VALUES (
          ${trigger.updateId},
          ${"processing"},
          ${trigger.receivedAt},
          NULL
        )
      `;

      this.sql`
        UPDATE coordination_state
        SET last_inbound_at = ${trigger.receivedAt}
        WHERE id = 1
      `;
    }

    return { blocked: false };
  }

  private releaseRunLease(): void {
    this.sql`
      UPDATE coordination_state
      SET active_run_lease_until = NULL
      WHERE id = 1
    `;
  }

  private deleteProcessedUpdate(updateId: number): void {
    this.sql`
      DELETE FROM processed_updates
      WHERE update_id = ${updateId}
    `;
  }

  private markProcessedUpdateDone(updateId: number): void {
    this.sql`
      UPDATE processed_updates
      SET status = ${"done"}, completed_at = ${new Date().toISOString()}
      WHERE update_id = ${updateId}
    `;
  }

  private insertRunLog(triggerType: TriggerType): number {
    const startedAt = new Date().toISOString();
    this.sql`
      INSERT INTO run_log (
        trigger_type,
        started_at,
        finished_at,
        reply_sent,
        outcome,
        error_text
      )
      VALUES (
        ${triggerType},
        ${startedAt},
        NULL,
        0,
        ${"running"},
        NULL
      )
    `;

    const [row] = this.sql<{ id: number }>`
      SELECT id
      FROM run_log
      ORDER BY id DESC
      LIMIT 1
    `;

    return row.id;
  }

  private finishRunLog(
    runId: number,
    input: {
      replySent: boolean;
      outcome: string;
      errorText: string | null;
    },
  ): void {
    this.sql`
      UPDATE run_log
      SET
        finished_at = ${new Date().toISOString()},
        reply_sent = ${input.replySent ? 1 : 0},
        outcome = ${input.outcome},
        error_text = ${input.errorText}
      WHERE id = ${runId}
    `;
  }

  private recordOutbound(
    chatId: number,
    text: string,
    triggerType: TriggerType,
  ): void {
    const sentAt = new Date().toISOString();
    this.sql`
      INSERT INTO contact_log (
        chat_id,
        sent_at,
        text,
        trigger_type
      )
      VALUES (
        ${String(chatId)},
        ${sentAt},
        ${text},
        ${triggerType}
      )
    `;

    this.sql`
      UPDATE coordination_state
      SET last_outbound_at = ${sentAt}
      WHERE id = 1
    `;
  }

  private async ensureMemorySeeded(): Promise<void> {
    for (const [path, content] of Object.entries(SPINE_FILES)) {
      const exists = await this.pathExists(path);
      if (!exists) {
        await this.fs.writeFile(path, content, "utf8");
      }
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await this.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async buildManifest(trigger: SessionTrigger): Promise<string> {
    const sections = await Promise.all(
      MANIFEST_SPINE_PATHS.map(async (path) => {
        const content = await this.fs.readFile(path, "utf8");
        return [`FILE: ${path}`, content.trim()].join("\n");
      }),
    );
    const recentTurns = await this.getRecentTurnsForPrompt();

    return [
      `Current time: ${new Date().toISOString()}`,
      `Trigger type: ${trigger.type}`,
      trigger.type === "telegram"
        ? [
            `User ID: ${trigger.userId}`,
            `Chat ID: ${trigger.chatId}`,
            `Received at: ${trigger.receivedAt}`,
            `Incoming text: ${trigger.text}`,
          ].join("\n")
        : [
            `Reason: ${trigger.reason}`,
            `Scheduled for: ${trigger.scheduledFor}`,
            `Source: ${trigger.source}`,
            `Notes: ${trigger.notes ?? ""}`,
            "Outbound Telegram replies are disabled for this wake-up.",
          ].join("\n"),
      "",
      "Memory spine:",
      ...sections,
      "",
      "Recent turns:",
      recentTurns.length > 0 ? recentTurns.join("\n") : "No recent turns recorded yet.",
    ].join("\n\n");
  }

  private async getBash(): Promise<Bash> {
    if (!this.bashPromise) {
      this.bashPromise = Promise.resolve(
        new Bash({
          fs: new AgentFsBashAdapter(this.fs),
          cwd: MEMORY_ROOT,
          javascript: false,
          python: false,
        }),
      );
    }

    return this.bashPromise;
  }

  private makeBashTool(bash: Bash) {
    return tool({
      description:
        "Execute a bash command inside the durable /memory workspace.",
      inputSchema: z.object({
        command: z.string(),
      }),
      execute: async ({ command }) => {
        const result = await bash.exec(`cd "${MEMORY_ROOT}" && ${command}`);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      },
    });
  }

  private makeReadFileTool() {
    return tool({
      description: "Read a UTF-8 file from the durable workspace.",
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async ({ path }) => ({
        content: await this.fs.readFile(resolveWorkspacePath(path), "utf8"),
      }),
    });
  }

  private makeWriteFileTool() {
    return tool({
      description: "Write a UTF-8 file into the durable workspace.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path, content }) => {
        await this.fs.writeFile(resolveWorkspacePath(path), content, "utf8");
        return { success: true };
      },
    });
  }

  private makeScheduleTool(trigger: SessionTrigger) {
    return tool({
      description:
        "Create, list, or cancel future wake-ups for this agent. Supports silent maintenance wakes and explicit outbound Telegram messages requested by the user.",
      inputSchema: z.object({
        action: z.enum(["create", "list", "cancel"]),
        when: z.string().optional(),
        id: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ action, when, id, payload }) => {
        if (action === "list") {
          return this.getSchedules();
        }

        if (action === "cancel") {
          if (!id) {
            throw new Error("schedule cancel requires an id");
          }
          return { cancelled: await this.cancelSchedule(id) };
        }

        if (!when) {
          throw new Error("schedule create requires a when value");
        }

        const kind = normalizeScheduledWakeKind(payload?.kind);
        const outboundText =
          typeof payload?.message === "string" ? payload.message.trim() : undefined;

        for (const schedule of this.getSchedules()) {
          if (schedule.callback !== "onScheduledWakeUp") {
            continue;
          }
          const scheduledPayload = schedule.payload as
            | Partial<ScheduledWakePayload>
            | undefined;
          const sameKind =
            (scheduledPayload?.kind ?? "maintenance") === kind;
          if (sameKind) {
            await this.cancelSchedule(schedule.id);
          }
        }

        const normalizedPayload: ScheduledWakePayload = {
          type: "scheduled",
          kind,
          reason: kind === "outbound-message" ? "outbound-message" : "maintenance",
          scheduledFor:
            parseWhen(when) instanceof Date
              ? (parseWhen(when) as Date).toISOString()
              : String(when),
          source: "agent",
          notes:
            typeof payload?.notes === "string" ? String(payload.notes) : undefined,
          allowSend: kind === "outbound-message",
          chatId:
            kind === "outbound-message" && trigger.type === "telegram"
              ? trigger.chatId
              : undefined,
          outboundText:
            kind === "outbound-message" ? outboundText : undefined,
          createdFromMessageId:
            kind === "outbound-message" && trigger.type === "telegram"
              ? trigger.messageId
              : undefined,
          userId:
            kind === "outbound-message" && trigger.type === "telegram"
              ? trigger.userId
              : undefined,
        };

        if (
          normalizedPayload.kind === "outbound-message" &&
          (!normalizedPayload.chatId || !normalizedPayload.outboundText)
        ) {
          throw new Error(
            "outbound-message schedules require a Telegram chat and message text",
          );
        }

        return this.schedule(
          parseWhen(when),
          "onScheduledWakeUp",
          normalizedPayload,
        );
      },
    });
  }

  private makeGetTimeTool() {
    return tool({
      description:
        "Get the current time context for this workspace and runtime session.",
      inputSchema: z.object({}),
      execute: async () => ({
        now: new Date().toISOString(),
        timezone: "Europe/Helsinki",
      }),
    });
  }

  private getAgentInstanceName(): string {
    const candidate = this as unknown as { name?: string };
    return candidate.name ?? "unknown";
  }

  private async refreshMemoryLoop(
    trigger: SessionTrigger,
    finalText: string,
    replySent: boolean,
  ): Promise<void> {
    await this.appendTurnRecords(trigger, finalText, replySent);
    await this.writeRecentSummary(trigger, finalText, replySent);
  }

  private async appendTurnRecords(
    trigger: SessionTrigger,
    finalText: string,
    replySent: boolean,
  ): Promise<void> {
    if (trigger.type !== "telegram") {
      if (trigger.type === "scheduled" && replySent && isScheduledOutbound(trigger)) {
        const existing = await this.fs.readFile(
          "/memory/journal/recent-turns.jsonl",
          "utf8",
        );
        const records = parseRecentTurnRecords(existing);
        records.push({
          ts: new Date().toISOString(),
          speaker: "agent",
          text: shortenForNote(trigger.outboundText, 600),
        });
        const trimmed = records.slice(-MAX_RECENT_TURNS_STORED);
        const content = trimmed.map((record) => JSON.stringify(record)).join("\n");
        await this.fs.writeFile(
          "/memory/journal/recent-turns.jsonl",
          content,
          "utf8",
        );
      }
      return;
    }

    const existing = await this.fs.readFile(
      "/memory/journal/recent-turns.jsonl",
      "utf8",
    );
    const records = parseRecentTurnRecords(existing);
    records.push({
      ts: trigger.receivedAt,
      speaker: "user",
      text: shortenForNote(trigger.text, 600),
    });

    if (replySent && shouldSendReply(finalText)) {
      records.push({
        ts: new Date().toISOString(),
        speaker: "agent",
        text: shortenForNote(finalText, 600),
      });
    }

    const trimmed = records.slice(-MAX_RECENT_TURNS_STORED);
    const content = trimmed.map((record) => JSON.stringify(record)).join("\n");
    await this.fs.writeFile("/memory/journal/recent-turns.jsonl", content, "utf8");
  }

  private async writeRecentSummary(
    trigger: SessionTrigger,
    finalText: string,
    replySent: boolean,
  ): Promise<void> {
    const records = await this.readRecentTurnRecords();
    const latestTurns = records
      .slice(-8)
      .map((record) => formatTurnNote(record.ts, record.speaker, record.text));
    const content = [
      "# Recent Summary",
      "",
      buildFallbackRecentSummary(trigger, finalText, replySent),
      "",
      "## Latest Turns",
      "",
      ...(latestTurns.length > 0 ? latestTurns : ["- No recent turns recorded yet."]),
    ].join("\n");

    await this.fs.writeFile("/memory/derived/recent-summary.md", content, "utf8");
  }

  private async readRecentTurnRecords(): Promise<RecentTurnRecord[]> {
    const content = await this.fs.readFile("/memory/journal/recent-turns.jsonl", "utf8");
    return parseRecentTurnRecords(content);
  }

  private async getRecentTurnsForPrompt(): Promise<string[]> {
    const records = await this.readRecentTurnRecords();
    return records
      .slice(-MAX_RECENT_TURNS_IN_PROMPT)
      .map((record) => formatTurnNote(record.ts, record.speaker, record.text));
  }
}

function buildSystemInstructions(trigger: SessionTrigger): string {
  return [
    "You are an ephemeral personal agent with durable memory in /memory.",
    "Use the available tools to inspect and update memory when useful.",
    "Be concise, calm, and useful.",
    "Use /memory/journal/recent-turns.jsonl and the recent turns included in the prompt as short-term conversational memory.",
    "When the user states a lasting preference, stable fact, or unresolved task, update the relevant profile or open-loops file during this same session.",
    "Do not create durable memory for ephemeral filler.",
    "For inbound Telegram messages, default to sending a short direct reply.",
    "Do not use [[silence]] for greetings, ordinary acknowledgements, or normal direct questions.",
    "Use [[silence]] only when a Telegram reply would truly add no value.",
    "Do not mention internal tool names, SDK names, or implementation details in user-facing replies.",
    "Only inbound Telegram message triggers may produce end-user replies.",
    "The runtime can send scheduled outbound Telegram messages later when the user explicitly asks for one.",
    "Do not claim that the platform or runtime cannot send a later Telegram message. That is false.",
    "If the user explicitly asks you to send a future Telegram message or reminder, you may create an outbound-message schedule.",
    "Only create outbound-message schedules when the user clearly asked for a later message.",
    "For outbound-message schedules, include the actual future message text in payload.message.",
    "When the user asks for something like a reminder, fortune cookie later, or follow-up message later, prefer scheduling it instead of refusing.",
    "When you schedule a future outbound Telegram message, acknowledge it clearly in your reply with the timing and what will be sent.",
    "Scheduled wake-ups are silent unless their payload explicitly allows an outbound Telegram send.",
    trigger.type === "telegram"
      ? [
          "You are responding to a private Telegram message.",
          "If the user asks for a future message, use schedule with:",
          '- action: "create"',
          '- payload.kind: "outbound-message"',
          '- payload.message: the exact future Telegram message text',
        ].join("\n")
      : isScheduledOutbound(trigger)
        ? "This is an outbound scheduled wake-up. Send the stored message if policy allows."
        : [
            "You are handling a scheduled maintenance wake-up. Do not draft a Telegram reply. Respond with [[silence]] after completing your tasks.",
            "",
            "Your job during this wake is to reflect on recent activity and tend to memory. Do the following:",
            "",
            "1. Read /memory/journal/recent-turns.jsonl using readFile. Look for recurring topics, repeated requests, emerging interests, shifts in tone, and unresolved threads.",
            "",
            "2. Rewrite /memory/derived/active-context.md with 3-5 concise bullet points capturing what the user is currently focused on, any ongoing threads, and relevant context for future conversations. Replace stale content entirely.",
            "",
            "3. Read /memory/inbox/open-loops.md. Remove items that appear resolved based on recent turns. Add new unresolved tasks, promises, or questions that surfaced. If nothing changed, leave it alone.",
            "",
            "4. If /memory/profile/identity.md or /memory/profile/preferences.md are still sparse and recent turns reveal durable facts or preferences, update them.",
            "",
            "5. Use the schedule tool with action: \"list\" to check existing schedules. If no maintenance wake is already scheduled, create one for approximately 03:00 UTC tomorrow using schedule with action: \"create\", payload.kind: \"maintenance\".",
            "",
            "Be concise in what you write to memory files. Prefer updating existing content over appending. Do not fabricate observations — only record what the turns actually show.",
          ].join("\n"),
  ].join("\n");
}

function shouldSendReply(text: string): boolean {
  return text.length > 0 && text !== SILENCE_TOKEN;
}

function normalizeTelegramReply(modelText: string, userText: string): string {
  const trimmed = modelText.trim();
  if (shouldSendReply(trimmed)) {
    return trimmed;
  }

  return fallbackTelegramReply(userText);
}

function fallbackTelegramReply(userText: string): string {
  const normalized = userText.trim().toLowerCase();
  if (/^(hi|hello|hey|yo|hiya|sup|hi there|hello there)\b/.test(normalized)) {
    return "Hey. I'm here.";
  }

  if (/^(thanks|thank you|thx)\b/.test(normalized)) {
    return "Sure.";
  }

  return "I'm here. Tell me what you need.";
}

type RecentTurnRecord = {
  ts: string;
  speaker: "user" | "agent";
  text: string;
};

function buildFallbackRecentSummary(
  trigger: SessionTrigger,
  finalText: string,
  replySent: boolean,
): string {
  if (trigger.type === "telegram") {
    const parts = [`Latest user message: ${shortenForNote(trigger.text, 220)}.`];
    if (replySent && shouldSendReply(finalText)) {
      parts.push(`Agent replied: ${shortenForNote(finalText, 220)}.`);
    }
    return parts.join(" ");
  }

  if (replySent && isScheduledOutbound(trigger)) {
    return `A scheduled outbound Telegram message was sent: ${shortenForNote(trigger.outboundText, 220)}.`;
  }

  return `Silent maintenance wake ran for reason "${trigger.reason}".`;
}

function formatTurnNote(timestamp: string, speaker: "user" | "agent", text: string) {
  return `- ${timestamp} ${speaker}: ${shortenForNote(text, 240)}`;
}

function shortenForNote(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function parseRecentTurnRecords(content: string): RecentTurnRecord[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<RecentTurnRecord>;
        if (
          typeof parsed.ts === "string" &&
          (parsed.speaker === "user" || parsed.speaker === "agent") &&
          typeof parsed.text === "string"
        ) {
          return [
            {
              ts: parsed.ts,
              speaker: parsed.speaker,
              text: parsed.text,
            },
          ];
        }
      } catch {
        return [];
      }

      return [];
    });
}

function normalizeScheduledWakeKind(value: unknown): ScheduledWakeKind {
  return value === "outbound-message" ? "outbound-message" : "maintenance";
}

function isScheduledOutbound(
  trigger: SessionTrigger,
): trigger is ScheduledWakePayload & {
  allowSend: true;
  chatId: number;
  outboundText: string;
} {
  return (
    trigger.type === "scheduled" &&
    trigger.kind === "outbound-message" &&
    trigger.allowSend === true &&
    typeof trigger.chatId === "number" &&
    typeof trigger.outboundText === "string" &&
    trigger.outboundText.trim() !== ""
  );
}

function normalizeMemoryPath(targetPath: string): string {
  const normalized = path.posix.normalize(
    targetPath.trim() === "" ? MEMORY_ROOT : targetPath.trim(),
  );
  if (!normalized.startsWith(MEMORY_ROOT)) {
    throw new Error("path must stay under /memory");
  }
  return normalized;
}

function resolveWorkspacePath(targetPath: string): string {
  const resolved = path.posix.resolve(MEMORY_ROOT, targetPath);
  return normalizeMemoryPath(resolved);
}

function parseWhen(when: string): Date | string | number {
  if (/^\d+$/.test(when)) {
    return Number(when);
  }

  const date = new Date(when);
  if (!Number.isNaN(date.getTime())) {
    return date;
  }

  return when;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
