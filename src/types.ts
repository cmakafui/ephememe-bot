export type TriggerType = "telegram" | "scheduled";
export type ScheduledWakeKind = "maintenance" | "outbound-message";

export interface TelegramTrigger {
  type: "telegram";
  updateId: number;
  chatId: number;
  userId: number;
  messageId: number;
  text: string;
  receivedAt: string;
  rawUpdate: unknown;
}

export interface ScheduledWakePayload {
  type: "scheduled";
  kind: ScheduledWakeKind;
  reason: string;
  scheduledFor: string;
  source: "agent" | "admin";
  notes?: string;
  allowSend?: boolean;
  chatId?: number;
  outboundText?: string;
  createdFromMessageId?: number;
  userId?: number;
}

export type SessionTrigger = TelegramTrigger | ScheduledWakePayload;

export interface CoordinationState {
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  activeRunLeaseUntil: string | null;
}

export interface RunLogEntry {
  id: number;
  triggerType: TriggerType;
  startedAt: string;
  finishedAt: string | null;
  replySent: number;
  outcome: string;
  error: string | null;
}

export interface ContactLogEntry {
  id: number;
  chatId: string;
  sentAt: string;
  text: string;
  triggerType: TriggerType;
}

export interface AgentAdminSnapshot {
  agentId: string;
  coordination: CoordinationState;
  schedules: unknown[];
  recentRuns: RunLogEntry[];
  contactLog: ContactLogEntry[];
}

export interface MemoryInspectionResult {
  path: string;
  type: "file" | "directory";
  content?: string;
  entries?: string[];
}
