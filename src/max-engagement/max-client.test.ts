import { describe, expect, it } from "vitest";

import { MockMaxClient } from "./max-client.js";
import type { MaxEngagementChannelRecord } from "./types.js";

const channel: MaxEngagementChannelRecord = {
  id: "channel-db-id",
  maxChannelId: "max-channel-id",
  title: "Тестовый канал",
  channelKind: "moms",
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
  dryRun: true
};

describe("MAX client contract", () => {
  it("returns mock posts and comments using MAX ids", async () => {
    const client = new MockMaxClient();
    const posts = await client.fetchPosts(channel);
    const comments = await client.fetchComments(channel, posts[0]);

    expect(posts).toHaveLength(1);
    expect(posts[0].channelId).toBe(channel.maxChannelId);
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0].postId).toBe(posts[0].id);
    expect(comments[0].threadId).toContain(posts[0].id);
  });
});
