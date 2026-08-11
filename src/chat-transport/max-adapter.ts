import type { UnifiedChatMessage } from "./types.js";
import type { MaxUpdate } from "../max-engagement/types.js";
import { getMaxUpdateUserName, isMaxChatMessageUpdate } from "../max-engagement/types.js";
import { extractLinkMetadataText } from "../max-engagement/antispam.js";

/**
 * Pure MAX-chat adapter. It is intentionally additive for now: the existing MAX
 * polling/import path remains untouched until Telegram is proven in production.
 */
export function maxChatUpdatesToUnified(updates: MaxUpdate[]): UnifiedChatMessage[] {
  const result: UnifiedChatMessage[] = [];

  for (const update of updates) {
    if (!isMaxChatMessageUpdate(update) || !update.message) continue;
    const message = update.message;
    const chatId = update.chat_id ?? message.recipient?.chat_id;
    const messageId = message.body?.mid;
    if (chatId === undefined || chatId === null || !messageId) continue;

    const text = message.body?.text?.trim() ?? "";
    const rawAttachments = Array.isArray(message.body?.attachments) ? message.body.attachments : [];
    if (!text && rawAttachments.length === 0) continue;

    result.push({
      platform: "max",
      externalChatId: String(chatId),
      externalMessageId: String(messageId),
      chatTitle: null,
      authorId: message.sender?.user_id === undefined || message.sender?.user_id === null
        ? null
        : String(message.sender.user_id),
      authorName: getMaxUpdateUserName(message.sender),
      authorIsBot: message.sender?.is_bot === true,
      text,
      attachments: rawAttachments.map((raw) => ({ kind: inferMaxAttachmentKind(raw), raw })),
      replyToMessageId: message.link?.mid ?? message.link?.message?.body?.mid ?? null,
      linkedText: message.link?.message?.body?.text?.trim() || null,
      metadataText: extractLinkMetadataText({ body: message.body, url: message.url, link: message.link }),
      postedAt: typeof message.timestamp === "number"
        ? new Date(message.timestamp).toISOString()
        : new Date(update.timestamp ?? Date.now()).toISOString()
    });
  }

  return result;
}

function inferMaxAttachmentKind(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const record = value as Record<string, unknown>;
  for (const key of ["type", "kind", "attachment_type", "media_type"]) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]);
  }
  return "unknown";
}
