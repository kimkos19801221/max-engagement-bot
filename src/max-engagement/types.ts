import type { ChatClient, ChatPlatform, ChatSendMessageInput, ChatSendMessageResult, ChatAdmin, ChatDeleteMessageInput } from "../chat-transport/types.js";
export type { ChatClient, ChatPlatform, ChatAttachment, UnifiedChatMessage } from "../chat-transport/types.js";

export type MaxEngagementChannelKind = "moms" | "news";

export type MaxCommunityType = "channel" | "chat";

export type MaxEngagementMode =
  | "off"
  | "mentions_only"
  | "questions_only"
  | "suitable_messages"
  | "revive"
  | "moderation_only"
  | "city_assistant";

export type MaxEngagementTone =
  | "friendly"
  | "neutral"
  | "official"
  | "conversational";

export type MaxEngagementPostClassification =
  | "unknown"
  | "neutral"
  | "entertainment"
  | "tragedy"
  | "emergency"
  | "death"
  | "violence"
  | "child_harm"
  | "politics"
  | "disputed";

export type MaxEngagementActionType =
  | "reply"
  | "initiative"
  | "moderate"
  | "stop_thread"
  | "delete_own_comment";

export type MaxEngagementThreadStatus =
  | "active"
  | "stopped"
  | "muted"
  | "review_required";

export type TeasingLevel = 0 | 1 | 2 | 3;

export type MaxEngagementDecision = {
  shouldAct: boolean;
  actionType?: MaxEngagementActionType;
  finalTeasingLevel: TeasingLevel;
  requiresHumanReview: boolean;
  stopThread: boolean;
  reason: string;
};

export type MaxEngagementChannelSettings = {
  channelKind: MaxEngagementChannelKind;

  /*
   * Поле пока необязательное для совместимости со старыми
   * локальными данными и текущими записями Supabase.
   *
   * Если значение отсутствует, старый код временно может
   * считать сообщество каналом.
   */
  communityType?: MaxCommunityType;

  enabled: boolean;
  antispamEnabled: boolean;
  antispamDeleteLinks: boolean;
  mode: MaxEngagementMode;
  teasingLevel: TeasingLevel;
  level3Acknowledged: boolean;
  level3ReviewPolicy: "draft_required" | "post_moderation";
  replyLimitHour: number;
  replyLimitDay: number;
  initiativeLimitHour: number;
  initiativeLimitDay: number;
  userTeaseLimitDay: number;
  politicsTeasingLevel: TeasingLevel;
};

export type MaxEngagementChannelRecord =
  MaxEngagementChannelSettings & {
    id: string;
    /** Transport platform. Legacy rows without the field are treated as MAX. */
    platform?: ChatPlatform;
    maxChannelId: string;
    title: string;
    dryRun: boolean;
    botName?: string;
    botSignature?: string;
  };

export type MaxEngagementPostContext = {
  classification: MaxEngagementPostClassification;
  classificationConfidence: number;
  isQuestion: boolean;
  mentionsBot: boolean;
  threadStatus: MaxEngagementThreadStatus;
  currentUserTeasesToday: number;
  replyCountHour: number;
  replyCountDay: number;
  initiativeCountHour: number;
  initiativeCountDay: number;
  hasStopTrigger: boolean;
};

export type MaxEngagementPostRecord = {
  id: string;
  channelId: string;
  maxPostId: string;
  text: string | null;
  classification: MaxEngagementPostClassification;
  classificationConfidence: number;
  postedAt?: string | null;
};

export type MaxEngagementThreadRecord = {
  id: string;
  channelId: string;
  postId: string;
  maxThreadId: string;
  status: MaxEngagementThreadStatus;
};

export type MaxEngagementCommentRecord = {
  id: string;
  channelId: string;
  postId: string;
  threadId: string | null;
  maxCommentId: string | null;
  authorUserId: string | null;
  authorName: string | null;
  text: string;
  postedAt: string | null;
};

/*
 * Отдельная сущность обычного сообщения группового чата.
 *
 * Сообщение чата больше не должно автоматически становиться
 * публикацией канала MaxEngagementPostRecord.
 */
export type MaxEngagementChatMessageRecord = {
  id: string;

  /*
   * Здесь channelId означает внутренний ID сообщества
   * в нашем проекте. Название сохраняется для совместимости.
   */
  channelId: string;

  /*
   * Настоящий mid сообщения MAX.
   */
  maxMessageId: string;

  authorUserId: string | null;
  authorName: string | null;
  authorIsBot: boolean;

  text: string;
  postedAt: string | null;

  /*
   * mid сообщения, на которое отвечает участник.
   */
  replyToMaxMessageId: string | null;
  linkedText?: string | null;
  metadataText?: string | null;

  /*
   * Сырые attachments входящего MAX-сообщения. Нужны в том числе для
   * contact-card сообщений, у которых text может быть пустым.
   */
  rawAttachments?: unknown[];

  /*
   * После создания bot action сообщение считается обработанным.
   */
  processedAt?: string | null;
};

export type MaxEngagementGeneratedDraft = {
  text: string;
  safetyReason: string;
};

export type MaxApiPost = {
  id: string;
  channelId: string;
  url?: string;
  authorName?: string;
  text: string;
  postedAt?: string;
  commentsCount?: number;
  reactionsCount?: number;
};

export type MaxApiComment = {
  id: string;
  postId: string;
  threadId: string;
  parentCommentId?: string;
  authorUserId?: string;
  authorName?: string;
  text: string;
  postedAt?: string;
};

export type MaxPublishCommentInput = {
  channelId: string;
  postId: string;
  threadId: string;
  text: string;
};

export type MaxPublishCommentResult = {
  commentId: string;
};

/*
 * Отправка нового сообщения или ответа в обычный групповой чат.
 */
export type MaxSendChatMessageInput = ChatSendMessageInput;

export type MaxSendChatMessageResult = ChatSendMessageResult;

export type MaxChatAdmin = ChatAdmin;

export type MaxDeleteMessageInput = ChatDeleteMessageInput;

export type MaxClient = ChatClient & {
  fetchPosts(
    channel: MaxEngagementChannelRecord
  ): Promise<MaxApiPost[]>;

  fetchComments(
    channel: MaxEngagementChannelRecord,
    post: MaxApiPost
  ): Promise<MaxApiComment[]>;

  publishComment(
    input: MaxPublishCommentInput
  ): Promise<MaxPublishCommentResult>;

  deleteOwnComment(
    channelId: string,
    commentId: string
  ): Promise<void>;

};

export type MaxUpdateType =
  | "bot_added"
  | "bot_started"
  | "bot_stopped"
  | "bot_removed"
  | "chat_title_changed"
  | "dialog_cleared"
  | "dialog_muted"
  | "dialog_unmuted"
  | "dialog_removed"
  | "message_callback"
  | "message_created"
  | "message_edited"
  | "message_removed"
  | "user_added"
  | "user_removed";

export type MaxUpdateUser = {
  user_id?: number | string;

  /*
   * MAX может прислать либо name, либо first_name/last_name.
   */
  name?: string;
  first_name?: string;
  last_name?: string;

  username?: string;
  is_bot?: boolean;
};

export type MaxUpdateRecipient = {
  chat_id?: number | string;
  user_id?: number | string;
  id?: number | string;
  type?: string;

  /*
   * Проверенное значение для обычного группового чата:
   * chat_type: "chat"
   */
  chat_type?: "chat" | "channel" | string;
};

export type MaxUpdateMessage = {
  sender?: MaxUpdateUser;

  recipient?: MaxUpdateRecipient;

  timestamp?: number;

  link?: {
    mid?: string;
    type?: string;
    sender?: MaxUpdateUser;
    chat_id?: number | string;
    message?: MaxUpdateMessage;
  } | null;

  body?: {
    mid?: string;
    text?: string | null;
    attachments?: unknown[] | null;
    format?: unknown;
  } | null;

  stat?: {
    views?: number;
    likes?: number;
    reactions?: number;
    comments?: number;
  } | null;

  url?: string | null;
};

export type MaxUpdate = {
  update_type: MaxUpdateType | string;
  timestamp?: number;
  chat_id?: number | string;
  user?: MaxUpdateUser;
  is_channel?: boolean;
  message?: MaxUpdateMessage;
  payload?: string | null;
};

/*
 * Определяет, является ли событие сообщением обычного чата.
 */
export function isMaxChatMessageUpdate(
  update: MaxUpdate
): boolean {
  return (
    update.update_type === "message_created" &&
    update.message?.recipient?.chat_type === "chat"
  );
}

/*
 * Определяет, относится ли событие к каналу.
 */
export function isMaxChannelMessageUpdate(
  update: MaxUpdate
): boolean {
  return (
    update.update_type === "message_created" &&
    (
      update.is_channel === true ||
      update.message?.recipient?.chat_type === "channel"
    )
  );
}

/*
 * Собирает отображаемое имя участника из разных вариантов,
 * которые может вернуть MAX API.
 */
export function getMaxUpdateUserName(
  user: MaxUpdateUser | undefined
): string | null {
  if (!user) {
    return null;
  }

  const directName = user.name?.trim();
  if (directName) {
    return directName;
  }

  const fullName = [
    user.first_name?.trim(),
    user.last_name?.trim()
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (fullName) {
    return fullName;
  }

  const username = user.username?.trim();
  return username || null;
}
