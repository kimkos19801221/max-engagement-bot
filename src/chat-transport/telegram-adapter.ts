import type { ChatAttachment, UnifiedChatMessage } from "./types.js";

export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel" | string;
  title?: string;
  username?: string;
};

export type TelegramMessageEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  contact?: unknown;
  photo?: unknown[];
  document?: unknown;
  video?: unknown;
  animation?: unknown;
  audio?: unknown;
  voice?: unknown;
  video_note?: unknown;
  sticker?: unknown;
  location?: unknown;
  venue?: unknown;
  poll?: unknown;
  dice?: unknown;
  [key: string]: unknown;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  [key: string]: unknown;
};

export function telegramUpdatesToUnified(updates: TelegramUpdate[]): UnifiedChatMessage[] {
  const result: UnifiedChatMessage[] = [];

  for (const update of updates) {
    const message = update.message;
    if (!message || !isGroupChat(message.chat)) continue;

    const text = (message.text ?? message.caption ?? "").trim();
    const attachments = collectTelegramAttachments(message);
    if (!text && attachments.length === 0) continue;

    result.push({
      platform: "telegram",
      externalChatId: String(message.chat.id),
      externalMessageId: String(message.message_id),
      chatTitle: message.chat.title?.trim() || null,
      authorId: message.from ? String(message.from.id) : null,
      authorName: telegramAuthorName(message.from),
      authorIsBot: message.from?.is_bot === true,
      text,
      attachments,
      replyToMessageId: message.reply_to_message ? String(message.reply_to_message.message_id) : null,
      linkedText: replyText(message.reply_to_message),
      metadataText: telegramMetadataText(message),
      postedAt: new Date(message.date * 1000).toISOString()
    });
  }

  return result;
}

function isGroupChat(chat: TelegramChat): boolean {
  return chat.type === "group" || chat.type === "supergroup";
}

function telegramAuthorName(user: TelegramUser | undefined): string | null {
  if (!user) return null;
  const name = [user.first_name?.trim(), user.last_name?.trim()].filter(Boolean).join(" ").trim();
  return name || user.username?.trim() || null;
}

function replyText(message: TelegramMessage | undefined): string | null {
  if (!message) return null;
  const value = (message.text ?? message.caption ?? "").trim();
  return value || null;
}

function collectTelegramAttachments(message: TelegramMessage): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];
  const keys = [
    "contact", "photo", "document", "video", "animation", "audio", "voice",
    "video_note", "sticker", "location", "venue", "poll", "dice"
  ] as const;

  for (const kind of keys) {
    const raw = message[kind];
    if (raw !== undefined && raw !== null) attachments.push({ kind, raw });
  }
  return attachments;
}

function telegramMetadataText(message: TelegramMessage): string | null {
  const parts: string[] = [];
  collectEntityText(parts, message.text ?? "", message.entities ?? []);
  collectEntityText(parts, message.caption ?? "", message.caption_entities ?? []);
  return parts.length ? [...new Set(parts)].join("\n") : null;
}

function collectEntityText(target: string[], source: string, entities: TelegramMessageEntity[]): void {
  for (const entity of entities) {
    if (entity.type === "text_link" && entity.url) {
      target.push(entity.url);
      continue;
    }
    if (entity.type === "url" || entity.type === "email" || entity.type === "phone_number") {
      const value = source.slice(entity.offset, entity.offset + entity.length).trim();
      if (value) target.push(value);
    }
  }
}
