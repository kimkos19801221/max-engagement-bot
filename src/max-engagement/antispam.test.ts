import { describe, expect, it, vi } from "vitest";

import { containsForbiddenLink, moderateChatMessage } from "./antispam.js";
import type {
  MaxApiComment,
  MaxApiPost,
  MaxChatAdmin,
  MaxClient,
  MaxEngagementChannelRecord,
  MaxEngagementChatMessageRecord,
  MaxPublishCommentInput,
  MaxPublishCommentResult,
  MaxSendChatMessageInput,
  MaxSendChatMessageResult
} from "./types.js";

describe("MAX chat antispam", () => {
  it("allows ordinary text and does not call moderation API", async () => {
    const client = new FakeMaxClient();
    const decision = await moderateChatMessage({
      channel: createChannel({ antispamEnabled: true }),
      message: createMessage({ text: "Девочки, кто знает хорошего стоматолога?" }),
      maxClient: client,
      logger: silentLogger()
    });

    expect(decision.reason).toBe("allow");
    expect(decision.shouldStopPipeline).toBe(false);
    expect(client.deleted).toHaveLength(0);
    expect(client.adminChecks).toBe(0);
  });

  it.each([
    "Подписывайтесь https://example.com",
    "Заходите t.me/example",
    "Вакансии здесь https://max.ru/u/example",
    "Пишите на www.example.com",
    "Группа vk.com/example",
    "Чат chat.whatsapp.com/example",
    "Сайт example.com/page"
  ])("blocks participant link: %s", async (text) => {
    const client = new FakeMaxClient();
    const decision = await moderateChatMessage({
      channel: createChannel({ antispamEnabled: true }),
      message: createMessage({ text }),
      maxClient: client,
      logger: silentLogger()
    });

    expect(decision.shouldStopPipeline).toBe(true);
    expect(decision.deleteSucceeded).toBe(true);
    expect(client.deleted).toEqual([{ chatId: "-1", messageId: "mid-1" }]);
  });

  it("blocks a participant forwarded message containing a MAX link", async () => {
    const client = new FakeMaxClient();
    const decision = await moderateChatMessage({
      channel: createChannel({ antispamEnabled: true }),
      message: createMessage({
        text: "Переслала полезное",
        linkedText: "https://max.ru/u/example"
      }),
      maxClient: client,
      logger: silentLogger()
    });

    expect(decision.shouldStopPipeline).toBe(true);
    expect(decision.deleteSucceeded).toBe(true);
  });

  it("blocks a participant message with a hidden formatted link", async () => {
    const client = new FakeMaxClient();
    const decision = await moderateChatMessage({
      channel: createChannel({ antispamEnabled: true }),
      message: createMessage({
        text: "Рыбалка | Клевое Место",
        metadataText: "https://example.com/join"
      }),
      maxClient: client,
      logger: silentLogger()
    });

    expect(decision.shouldStopPipeline).toBe(true);
    expect(decision.deleteSucceeded).toBe(true);
  });

  it("bypasses current chat admins using real author id", async () => {
    const client = new FakeMaxClient([{ userId: "user-1", isAdmin: true, isOwner: false, isBot: false, permissions: ["write"] }]);
    const decision = await moderateChatMessage({
      channel: createChannel({ antispamEnabled: true }),
      message: createMessage({ text: "Наша группа https://max.ru/u/example" }),
      maxClient: client,
      logger: silentLogger()
    });

    expect(decision.reason).toBe("admin_bypass");
    expect(decision.shouldStopPipeline).toBe(false);
    expect(client.deleted).toHaveLength(0);
  });

  it("bypasses Alina's own messages", async () => {
    const client = new FakeMaxClient();
    const decision = await moderateChatMessage({
      channel: createChannel({ antispamEnabled: true }),
      message: createMessage({ text: "https://max.ru/channel/example", authorIsBot: true }),
      maxClient: client,
      logger: silentLogger()
    });

    expect(decision.reason).toBe("self_bypass");
    expect(decision.shouldStopPipeline).toBe(false);
    expect(client.deleted).toHaveLength(0);
  });

  it("can be disabled per chat independently", async () => {
    const client = new FakeMaxClient();
    const enabled = await moderateChatMessage({
      channel: createChannel({ id: "enabled", maxChannelId: "-1", antispamEnabled: true }),
      message: createMessage({ channelId: "enabled", text: "https://example.com" }),
      maxClient: client,
      logger: silentLogger()
    });
    const disabled = await moderateChatMessage({
      channel: createChannel({ id: "disabled", maxChannelId: "-2", antispamEnabled: false }),
      message: createMessage({ channelId: "disabled", text: "https://example.com" }),
      maxClient: client,
      logger: silentLogger()
    });

    expect(enabled.shouldStopPipeline).toBe(true);
    expect(disabled.reason).toBe("antispam_disabled");
    expect(disabled.shouldStopPipeline).toBe(false);
    expect(client.deleted).toEqual([{ chatId: "-1", messageId: "mid-1" }]);
  });

  it("handles delete failure without throwing", async () => {
    const client = new FakeMaxClient();
    client.deleteError = new Error("MAX API DELETE /messages failed with 403");
    const decision = await moderateChatMessage({
      channel: createChannel({ antispamEnabled: true }),
      message: createMessage({ text: "https://example.com" }),
      maxClient: client,
      logger: silentLogger()
    });

    expect(decision.reason).toBe("delete_failed");
    expect(decision.shouldStopPipeline).toBe(true);
    expect(decision.deleteSucceeded).toBe(false);
  });
});

describe("containsForbiddenLink", () => {
  it("does not use an overly aggressive domain heuristic", () => {
    expect(containsForbiddenLink("у меня болит горло. что делать")).toBe(false);
    expect(containsForbiddenLink("мамочки. подскажите стоматолога")).toBe(false);
  });

  it("detects URLs hidden in markdown or HTML markup", () => {
    expect(containsForbiddenLink("[Рыбалка | Клевое Место](https://example.com/join)")).toBe(true);
    expect(containsForbiddenLink('<a href="https://example.com/join">Рыбалка</a>')).toBe(true);
  });
});

class FakeMaxClient implements MaxClient {
  deleted: Array<{ chatId: string; messageId: string }> = [];
  adminChecks = 0;
  deleteError: Error | null = null;

  constructor(private readonly admins: MaxChatAdmin[] = []) {}

  async fetchPosts(): Promise<MaxApiPost[]> {
    return [];
  }

  async fetchComments(): Promise<MaxApiComment[]> {
    return [];
  }

  async publishComment(_input: MaxPublishCommentInput): Promise<MaxPublishCommentResult> {
    return { commentId: "comment" };
  }

  async deleteOwnComment(): Promise<void> {
    return;
  }

  async deleteChatMessage(input: { chatId: string; messageId: string }): Promise<void> {
    if (this.deleteError) {
      throw this.deleteError;
    }
    this.deleted.push(input);
  }

  async listChatAdmins(): Promise<MaxChatAdmin[]> {
    this.adminChecks += 1;
    return this.admins;
  }

  async sendChatMessage(_input: MaxSendChatMessageInput): Promise<MaxSendChatMessageResult> {
    return { messageId: "sent" };
  }
}

function createChannel(input: Partial<MaxEngagementChannelRecord> = {}): MaxEngagementChannelRecord {
  return {
    id: input.id ?? "channel-1",
    maxChannelId: input.maxChannelId ?? "-1",
    title: input.title ?? "Тестовый чат",
    channelKind: "moms",
    communityType: "chat",
    enabled: true,
    antispamEnabled: input.antispamEnabled ?? false,
    antispamDeleteLinks: input.antispamDeleteLinks ?? true,
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
    botName: "Алина",
    ...input
  };
}

function createMessage(input: Partial<MaxEngagementChatMessageRecord> = {}): MaxEngagementChatMessageRecord {
  return {
    id: input.id ?? "message-1",
    channelId: input.channelId ?? "channel-1",
    maxMessageId: input.maxMessageId ?? "mid-1",
    authorUserId: input.authorUserId ?? "user-1",
    authorName: input.authorName ?? "Анна",
    authorIsBot: input.authorIsBot ?? false,
    text: input.text ?? "Сообщение",
    postedAt: new Date(0).toISOString(),
    replyToMaxMessageId: null,
    linkedText: input.linkedText ?? null,
    metadataText: input.metadataText ?? null,
    processedAt: null,
    ...input
  };
}

function silentLogger() {
  return {
    log: vi.fn(),
    error: vi.fn()
  };
}
