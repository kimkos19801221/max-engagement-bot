import { describe, expect, it } from "vitest";

import { hasStopTrigger, looksLikeQuestion } from "./content-safety.js";
import { decideEngagementAction, forcedTeasingLevel } from "./safety.js";
import type { MaxEngagementChannelSettings, MaxEngagementPostContext } from "./types.js";

const baseSettings: MaxEngagementChannelSettings = {
  channelKind: "news",
  enabled: true,
  mode: "suitable_messages",
  teasingLevel: 2,
  level3Acknowledged: false,
  level3ReviewPolicy: "draft_required",
  replyLimitHour: 10,
  replyLimitDay: 100,
  initiativeLimitHour: 2,
  initiativeLimitDay: 10,
  userTeaseLimitDay: 1,
  politicsTeasingLevel: 0
};

const baseContext: MaxEngagementPostContext = {
  classification: "neutral",
  classificationConfidence: 0.9,
  isQuestion: false,
  mentionsBot: false,
  threadStatus: "active",
  currentUserTeasesToday: 0,
  replyCountHour: 0,
  replyCountDay: 0,
  initiativeCountHour: 0,
  initiativeCountDay: 0,
  hasStopTrigger: false
};

describe("MAX engagement safety", () => {
  it("forces neutral teasing for tragic news", () => {
    expect(forcedTeasingLevel(baseSettings, "death")).toBe(0);
    expect(forcedTeasingLevel(baseSettings, "child_harm")).toBe(0);
  });

  it("stops a thread when a complaint trigger appears", () => {
    const decision = decideEngagementAction(baseSettings, {
      ...baseContext,
      hasStopTrigger: true
    });

    expect(decision.actionType).toBe("stop_thread");
    expect(decision.finalTeasingLevel).toBe(0);
    expect(decision.stopThread).toBe(true);
  });

  it("downgrades teasing when the same user was teased today", () => {
    const decision = decideEngagementAction(baseSettings, {
      ...baseContext,
      currentUserTeasesToday: 1
    });

    expect(decision.actionType).toBe("reply");
    expect(decision.finalTeasingLevel).toBe(0);
  });

  it("detects questions and stop-trigger text", () => {
    expect(looksLikeQuestion("А где это купить?")).toBe(true);
    expect(hasStopTrigger("Это грубо, удалите комментарий")).toBe(true);
    expect(hasStopTrigger("Наконец-то хорошие новости, а не вечные жалобы")).toBe(false);
  });
});
