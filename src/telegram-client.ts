import type {
  ChatAdmin,
  ChatClient,
  ChatDeleteMessageInput,
  ChatSendMessageInput,
  ChatSendMessageResult
} from "./chat-transport/types.js";
import type { TelegramUpdate, TelegramUser } from "./chat-transport/telegram-adapter.js";

const DEFAULT_API_BASE = "https://api.telegram.org";

type TelegramApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

type TelegramChatMember = {
  status: string;
  user: TelegramUser;
  [key: string]: unknown;
};

type TelegramSentMessage = {
  message_id: number;
};

export type TelegramGetUpdatesInput = {
  offset?: number | null;
  limit?: number;
  timeout?: number;
  allowedUpdates?: string[];
};

export class TelegramClient implements ChatClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = process.env.TELEGRAM_API_BASE?.trim() || DEFAULT_API_BASE
  ) {}

  async getUpdates(input: TelegramGetUpdatesInput = {}): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      limit: Math.min(100, Math.max(1, input.limit ?? 100)),
      timeout: Math.max(0, input.timeout ?? 0),
      allowed_updates: input.allowedUpdates ?? ["message"]
    };
    if (typeof input.offset === "number") payload.offset = input.offset;
    return await this.call<TelegramUpdate[]>("getUpdates", payload);
  }

  async sendChatMessage(input: ChatSendMessageInput): Promise<ChatSendMessageResult> {
    const payload: Record<string, unknown> = {
      chat_id: normalizeTelegramId(input.chatId),
      text: input.text
    };
    if (input.replyToMessageId) {
      payload.reply_parameters = {
        message_id: normalizeTelegramMessageId(input.replyToMessageId),
        allow_sending_without_reply: true
      };
    }
    const message = await this.call<TelegramSentMessage>("sendMessage", payload);
    return { messageId: String(message.message_id) };
  }

  async deleteChatMessage(input: ChatDeleteMessageInput): Promise<void> {
    await this.call<boolean>("deleteMessage", {
      chat_id: normalizeTelegramId(input.chatId),
      message_id: normalizeTelegramMessageId(input.messageId)
    });
  }

  async listChatAdmins(chatId: string): Promise<ChatAdmin[]> {
    const members = await this.call<TelegramChatMember[]>("getChatAdministrators", {
      chat_id: normalizeTelegramId(chatId)
    });
    return members.map((member) => ({
      userId: member.user ? String(member.user.id) : null,
      isAdmin: member.status === "administrator" || member.status === "creator",
      isOwner: member.status === "creator",
      isBot: member.user?.is_bot === true,
      permissions: Object.entries(member)
        .filter(([key, value]) => key.startsWith("can_") && value === true)
        .map(([key]) => key)
    }));
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = Math.max(30_000, Number(process.env.TELEGRAM_HTTP_TIMEOUT_MS || 45_000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await response.json() as TelegramApiEnvelope<T>;
      if (!response.ok || !data.ok || data.result === undefined) {
        throw new Error(data.description || `Telegram ${method} HTTP ${response.status}`);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createTelegramClientFromEnv(): TelegramClient {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  return new TelegramClient(token);
}

function normalizeTelegramId(value: string): number | string {
  if (/^-?\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  return value;
}

function normalizeTelegramMessageId(value: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`Invalid Telegram message id: ${value}`);
  }
  return numeric;
}
