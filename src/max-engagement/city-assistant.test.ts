import { describe, expect, it } from "vitest";

import { buildFallbackCityReply, containsUnsupportedResidentAttribution, isExplicitLocalLookupRequest } from "./city-assistant.js";
import type { MaxEngagementChannelRecord, MaxEngagementChatMessageRecord } from "./types.js";

describe("buildFallbackCityReply", () => {
  it("stays silent for medication requests when the main AI pipeline is unavailable", () => {
    const reply = buildFallbackCityReply({
      channel: createChannel(),
      message: createMessage("girls, what do you take for headache?"),
      reason: "OpenAI unavailable"
    });

    expect(reply.shouldReply).toBe(false);
    expect(reply.text).toBe("");
    expect(reply.safetyReason).toContain("Fallback silent");
  });

  it("stays silent for direct bot mentions when the main AI pipeline is unavailable", () => {
    const reply = buildFallbackCityReply({
      channel: createChannel(),
      message: createMessage("Alina are you here?"),
      reason: "OpenAI unavailable"
    });

    expect(reply.shouldReply).toBe(false);
    expect(reply.text).toBe("");
    expect(reply.safetyReason).toContain("Fallback silent");
  });
});

describe("isExplicitLocalLookupRequest", () => {
  it.each([
    "Где найти морскую свинку?",
    "Где в Норильске находится православная церковь?",
    "По какому адресу принимает врач?",
    "Есть ли у нас частные садики?",
    "Кто оказывает услуги сантехника?"
  ])("recognizes a high-confidence local lookup: %s", (text) => {
    expect(isExplicitLocalLookupRequest(text)).toBe(true);
  });

  it.each([
    "Есть ли польза от витаминов?",
    "Есть ли смысл покупать увлажнитель?",
    "Есть ли противопоказания?"
  ])("does not turn a general question into a local lookup: %s", (text) => {
    expect(isExplicitLocalLookupRequest(text)).toBe(false);
  });
});

describe("containsUnsupportedResidentAttribution", () => {
  it("blocks an unsupported attribution using production wording", () => {
    expect(containsUnsupportedResidentAttribution(
      "В Норильске есть частные садики, как отмечала одна из жительниц города.",
      [],
      []
    )).toBe(true);
  });

  it("allows attribution backed by a cited resident fact", () => {
    expect(containsUnsupportedResidentAttribution(
      "Как отмечала одна из жительниц города, адрес — Мира 6.",
      ["fact-1"],
      [{ id: "fact-1", trust: "single_resident" }]
    )).toBe(false);
  });
});

function createChannel(): MaxEngagementChannelRecord {
  return {
    id: "channel-1",
    maxChannelId: "-1",
    title: "Test chat",
    channelKind: "moms",
    communityType: "chat",
    enabled: true,
    antispamEnabled: false,
    antispamDeleteLinks: true,
    mode: "suitable_messages",
    teasingLevel: 1,
    level3Acknowledged: false,
    level3ReviewPolicy: "draft_required",
    replyLimitHour: 20,
    replyLimitDay: 120,
    initiativeLimitHour: 3,
    initiativeLimitDay: 15,
    userTeaseLimitDay: 1,
    politicsTeasingLevel: 0,
    dryRun: false,
    botName: "Alina"
  };
}

function createMessage(text: string): MaxEngagementChatMessageRecord {
  return {
    id: "message-1",
    channelId: "channel-1",
    maxMessageId: "mid-1",
    authorUserId: "user-1",
    authorName: "Dmitry",
    authorIsBot: false,
    text,
    postedAt: new Date(0).toISOString(),
    replyToMaxMessageId: null,
    processedAt: null
  };
}
