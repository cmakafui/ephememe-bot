import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { Api } from "grammy";

export interface RuntimeEnv {
  BOT_TOKEN: string;
  OPENAI_API_KEY: string;
  FIRECRAWL_API_KEY: string;
}

export interface TelegramSendInput {
  token: string;
  chatId: number;
  text: string;
  replyToMessageId?: number;
}

export interface TelegramChatActionInput {
  token: string;
  chatId: number;
  action: "typing";
}

type ModelFactory = (env: RuntimeEnv) => LanguageModel;
type TelegramSender = (
  input: TelegramSendInput,
) => Promise<{ messageId: number }>;
type TelegramChatActionSender = (
  input: TelegramChatActionInput,
) => Promise<void>;

type RuntimeOverrides = {
  modelFactory?: ModelFactory;
  telegramSender?: TelegramSender;
  telegramChatActionSender?: TelegramChatActionSender;
};

const overrides: RuntimeOverrides = {};

export function setRuntimeOverrides(next: RuntimeOverrides = {}): void {
  overrides.modelFactory = next.modelFactory;
  overrides.telegramSender = next.telegramSender;
  overrides.telegramChatActionSender = next.telegramChatActionSender;
}

export function resetRuntimeOverrides(): void {
  overrides.modelFactory = undefined;
  overrides.telegramSender = undefined;
  overrides.telegramChatActionSender = undefined;
}

export function createAgentModel(env: RuntimeEnv): LanguageModel {
  if (overrides.modelFactory) {
    return overrides.modelFactory(env);
  }

  const openai = createOpenAI({
    apiKey: env.OPENAI_API_KEY,
  });

  return openai("gpt-5-mini");
}

export async function sendTelegramMessage(
  input: TelegramSendInput,
): Promise<{ messageId: number }> {
  if (overrides.telegramSender) {
    return overrides.telegramSender(input);
  }

  const api = new Api(input.token);
  const message = await api.sendMessage(input.chatId, input.text, {
    reply_parameters: input.replyToMessageId
      ? { message_id: input.replyToMessageId }
      : undefined,
  });

  return { messageId: message.message_id };
}

export async function sendTelegramChatAction(
  input: TelegramChatActionInput,
): Promise<void> {
  if (overrides.telegramChatActionSender) {
    return overrides.telegramChatActionSender(input);
  }

  const api = new Api(input.token);
  await api.sendChatAction(input.chatId, input.action);
}
