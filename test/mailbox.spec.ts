import { describe, expect, it } from "vitest";
import { selectNextMailboxExecution } from "../src/mailbox";
import type { SessionTrigger, TelegramTrigger } from "../src/types";
import {
  MEMORY_ROOT,
  normalizeMemoryPath,
  resolveWorkspacePath,
} from "../src/workspace-paths";

describe("mailbox selection", () => {
  it("batches all pending telegram rows before scheduled work", () => {
    const selection = selectNextMailboxExecution({
      rows: [
        makeRow(1, makeTelegramTrigger(1001, "first")),
        makeRow(2, makeScheduledTrigger("maintenance", "2026-03-15T08:00:00.000Z")),
        makeRow(3, makeTelegramTrigger(1002, "second")),
      ],
      nowMs: Date.parse("2026-03-15T08:05:00.000Z"),
      staleAfterMs: 30 * 60 * 1000,
    });

    expect(selection).toMatchObject({
      processingIds: [1, 3],
      deleteIds: [],
      trigger: {
        type: "telegram-batch",
      },
    });
  });

  it("coalesces maintenance wakes down to the newest fresh one", () => {
    const selection = selectNextMailboxExecution({
      rows: [
        makeRow(1, makeScheduledTrigger("maintenance", "2026-03-15T07:00:00.000Z")),
        makeRow(2, makeScheduledTrigger("maintenance", "2026-03-15T08:00:00.000Z")),
        makeRow(3, makeScheduledTrigger("maintenance", "2026-03-15T08:04:00.000Z")),
      ],
      nowMs: Date.parse("2026-03-15T08:05:00.000Z"),
      staleAfterMs: 30 * 60 * 1000,
    });

    expect(selection).toMatchObject({
      processingIds: [3],
      deleteIds: [1, 2],
    });
  });

  it("selects outbound work before maintenance when no telegram is pending", () => {
    const selection = selectNextMailboxExecution({
      rows: [
        makeRow(1, makeScheduledTrigger("maintenance", "2026-03-15T08:00:00.000Z")),
        makeRow(2, makeScheduledTrigger("outbound-message", "2026-03-15T08:00:00.000Z")),
      ],
      nowMs: Date.parse("2026-03-15T08:05:00.000Z"),
      staleAfterMs: 30 * 60 * 1000,
    });

    expect(selection).toMatchObject({
      processingIds: [2],
      deleteIds: [],
      trigger: {
        type: "scheduled",
        kind: "outbound-message",
      },
    });
  });
});

describe("workspace path guard", () => {
  it("allows /memory and descendants", () => {
    expect(normalizeMemoryPath(MEMORY_ROOT)).toBe("/memory");
    expect(normalizeMemoryPath("/memory/profile")).toBe("/memory/profile");
    expect(resolveWorkspacePath("profile/identity.md")).toBe(
      "/memory/profile/identity.md",
    );
  });

  it("rejects sibling paths that only share a string prefix", () => {
    expect(() => normalizeMemoryPath("/memory-foo")).toThrow(
      "path must stay under /memory",
    );
    expect(() => resolveWorkspacePath("/memory-foo")).toThrow(
      "path must stay under /memory",
    );
  });
});

function makeRow(id: number, payload: SessionTrigger) {
  return {
    id,
    kind: payload.type === "telegram" ? "telegram" : payload.kind,
    enqueuedAt: "2026-03-15T08:00:00.000Z",
    payload,
  } as const;
}

function makeTelegramTrigger(updateId: number, text: string): TelegramTrigger {
  return {
    type: "telegram",
    updateId,
    chatId: 4242,
    userId: 10_001,
    messageId: updateId + 10,
    text,
    receivedAt: "2026-03-15T08:00:00.000Z",
    rawUpdate: {},
  };
}

function makeScheduledTrigger(
  kind: "maintenance" | "outbound-message",
  scheduledFor: string,
): SessionTrigger {
  return {
    type: "scheduled",
    kind,
    reason: kind,
    scheduledFor,
    source: "agent",
    allowSend: kind === "outbound-message",
    chatId: kind === "outbound-message" ? 4242 : undefined,
    outboundText: kind === "outbound-message" ? "hello later" : undefined,
  };
}
