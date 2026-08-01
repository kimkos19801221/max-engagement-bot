import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { LocalEngagementRepository } from "./local-repository.js";
import type { MaxUpdate } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe("LocalEngagementRepository MAX update import", () => {
  it("imports channel posts and linked comments without duplicates", async () => {
    const repository = await createTempRepository();
    await repository.resetDemoData();
    const channelId = 998877;
    const postMid = "post-1";
    const commentMid = "comment-1";

    const first = await repository.importMaxUpdates([
      messageCreatedUpdate({
        chatId: channelId,
        mid: postMid,
        text: "Сегодня открыли новый парк, жители обсуждают чистоту.",
        senderName: "Редакция",
        timestamp: 1_800_000_000_000
      }),
      messageCreatedUpdate({
        chatId: channelId,
        mid: commentMid,
        text: "Ну наконец-то хоть что-то сделали.",
        senderName: "Игорь",
        senderId: 123,
        timestamp: 1_800_000_001_000,
        linkMid: postMid
      })
    ]);
    const second = await repository.importMaxUpdates([
      messageCreatedUpdate({
        chatId: channelId,
        mid: commentMid,
        text: "Ну наконец-то хоть что-то сделали.",
        senderName: "Игорь",
        senderId: 123,
        timestamp: 1_800_000_001_000,
        linkMid: postMid
      })
    ]);

    const data = await repository.read();
    const importedChannel = data.channels.find((channel) => channel.maxChannelId === String(channelId));
    const importedPost = data.posts.find((post) => post.maxPostId === postMid);
    const importedComments = data.comments.filter((comment) => comment.maxCommentId === commentMid);

    expect(first.messages).toBe(2);
    expect(second.skipped).toBe(1);
    expect(importedChannel?.title).toBe(`MAX канал ${channelId}`);
    expect(importedPost?.text).toContain("новый парк");
    expect(importedComments).toHaveLength(1);
    expect(importedComments[0].authorName).toBe("Игорь");
  });
});

async function createTempRepository(): Promise<LocalEngagementRepository> {
  const dir = await mkdtemp(join(tmpdir(), "max-engagement-"));
  tempDirs.push(dir);
  return new LocalEngagementRepository(join(dir, "data.json"));
}

function messageCreatedUpdate(input: {
  chatId: number;
  mid: string;
  text: string;
  senderName: string;
  senderId?: number;
  timestamp: number;
  linkMid?: string;
}): MaxUpdate {
  return {
    update_type: "message_created",
    timestamp: input.timestamp,
    chat_id: input.chatId,
    is_channel: true,
    message: {
      sender: {
        user_id: input.senderId,
        name: input.senderName
      },
      recipient: {
        chat_id: input.chatId
      },
      timestamp: input.timestamp,
      link: input.linkMid ? { mid: input.linkMid } : null,
      body: {
        mid: input.mid,
        text: input.text
      },
      stat: {
        comments: 0,
        reactions: 0
      },
      url: `https://max.ru/channel/post/${input.mid}`
    }
  };
}
