import type {
  MaxEngagementChannelSettings,
  MaxEngagementDecision,
  MaxEngagementPostClassification,
  MaxEngagementPostContext,
  TeasingLevel
} from "./types.js";

const FORCED_NEUTRAL_CLASSIFICATIONS = new Set<MaxEngagementPostClassification>([
  "tragedy",
  "emergency",
  "death",
  "violence",
  "child_harm"
]);

const POLITICAL_CLASSIFICATIONS = new Set<MaxEngagementPostClassification>(["politics", "disputed"]);

function clampTeasingLevel(value: number): TeasingLevel {
  if (value >= 3) {
    return 3;
  }

  if (value >= 2) {
    return 2;
  }

  if (value >= 1) {
    return 1;
  }

  return 0;
}

export function isSensitiveClassification(classification: MaxEngagementPostClassification) {
  return FORCED_NEUTRAL_CLASSIFICATIONS.has(classification);
}

export function forcedTeasingLevel(
  settings: Pick<MaxEngagementChannelSettings, "channelKind" | "politicsTeasingLevel" | "teasingLevel">,
  classification: MaxEngagementPostClassification
): TeasingLevel {
  if (FORCED_NEUTRAL_CLASSIFICATIONS.has(classification)) {
    return 0;
  }

  if (settings.channelKind === "news" && POLITICAL_CLASSIFICATIONS.has(classification)) {
    return clampTeasingLevel(settings.politicsTeasingLevel);
  }

  return clampTeasingLevel(settings.teasingLevel);
}

export function shouldRequireHumanReview(
  settings: Pick<MaxEngagementChannelSettings, "level3Acknowledged" | "level3ReviewPolicy">,
  teasingLevel: TeasingLevel
) {
  return teasingLevel === 3 && (!settings.level3Acknowledged || settings.level3ReviewPolicy === "draft_required");
}

export function decideEngagementAction(
  settings: MaxEngagementChannelSettings,
  context: MaxEngagementPostContext
): MaxEngagementDecision {
  if (!settings.enabled || settings.mode === "off") {
    return neutralSkip("Bot is disabled");
  }

  if (context.threadStatus === "stopped" || context.threadStatus === "muted") {
    return neutralSkip("Thread is stopped or muted");
  }

  if (context.hasStopTrigger) {
    return {
      shouldAct: true,
      actionType: "stop_thread",
      finalTeasingLevel: 0,
      requiresHumanReview: false,
      stopThread: true,
      reason: "Stop trigger detected"
    };
  }

  if (context.replyCountHour >= settings.replyLimitHour || context.replyCountDay >= settings.replyLimitDay) {
    return neutralSkip("Reply rate limit reached");
  }

  if (settings.mode === "mentions_only" && !context.mentionsBot) {
    return neutralSkip("Message does not mention bot");
  }

  if (settings.mode === "questions_only" && !context.isQuestion) {
    return neutralSkip("Message is not a question");
  }

  if (settings.mode === "moderation_only") {
    return {
      shouldAct: true,
      actionType: "moderate",
      finalTeasingLevel: 0,
      requiresHumanReview: false,
      stopThread: false,
      reason: "Moderation-only mode"
    };
  }

  const requestedLevel = forcedTeasingLevel(settings, context.classification);
  const userTeaseLimitReached = context.currentUserTeasesToday >= settings.userTeaseLimitDay;
  const finalLevel = userTeaseLimitReached ? 0 : requestedLevel;

  if (settings.mode === "revive") {
    if (context.initiativeCountHour >= settings.initiativeLimitHour || context.initiativeCountDay >= settings.initiativeLimitDay) {
      return neutralSkip("Initiative rate limit reached");
    }

    return {
      shouldAct: true,
      actionType: "initiative",
      finalTeasingLevel: finalLevel,
      requiresHumanReview: shouldRequireHumanReview(settings, finalLevel),
      stopThread: false,
      reason: userTeaseLimitReached ? "User teasing limit reached; using neutral style" : "Revive mode"
    };
  }

  return {
    shouldAct: true,
    actionType: "reply",
    finalTeasingLevel: finalLevel,
    requiresHumanReview: shouldRequireHumanReview(settings, finalLevel),
    stopThread: false,
    reason: userTeaseLimitReached ? "User teasing limit reached; using neutral style" : "Suitable reply"
  };
}

function neutralSkip(reason: string): MaxEngagementDecision {
  return {
    shouldAct: false,
    finalTeasingLevel: 0,
    requiresHumanReview: false,
    stopThread: false,
    reason
  };
}

