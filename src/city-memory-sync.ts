import "dotenv/config";

import { config as loadDotenv } from "dotenv";

import { LocalEngagementRepository } from "./max-engagement/local-repository.js";

loadDotenv({ path: ".env.local", override: false });

const repository = new LocalEngagementRepository();

try {
  const data = await repository.read();
  let sources = 0;
  let objects = 0;
  let knowledge = 0;
  let blocked = 0;
  let revisions = 0;

  for (const post of data.posts) {
    const channel = data.channels.find((item) => item.id === post.channelId);
    if (!channel || !post.text) continue;
    const result = await repository.ingestCityMemoryFromMessage({
      channel,
      sourceType: "post",
      sourceId: post.maxPostId,
      authorName: post.authorName ?? null,
      text: post.text,
      url: post.sourceUrl ?? null,
      receivedAt: post.postedAt ?? null
    });
    sources += result.sources;
    objects += result.objects;
    knowledge += result.knowledge;
    blocked += result.blocked;
    revisions += result.revisions;
  }

  for (const comment of data.comments) {
    const channel = data.channels.find((item) => item.id === comment.channelId);
    if (!channel || !comment.text || comment.authorName === channel.botName) continue;
    const result = await repository.ingestCityMemoryFromMessage({
      channel,
      sourceType: "comment",
      sourceId: comment.maxCommentId ?? comment.id,
      authorName: comment.authorName,
      text: comment.text,
      receivedAt: comment.postedAt
    });
    sources += result.sources;
    objects += result.objects;
    knowledge += result.knowledge;
    blocked += result.blocked;
    revisions += result.revisions;
  }

  console.log(JSON.stringify({
    sources,
    objects,
    knowledge,
    blocked,
    revisions,
    summary: await repository.cityMemorySummary()
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
