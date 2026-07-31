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

