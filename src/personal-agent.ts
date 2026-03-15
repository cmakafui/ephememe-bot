import { Agent, type AgentContext } from "agents";
import { stepCountIs, ToolLoopAgent, tool } from "ai";
import {
  scrape as createFirecrawlScrape,
  search as createFirecrawlSearch,
} from "firecrawl-aisdk";
import path from "node:path";
import { z } from "zod";
import { AgentFS, type CloudflareStorage } from "agentfs-sdk/cloudflare";
import { Bash } from "just-bash";
import {
  type ExecutableTrigger,
  type MailboxKind,
  type MailboxRow,
  mailboxKindForTrigger,
  isTelegramBatchTrigger,
  latestTelegramMessage,
  selectNextMailboxExecution,
} from "./mailbox";
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
import { MEMORY_ROOT, normalizeMemoryPath, resolveWorkspacePath } from "./workspace-paths";

const IMPORTS_ROOT = "/memory/imports";
const SCHEDULE_STALE_AFTER_MS = 30 * 60 * 1000;
const RUN_LEASE_MS = 2 * 60 * 1000;
const SILENCE_TOKEN = "[[silence]]";
const DEFAULT_SEARCH_LIMIT = 5;
const SEARCH_RESULT_EXCERPT_MAX = 240;
const SCRAPE_EXCERPT_MAX = 280;

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

type ClaimedMailboxBatch = {
  mailboxIds: number[];
  trigger: ExecutableTrigger;
};

type PendingMailboxRowRecord = {
  id: number;
  kind: MailboxKind;
  enqueued_at: string;
  payload_json: string;
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
    return this.acceptTrigger(trigger);
  }

  async onScheduledWakeUp(
    payload: ScheduledWakePayload,
  ): Promise<SessionResult> {
    return this.acceptTrigger(payload);
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

  private async acceptTrigger(trigger: SessionTrigger): Promise<SessionResult> {
    await this.ensureMemorySeeded();
    this.recoverMailboxAfterExpiredLease();

    if (trigger.type === "telegram" && this.hasProcessedUpdate(trigger.updateId)) {
      return {
        blocked: true,
        outcome: "duplicate-update",
        replySent: false,
      };
    }

    if (trigger.type === "scheduled" && isStaleScheduledWake(trigger)) {
      return {
        blocked: true,
        outcome: "stale-scheduled-wake",
        replySent: false,
      };
    }

    this.enqueueTrigger(trigger);

    if (this.hasActiveRunLease()) {
      return {
        blocked: false,
        outcome: "queued",
        replySent: false,
      };
    }

    this.acquireRunLease();
    try {
      return await this.drainMailboxUntilIdle();
    } finally {
      this.releaseRunLease();
    }
  }

  private async drainMailboxUntilIdle(): Promise<SessionResult> {
    let lastResult: SessionResult = {
      blocked: false,
      outcome: "queued",
      replySent: false,
    };

    while (true) {
      const claim = this.claimNextMailboxBatch();
      if (!claim) {
        return lastResult;
      }

      try {
        lastResult = await this.runSession(claim.trigger);
        this.completeMailboxClaim(claim);
      } catch (error) {
        this.rollbackMailboxClaim(claim);
        throw error;
      }
    }
  }

  private async runSession(trigger: ExecutableTrigger): Promise<SessionResult> {
    await this.ensureMemorySeeded();

    const runId = this.insertRunLog(executionTriggerType(trigger));
    let replySent = false;

    try {
      if (trigger.type === "scheduled" && isScheduledOutbound(trigger)) {
        await sendTelegramMessage({
          token: this.env.BOT_TOKEN,
          chatId: trigger.chatId,
          text: trigger.outboundText,
        });
        replySent = true;
        this.recordOutbound(trigger.chatId, trigger.outboundText, "scheduled");
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

      if (isTelegramBatchTrigger(trigger)) {
        const latest = latestTelegramMessage(trigger);
        try {
          await sendTelegramChatAction({
            token: this.env.BOT_TOKEN,
            chatId: latest.chatId,
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
          search: this.makeSearchTool(),
          scrape: this.makeScrapeTool(),
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

      const finalText = isTelegramBatchTrigger(trigger)
        ? normalizeTelegramReply(result.text, latestTelegramMessage(trigger).text)
        : result.text.trim();

      if (isTelegramBatchTrigger(trigger) && shouldSendReply(finalText)) {
        const latest = latestTelegramMessage(trigger);
        await sendTelegramMessage({
          token: this.env.BOT_TOKEN,
          chatId: latest.chatId,
          text: finalText,
          replyToMessageId: latest.messageId,
        });
        replySent = true;
        this.recordOutbound(latest.chatId, finalText, "telegram");
      }

      await this.refreshMemoryLoop(trigger, finalText, replySent);

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
      this.finishRunLog(runId, {
        replySent,
        outcome: "error",
        errorText: toErrorMessage(error),
      });

      throw error;
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
      CREATE TABLE IF NOT EXISTS mailbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        enqueued_at TEXT NOT NULL,
        claimed_at TEXT,
        payload_json TEXT NOT NULL
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

  private hasActiveRunLease(): boolean {
    const coordination = this.getCoordinationState();
    return Boolean(
      coordination.activeRunLeaseUntil &&
        Date.parse(coordination.activeRunLeaseUntil) > Date.now(),
    );
  }

  private acquireRunLease(): void {
    this.sql`
      UPDATE coordination_state
      SET active_run_lease_until = ${new Date(
        Date.now() + RUN_LEASE_MS,
      ).toISOString()}
      WHERE id = 1
    `;
  }

  private releaseRunLease(): void {
    this.sql`
      UPDATE coordination_state
      SET active_run_lease_until = NULL
      WHERE id = 1
    `;
  }

  private recoverMailboxAfterExpiredLease(): void {
    const coordination = this.getCoordinationState();
    const leaseIsActive =
      coordination.activeRunLeaseUntil &&
      Date.parse(coordination.activeRunLeaseUntil) > Date.now();

    if (leaseIsActive) {
      return;
    }

    this.releaseRunLease();

    this.sql`
      UPDATE mailbox
      SET status = ${"pending"}, claimed_at = NULL
      WHERE status = ${"processing"}
    `;

    this.sql`
      UPDATE processed_updates
      SET status = ${"queued"}, completed_at = NULL
      WHERE status = ${"processing"}
    `;
  }

  private hasProcessedUpdate(updateId: number): boolean {
    const existing = this.sql<{ update_id: number }>`
      SELECT update_id
      FROM processed_updates
      WHERE update_id = ${updateId}
      LIMIT 1
    `;
    return existing.length > 0;
  }

  private enqueueTrigger(trigger: SessionTrigger): void {
    const enqueuedAt = new Date().toISOString();
    this.sql`
      INSERT INTO mailbox (
        kind,
        status,
        enqueued_at,
        claimed_at,
        payload_json
      )
      VALUES (
        ${mailboxKindForTrigger(trigger)},
        ${"pending"},
        ${enqueuedAt},
        NULL,
        ${JSON.stringify(trigger)}
      )
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
          ${"queued"},
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
  }

  private claimNextMailboxBatch(): ClaimedMailboxBatch | null {
    while (true) {
      const pendingRows = this.readPendingMailboxRows();
      const selection = selectNextMailboxExecution({
        rows: pendingRows,
        nowMs: Date.now(),
        staleAfterMs: SCHEDULE_STALE_AFTER_MS,
      });

      if (!selection) {
        return null;
      }

      for (const id of selection.deleteIds) {
        this.deleteMailboxRow(id);
      }

      if (!selection.trigger || selection.processingIds.length === 0) {
        continue;
      }

      const claimedAt = new Date().toISOString();
      for (const id of selection.processingIds) {
        this.sql`
          UPDATE mailbox
          SET status = ${"processing"}, claimed_at = ${claimedAt}
          WHERE id = ${id} AND status = ${"pending"}
        `;
      }

      if (isTelegramBatchTrigger(selection.trigger)) {
        this.markProcessedUpdatesProcessing(
          selection.trigger.messages.map((message) => message.updateId),
        );
      }

      return {
        mailboxIds: selection.processingIds,
        trigger: selection.trigger,
      };
    }
  }

  private readPendingMailboxRows(): MailboxRow[] {
    const rows = this.sql<PendingMailboxRowRecord>`
      SELECT id, kind, enqueued_at, payload_json
      FROM mailbox
      WHERE status = ${"pending"}
      ORDER BY id ASC
    `;

    return rows.flatMap((row) => {
      try {
        return [
          {
            id: row.id,
            kind: row.kind,
            enqueuedAt: row.enqueued_at,
            payload: JSON.parse(row.payload_json) as SessionTrigger,
          },
        ];
      } catch {
        this.deleteMailboxRow(row.id);
        return [];
      }
    });
  }

  private completeMailboxClaim(claim: ClaimedMailboxBatch): void {
    for (const id of claim.mailboxIds) {
      this.deleteMailboxRow(id);
    }

    if (isTelegramBatchTrigger(claim.trigger)) {
      this.markProcessedUpdatesDone(
        claim.trigger.messages.map((message) => message.updateId),
      );
    }
  }

  private rollbackMailboxClaim(claim: ClaimedMailboxBatch): void {
    for (const id of claim.mailboxIds) {
      this.sql`
        UPDATE mailbox
        SET status = ${"pending"}, claimed_at = NULL
        WHERE id = ${id}
      `;
    }

    if (isTelegramBatchTrigger(claim.trigger)) {
      this.markProcessedUpdatesQueued(
        claim.trigger.messages.map((message) => message.updateId),
      );
    }
  }

  private deleteMailboxRow(id: number): void {
    this.sql`
      DELETE FROM mailbox
      WHERE id = ${id}
    `;
  }

  private markProcessedUpdatesProcessing(updateIds: number[]): void {
    for (const updateId of updateIds) {
      this.sql`
        UPDATE processed_updates
        SET status = ${"processing"}, completed_at = NULL
        WHERE update_id = ${updateId}
      `;
    }
  }

  private markProcessedUpdatesQueued(updateIds: number[]): void {
    for (const updateId of updateIds) {
      this.sql`
        UPDATE processed_updates
        SET status = ${"queued"}, completed_at = NULL
        WHERE update_id = ${updateId}
      `;
    }
  }

  private markProcessedUpdatesDone(updateIds: number[]): void {
    const completedAt = new Date().toISOString();
    for (const updateId of updateIds) {
      this.sql`
        UPDATE processed_updates
        SET status = ${"done"}, completed_at = ${completedAt}
        WHERE update_id = ${updateId}
      `;
    }
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
    for (const [targetPath, content] of Object.entries(SPINE_FILES)) {
      const exists = await this.pathExists(targetPath);
      if (!exists) {
        await this.writeWorkspaceFile(targetPath, content);
      }
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await this.fs.stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async buildManifest(trigger: ExecutableTrigger): Promise<string> {
    const sections = await Promise.all(
      MANIFEST_SPINE_PATHS.map(async (targetPath) => {
        const content = await this.fs.readFile(targetPath, "utf8");
        return [`FILE: ${targetPath}`, content.trim()].join("\n");
      }),
    );
    const recentTurns = await this.getRecentTurnsForPrompt();

    return [
      `Current time: ${new Date().toISOString()}`,
      `Trigger type: ${trigger.type}`,
      isTelegramBatchTrigger(trigger)
        ? [
            `User ID: ${latestTelegramMessage(trigger).userId}`,
            `Chat ID: ${latestTelegramMessage(trigger).chatId}`,
            `Queued message count: ${trigger.messages.length}`,
            "Incoming user messages:",
            ...trigger.messages.map((message) =>
              formatTurnNote(message.receivedAt, "user", message.text),
            ),
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
      recentTurns.length > 0
        ? recentTurns.join("\n")
        : "No recent turns recorded yet.",
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
        await this.writeWorkspaceFile(resolveWorkspacePath(path), content);
        return { success: true };
      },
    });
  }

  private makeSearchTool() {
    const firecrawlSearch = createFirecrawlSearch({
      apiKey: this.env.FIRECRAWL_API_KEY,
    }) as {
      execute?: (
        input: { query: string; limit?: number },
        options?: unknown,
      ) => Promise<{
        web?: Array<{
          url?: string;
          title?: string;
          description?: string;
          metadata?: { url?: string; title?: string; description?: string };
        }>;
      }>;
    };

    return tool({
      description:
        "Search the web. Keep results in context; use scrape when you want a page saved into /memory for deeper inspection.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async ({ query, limit }) => {
        if (!firecrawlSearch.execute) {
          throw new Error("Firecrawl search tool is unavailable");
        }

        const result = await firecrawlSearch.execute({
          query,
          limit: limit ?? DEFAULT_SEARCH_LIMIT,
        });
        const webResults = Array.isArray(result.web) ? result.web : [];

        return {
          results: webResults
            .map((entry) => {
              const url = entry.url ?? entry.metadata?.url;
              if (!url) {
                return null;
              }

              return {
                url,
                title: entry.title ?? entry.metadata?.title ?? null,
                description: shortenForNote(
                  entry.description ?? entry.metadata?.description ?? "",
                  SEARCH_RESULT_EXCERPT_MAX,
                ),
              };
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
        };
      },
    });
  }

  private makeScrapeTool() {
    const firecrawlScrape = createFirecrawlScrape({
      apiKey: this.env.FIRECRAWL_API_KEY,
    }) as {
      execute?: (
        input: {
          url: string;
          formats?: string[];
          onlyMainContent?: boolean;
        },
        options?: unknown,
      ) => Promise<{
        markdown?: string;
        metadata?: {
          url?: string;
          title?: string;
          description?: string;
        };
      }>;
    };

    return tool({
      description:
        "Scrape a single web page, save the full markdown into /memory/imports, and return the saved file path plus a short excerpt.",
      inputSchema: z.object({
        url: z.string().url(),
      }),
      execute: async ({ url }) => {
        if (!firecrawlScrape.execute) {
          throw new Error("Firecrawl scrape tool is unavailable");
        }

        const result = await firecrawlScrape.execute({
          url,
          formats: ["markdown"],
          onlyMainContent: true,
        });
        const markdown = result.markdown?.trim();
        if (!markdown) {
          throw new Error("scrape returned no markdown content");
        }

        const importPath = buildImportedScrapePath(url);
        const content = formatImportedScrapeDocument({
          scrapedAt: new Date().toISOString(),
          title:
            typeof result.metadata?.title === "string"
              ? result.metadata.title
              : null,
          url,
          markdown,
        });

        await this.writeWorkspaceFile(importPath, content);

        return {
          url,
          path: importPath,
          title:
            typeof result.metadata?.title === "string"
              ? result.metadata.title
              : null,
          excerpt: shortenForNote(markdown, SCRAPE_EXCERPT_MAX),
        };
      },
    });
  }

  private makeScheduleTool(trigger: ExecutableTrigger) {
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
        const latestTelegram = isTelegramBatchTrigger(trigger)
          ? latestTelegramMessage(trigger)
          : null;

        for (const schedule of this.getSchedules()) {
          if (schedule.callback !== "onScheduledWakeUp") {
            continue;
          }
          const scheduledPayload = schedule.payload as
            | Partial<ScheduledWakePayload>
            | undefined;
          const sameKind = (scheduledPayload?.kind ?? "maintenance") === kind;
          if (sameKind) {
            await this.cancelSchedule(schedule.id);
          }
        }

        const parsedWhen = parseWhen(when);
        const normalizedPayload: ScheduledWakePayload = {
          type: "scheduled",
          kind,
          reason: kind === "outbound-message" ? "outbound-message" : "maintenance",
          scheduledFor:
            parsedWhen instanceof Date ? parsedWhen.toISOString() : String(parsedWhen),
          source: "agent",
          notes:
            typeof payload?.notes === "string" ? String(payload.notes) : undefined,
          allowSend: kind === "outbound-message",
          chatId:
            kind === "outbound-message" && latestTelegram
              ? latestTelegram.chatId
              : undefined,
          outboundText: kind === "outbound-message" ? outboundText : undefined,
          createdFromMessageId:
            kind === "outbound-message" && latestTelegram
              ? latestTelegram.messageId
              : undefined,
          userId:
            kind === "outbound-message" && latestTelegram
              ? latestTelegram.userId
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

        return this.schedule(parsedWhen, "onScheduledWakeUp", normalizedPayload);
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
    trigger: ExecutableTrigger,
    finalText: string,
    replySent: boolean,
  ): Promise<void> {
    await this.appendTurnRecords(trigger, finalText, replySent);
    await this.writeRecentSummary(trigger, finalText, replySent);
  }

  private async appendTurnRecords(
    trigger: ExecutableTrigger,
    finalText: string,
    replySent: boolean,
  ): Promise<void> {
    const existing = await this.fs.readFile(
      "/memory/journal/recent-turns.jsonl",
      "utf8",
    );
    const records = parseRecentTurnRecords(existing);

    if (isTelegramBatchTrigger(trigger)) {
      for (const message of trigger.messages) {
        records.push({
          ts: message.receivedAt,
          speaker: "user",
          text: shortenForNote(message.text, 600),
        });
      }

      if (replySent && shouldSendReply(finalText)) {
        records.push({
          ts: new Date().toISOString(),
          speaker: "agent",
          text: shortenForNote(finalText, 600),
        });
      }
    } else if (replySent && isScheduledOutbound(trigger)) {
      records.push({
        ts: new Date().toISOString(),
        speaker: "agent",
        text: shortenForNote(trigger.outboundText, 600),
      });
    }

    const trimmed = records.slice(-MAX_RECENT_TURNS_STORED);
    const content = trimmed.map((record) => JSON.stringify(record)).join("\n");
    await this.fs.writeFile("/memory/journal/recent-turns.jsonl", content, "utf8");
  }

  private async writeRecentSummary(
    trigger: ExecutableTrigger,
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

  private async writeWorkspaceFile(
    targetPath: string,
    content: string,
  ): Promise<void> {
    await this.ensureWorkspaceDirectory(path.posix.dirname(targetPath));
    await this.fs.writeFile(targetPath, content, "utf8");
  }

  private async ensureWorkspaceDirectory(targetPath: string): Promise<void> {
    const normalizedPath = normalizeMemoryPath(targetPath);
    if (!(await this.pathExists(MEMORY_ROOT))) {
      await this.fs.mkdir(MEMORY_ROOT);
    }
    const segments = normalizedPath.split("/").filter(Boolean);
    let current = "";

    for (const segment of segments) {
      current += `/${segment}`;
      if (current === MEMORY_ROOT) {
        continue;
      }
      if (!(await this.pathExists(current))) {
        await this.fs.mkdir(current);
      }
    }
  }
}

function buildSystemInstructions(trigger: ExecutableTrigger): string {
  return [
    "You are an ephemeral personal agent with durable memory in /memory.",
    "Use the available tools to inspect and update memory when useful.",
    "Be concise, calm, and useful.",
    "Use search for web discovery and keep search results in context.",
    "Use scrape when you want a page saved into /memory/imports for deeper inspection with readFile or bash.",
    "Scraped pages are workspace material, not durable memory by default.",
    "When a docs site exposes llms.txt, prefer scraping that first before drilling into specific pages.",
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
    "If the user explicitly asks you to send a future message or reminder, you may create an outbound-message schedule.",
    "Only create outbound-message schedules when the user clearly asked for a later message.",
    "For outbound-message schedules, include the actual future message text in payload.message.",
    "When the user asks for something like a reminder, fortune cookie later, or follow-up message later, prefer scheduling it instead of refusing.",
    "When you schedule a future outbound Telegram message, acknowledge it clearly in your reply with the timing and what will be sent.",
    "Scheduled wake-ups are silent unless their payload explicitly allows an outbound Telegram send.",
    isTelegramBatchTrigger(trigger)
      ? [
          "You are responding to one or more private Telegram messages from the same user.",
          "If multiple queued messages are present, read them as one burst and reply once, coherently.",
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
            "Be concise in what you write to memory files. Prefer updating existing content over appending. Do not fabricate observations - only record what the turns actually show.",
          ].join("\n"),
  ].join("\n");
}

function executionTriggerType(trigger: ExecutableTrigger): TriggerType {
  return isTelegramBatchTrigger(trigger) ? "telegram" : "scheduled";
}

function isStaleScheduledWake(trigger: ScheduledWakePayload): boolean {
  return Date.now() - Date.parse(trigger.scheduledFor) > SCHEDULE_STALE_AFTER_MS;
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
  trigger: ExecutableTrigger,
  finalText: string,
  replySent: boolean,
): string {
  if (isTelegramBatchTrigger(trigger)) {
    const parts = [
      `Latest user burst: ${shortenForNote(
        trigger.messages.map((message) => message.text).join(" / "),
        220,
      )}.`,
    ];
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

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
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
  trigger: ScheduledWakePayload,
): trigger is ScheduledWakePayload & {
  allowSend: true;
  chatId: number;
  outboundText: string;
} {
  return (
    trigger.kind === "outbound-message" &&
    trigger.allowSend === true &&
    typeof trigger.chatId === "number" &&
    typeof trigger.outboundText === "string" &&
    trigger.outboundText.trim() !== ""
  );
}

function buildImportedScrapePath(rawUrl: string): string {
  const parsedUrl = new URL(rawUrl);
  const hostSegment = sanitizePathSegment(parsedUrl.hostname);
  const pathname = parsedUrl.pathname.replace(/\/+$/, "");
  const pathSegments = pathname
    .split("/")
    .filter(Boolean)
    .map(sanitizePathSegment)
    .filter((segment) => segment !== "");
  const fileBase =
    pathSegments.length > 0 ? pathSegments.join("__") : "index";
  const querySuffix =
    parsedUrl.search !== ""
      ? `__q-${hashString(parsedUrl.searchParams.toString())}`
      : "";

  return `${IMPORTS_ROOT}/${hostSegment}/${fileBase}${querySuffix}.md`;
}

function sanitizePathSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "" ? "item" : normalized;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function formatImportedScrapeDocument(input: {
  scrapedAt: string;
  title: string | null;
  url: string;
  markdown: string;
}): string {
  return [
    "# Imported Page",
    "",
    `- Source: ${input.url}`,
    `- Scraped At: ${input.scrapedAt}`,
    `- Title: ${input.title ?? "Unknown"}`,
    "",
    "## Content",
    "",
    input.markdown.trim(),
  ].join("\n");
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
