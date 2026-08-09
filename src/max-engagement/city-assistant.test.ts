import { describe, expect, it } from "vitest";

import { buildFallbackCityReply } from "./city-assistant.js";
import type { MaxEngagementChannelRecord, MaxEngagementChatMessageRecord } from "./types.js";

describe("buildFallbackCityReply", () => {
  it("uses a medical-safe reply for headache medication requests", () => {
    const reply = buildFallbackCityReply({
      channel: createChannel(),
      message: createMessage("Девочки подскажите что вы пьете от головы"),
      reason: "OpenAI unavailable"
    });

    expect(reply.shouldReply).toBe(true);
    expect(reply.text).toContain("не советовала конкретные таблетки");
    expect(reply.text).toContain("врача или фармацевта");
  });

  it("answers direct bot mentions in basic mode", () => {
    const reply = buildFallbackCityReply({
      channel: createChannel(),
      message: createMessage("Алина ты здесь?"),
      reason: "OpenAI unavailable"
    });

    expect(reply.shouldReply).toBe(true);
    expect(reply.text).toContain("Я здесь");
  });
});

function createChannel(): MaxEngagementChannelRecord {
  return {
    id: "channel-1",
    maxChannelId: "-1",
    title: "Тест чат",
    channelKind: "moms",
    communityType: "chat",
    enabled: true,
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
    botName: "Алина"
  };
}

function createMessage(text: string): MaxEngagementChatMessageRecord {
  return {
    id: "message-1",
    channelId: "channel-1",
    maxMessageId: "mid-1",
    authorUserId: "user-1",
    authorName: "Дмитрий",
    authorIsBot: false,
    text,
    postedAt: new Date(0).toISOString(),
    replyToMaxMessageId: null,
    processedAt: null
  };
}
