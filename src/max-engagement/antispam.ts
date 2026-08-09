import type {
  MaxClient,
  MaxEngagementChannelRecord,
  MaxEngagementChatMessageRecord
} from "./types.js";

export type AntispamDecisionReason =
  | "allow"
  | "admin_bypass"
  | "self_bypass"
  | "blocked_link"
  | "delete_success"
  | "delete_failed"
  | "antispam_disabled"
  | "antispam_error";

export type AntispamDecision = {
  allowed: boolean;
  reason: AntispamDecisionReason;
  shouldStopPipeline: boolean;
  deleteAttempted: boolean;
  deleteSucceeded: boolean;
  errorMessage?: string;
};

type Logger = Pick<typeof console, "log" | "error">;

const lastDeleteAtByChat = new Map<string, number>();
const DELETE_INTERVAL_MS = 550;

export async function moderateChatMessage(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  maxClient: MaxClient;
  logger?: Logger;
}): Promise<AntispamDecision> {
  const logger = input.logger ?? console;
  const { channel, message, maxClient } = input;

  try {
    if ((channel.communityType ?? "channel") !== "chat" || !channel.antispamEnabled || !channel.antispamDeleteLinks) {
      logAntispam(logger, "antispam_disabled", channel, message);
      return allow("antispam_disabled");
    }

    if (message.authorIsBot) {
      logAntispam(logger, "self_bypass", channel, message);
      return allow("self_bypass");
    }

    if (!containsForbiddenLink(getModerationText(message))) {
      logAntispam(logger, "allow", channel, message);
      return allow("allow");
    }

    const admins = await maxClient.listChatAdmins(channel.maxChannelId);
    const authorIsAdmin = Boolean(message.authorUserId) &&
      admins.some((admin) => admin.userId === message.authorUserId && (admin.isAdmin || admin.isOwner));

    if (authorIsAdmin) {
      logAntispam(logger, "admin_bypass", channel, message);
      return allow("admin_bypass");
    }

    logAntispam(logger, "blocked_link", channel, message);
    try {
      await throttleDelete(channel.maxChannelId);
      await maxClient.deleteChatMessage({
        chatId: channel.maxChannelId,
        messageId: message.maxMessageId
      });
      logAntispam(logger, "delete_success", channel, message);
      return {
        allowed: false,
        reason: "delete_success",
        shouldStopPipeline: true,
        deleteAttempted: true,
        deleteSucceeded: true
      };
    } catch (error) {
      const errorMessage = formatError(error);
      logAntispam(logger, "delete_failed", channel, message, errorMessage);
      return {
        allowed: false,
        reason: "delete_failed",
        shouldStopPipeline: true,
        deleteAttempted: true,
        deleteSucceeded: false,
        errorMessage
      };
    }
  } catch (error) {
    const errorMessage = formatError(error);
    logAntispam(logger, "antispam_error", channel, message, errorMessage);
    return {
      allowed: true,
      reason: "antispam_error",
      shouldStopPipeline: false,
      deleteAttempted: false,
      deleteSucceeded: false,
      errorMessage
    };
  }
}

export function containsForbiddenLink(text: string): boolean {
  const normalized = text.normalize("NFKC");
  const patterns = [
    /\bhttps?:\/\/[^\s<>()]+/iu,
    /\bwww\.[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+(?:\/[^\s<>()]*)?/iu,
    /\b(?:max\.ru|t\.me|telegram\.me|wa\.me|chat\.whatsapp\.com|vk\.com|m\.vk\.com)(?:\/[^\s<>()]*)?/iu,
    /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:ru|com|net|org|рф|su|io|me|app|info|biz|online|site|shop|club|pro|dev|ai)(?:\/[^\s<>()]*)?/iu
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function getModerationText(message: MaxEngagementChatMessageRecord): string {
  return [message.text, message.linkedText].filter(Boolean).join("\n");
}

function allow(reason: AntispamDecisionReason): AntispamDecision {
  return {
    allowed: true,
    reason,
    shouldStopPipeline: false,
    deleteAttempted: false,
    deleteSucceeded: false
  };
}

function logAntispam(
  logger: Logger,
  reason: AntispamDecisionReason,
  channel: MaxEngagementChannelRecord,
  message: MaxEngagementChatMessageRecord,
  errorMessage?: string
): void {
  const payload = {
    at: new Date().toISOString(),
    source: "antispam",
    reason,
    chat_id: channel.maxChannelId,
    channel_id: channel.id,
    message_id: message.maxMessageId,
    author_user_id: message.authorUserId,
    ...(errorMessage ? { error: errorMessage } : {})
  };

  const line = `[antispam] ${JSON.stringify(payload)}`;
  if (reason === "delete_failed" || reason === "antispam_error") {
    logger.error(line);
    return;
  }
  logger.log(line);
}

async function throttleDelete(chatId: string): Promise<void> {
  const now = Date.now();
  const nextAllowedAt = (lastDeleteAtByChat.get(chatId) ?? 0) + DELETE_INTERVAL_MS;
  const delayMs = Math.max(0, nextAllowedAt - now);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  lastDeleteAtByChat.set(chatId, Date.now());
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
