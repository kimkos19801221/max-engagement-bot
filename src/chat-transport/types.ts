export type ChatPlatform = "max" | "telegram";

/** Neutral inbound attachment envelope. Raw platform payload is preserved losslessly. */
export type ChatAttachment = {
  kind: string;
  raw: unknown;
};

/** Neutral chat message used below the transport adapters. */
export type UnifiedChatMessage = {
  platform: ChatPlatform;
  externalChatId: string;
  externalMessageId: string;
  chatTitle?: string | null;
  authorId: string | null;
  authorName: string | null;
  authorIsBot: boolean;
  text: string;
  attachments: ChatAttachment[];
  replyToMessageId: string | null;
  linkedText?: string | null;
  metadataText?: string | null;
  postedAt: string;
};

export type ChatSendMessageInput = {
  chatId: string;
  text: string;
  replyToMessageId?: string | null;
  attachments?: unknown[];
};

export type ChatSendMessageResult = {
  messageId: string;
};

export type ChatAdmin = {
  userId: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  isBot: boolean;
  permissions: string[];
};

export type ChatDeleteMessageInput = {
  chatId: string;
  messageId: string;
};

/** Minimal transport contract required by ordinary group-chat processing. */
export type ChatClient = {
  deleteChatMessage(input: ChatDeleteMessageInput): Promise<void>;
  listChatAdmins(chatId: string): Promise<ChatAdmin[]>;
  sendChatMessage(input: ChatSendMessageInput): Promise<ChatSendMessageResult>;
};
