export type MaxEngagementChannelKind = "moms" | "news";

export type MaxEngagementMode =
  | "off"
  | "mentions_only"
  | "questions_only"
  | "suitable_messages"
  | "revive"
  | "moderation_only";

export type MaxEngagementTone = "friendly" | "neutral" | "official" | "conversational";

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

export type MaxEngagementThreadStatus = "active" | "stopped" | "muted" | "review_required";

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
  enabled: boolean;
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

export type MaxEngagementChannelRecord = MaxEngagementChannelSettings & {
  id: string;
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

export type MaxClient = {
  fetchPosts(channel: MaxEngagementChannelRecord): Promise<MaxApiPost[]>;
  fetchComments(channel: MaxEngagementChannelRecord, post: MaxApiPost): Promise<MaxApiComment[]>;
  publishComment(input: MaxPublishCommentInput): Promise<MaxPublishCommentResult>;
  deleteOwnComment(channelId: string, commentId: string): Promise<void>;
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
  name?: string;
  username?: string;
  is_bot?: boolean;
};

export type MaxUpdateMessage = {
  sender?: MaxUpdateUser;
  recipient?: {
    chat_id?: number | string;
    user_id?: number | string;
    id?: number | string;
    type?: string;
  };
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
