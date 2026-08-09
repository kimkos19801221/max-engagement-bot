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
  it("imports ordinary chat messages separately from channel posts", async () => {
    const repository = await createTempRepository();
    await repository.resetDemoData();
    const chatId = -77530014631231;

    const result = await repository.importMaxUpdates([{
      update_type: "message_created",
      timestamp: 1_800_000_100_000,
      chat_id: chatId,
      message: {
        sender: { user_id: 777, first_name: "Анна", is_bot: false },
        recipient: { chat_id: chatId, chat_type: "chat" },
        timestamp: 1_800_000_100_000,
        body: { mid: "chat-mid-1", text: "Алина, где найти детского стоматолога?" }
      }
    }]);

    const data = await repository.read();
    const importedChannel = data.channels.find((channel) => channel.maxChannelId === String(chatId));
    const messages = await repository.listUnprocessedChatMessages(importedChannel!.id);

    expect(result.messages).toBe(1);
    expect(importedChannel?.communityType).toBe("chat");
    expect(importedChannel?.channelKind).toBe("moms");
    expect(importedChannel?.mode).toBe("suitable_messages");
    expect(importedChannel?.dryRun).toBe(false);
    expect(data.posts.some((post) => post.maxPostId === "chat-mid-1")).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].authorName).toBe("Анна");

    await repository.markChatMessageProcessed(messages[0].id);
    expect(await repository.listUnprocessedChatMessages(importedChannel!.id)).toHaveLength(0);
  });

  it("imports hidden chat message links from formatting metadata", async () => {
    const repository = await createTempRepository();
    await repository.resetDemoData();
    const chatId = -77530014631232;

    await repository.importMaxUpdates([{
      update_type: "message_created",
      timestamp: 1_800_000_100_000,
      chat_id: chatId,
      message: {
        sender: { user_id: 778, first_name: "Анна", is_bot: false },
        recipient: { chat_id: chatId, chat_type: "chat" },
        timestamp: 1_800_000_100_000,
        body: {
          mid: "chat-mid-hidden-link",
          text: "Рыбалка | Клевое Место",
          format: {
            entities: [
              {
                type: "link",
                url: "https://example.com/join"
              }
            ]
          }
        }
      }
    }]);

    const data = await repository.read();
    const importedChannel = data.channels.find((channel) => channel.maxChannelId === String(chatId));
    const messages = await repository.listUnprocessedChatMessages(importedChannel!.id);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Рыбалка | Клевое Место");
    expect(messages[0].linkedText).toContain("https://example.com/join");
    expect(messages[0].metadataText).toContain("https://example.com/join");
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
