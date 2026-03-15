import type {
  ScheduledWakePayload,
  SessionTrigger,
  TelegramTrigger,
} from "./types";

export type MailboxKind = "telegram" | "maintenance" | "outbound-message";
export type MailboxStatus = "pending" | "processing";

export interface MailboxRow {
  id: number;
  kind: MailboxKind;
  enqueuedAt: string;
  payload: SessionTrigger;
}

export interface TelegramBatchTrigger {
  type: "telegram-batch";
  messages: TelegramTrigger[];
}

export type ExecutableTrigger = TelegramBatchTrigger | ScheduledWakePayload;

export interface MailboxSelection {
  processingIds: number[];
  deleteIds: number[];
  trigger: ExecutableTrigger | null;
}

export function mailboxKindForTrigger(trigger: SessionTrigger): MailboxKind {
  if (trigger.type === "telegram") {
    return "telegram";
  }

  return trigger.kind;
}

export function isTelegramBatchTrigger(
  trigger: ExecutableTrigger,
): trigger is TelegramBatchTrigger {
  return trigger.type === "telegram-batch";
}

export function latestTelegramMessage(
  trigger: TelegramBatchTrigger,
): TelegramTrigger {
  return trigger.messages[trigger.messages.length - 1];
}

export function selectNextMailboxExecution(input: {
  rows: MailboxRow[];
  nowMs: number;
  staleAfterMs: number;
}): MailboxSelection | null {
  if (input.rows.length === 0) {
    return null;
  }

  const telegramRows = input.rows.filter((row) => row.kind === "telegram");
  if (telegramRows.length > 0) {
    return {
      processingIds: telegramRows.map((row) => row.id),
      deleteIds: [],
      trigger: {
        type: "telegram-batch",
        messages: telegramRows.map((row) => row.payload as TelegramTrigger),
      },
    };
  }

  const outboundRow = input.rows.find((row) => row.kind === "outbound-message");
  if (outboundRow) {
    return {
      processingIds: [outboundRow.id],
      deleteIds: [],
      trigger: outboundRow.payload as ScheduledWakePayload,
    };
  }

  const maintenanceRows = input.rows.filter((row) => row.kind === "maintenance");
  if (maintenanceRows.length === 0) {
    return null;
  }

  const staleIds: number[] = [];
  const freshRows: MailboxRow[] = [];

  for (const row of maintenanceRows) {
    const payload = row.payload as ScheduledWakePayload;
    if (input.nowMs - Date.parse(payload.scheduledFor) > input.staleAfterMs) {
      staleIds.push(row.id);
    } else {
      freshRows.push(row);
    }
  }

  if (freshRows.length === 0) {
    return {
      processingIds: [],
      deleteIds: staleIds,
      trigger: null,
    };
  }

  const newestFreshRow = freshRows[freshRows.length - 1];
  const olderFreshIds = freshRows
    .slice(0, -1)
    .map((row) => row.id);

  return {
    processingIds: [newestFreshRow.id],
    deleteIds: [...staleIds, ...olderFreshIds],
    trigger: newestFreshRow.payload as ScheduledWakePayload,
  };
}
