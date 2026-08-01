import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { classifyPostText } from "./content-safety.js";
import type { BotActionInput, EngagementRepository } from "./repository.js";
import type {
  MaxApiComment,
  MaxApiPost,
  MaxEngagementChannelRecord,
  MaxEngagementCommentRecord,
  MaxEngagementMode,
  MaxEngagementPostClassification,
  MaxEngagementPostRecord,
  MaxEngagementThreadRecord,
  MaxEngagementThreadStatus,
  MaxUpdate,
  TeasingLevel
} from "./types.js";

export type LocalBotActionRecord = {
  id: string;
  channelId: string;
  postId: string;
  threadId: string | null;
  triggerCommentId: string;
  actionType: BotActionInput["actionType"] | "delete_own_comment";
  status: BotActionInput["status"] | "approved" | "deleted";
  requestedTeasingLevel: TeasingLevel;
  finalTeasingLevel: TeasingLevel;
  safetyReason: string;
  generatedText: string | null;
  requiresHumanReview: boolean;
  createdAt: string;
  reviewedAt: string | null;
  deletedAt: string | null;
};

export type LocalStyleExampleRecord = {
  id: string;
  channelId: string | null;
  exampleType: "admin_message" | "good_tease" | "too_much";
  sourceType: "manual" | "txt" | "csv" | "json" | "screenshot" | "max" | "telegram" | "whatsapp" | "vk";
  text: string;
  notes: string | null;
  createdAt: string;
};

export type LocalToxicityEventRecord = {
  id: string;
  actionId: string | null;
  eventType: string;
  severity: number;
  sourceText: string | null;
  createdAt: string;
};

export type LocalDemoData = {
  maxPolling: {
    marker: number | null;
    importedUpdateKeys: string[];
  };
  channels: MaxEngagementChannelRecord[];
  posts: Array<MaxEngagementPostRecord & {
    sourceUrl?: string | null;
    authorName?: string | null;
    postedAt?: string | null;
    commentsBefore?: number | null;
    reactionsBefore?: number | null;
    commentsAfter?: number | null;
    reactionsAfter?: number | null;
  }>;
  threads: MaxEngagementThreadRecord[];
  comments: MaxEngagementCommentRecord[];
  actions: LocalBotActionRecord[];
  styleExamples: LocalStyleExampleRecord[];
  toxicityEvents: LocalToxicityEventRecord[];
};

export const DEFAULT_LOCAL_DEMO_PATH = resolve(".local-data/max-engagement-demo.json");

export class LocalEngagementRepository implements EngagementRepository {
  constructor(private readonly filePath = process.env.MAX_ENGAGEMENT_LOCAL_DATA || DEFAULT_LOCAL_DEMO_PATH) {}

  async listRunnableChannels(limit = 25): Promise<MaxEngagementChannelRecord[]> {
    const data = await this.read();
    return data.channels
      .filter((channel) => channel.enabled && channel.mode !== "off")
      .slice(0, limit);
  }

  async listUnprocessedSubscriberComments(channelId: string, limit = 50): Promise<MaxEngagementCommentRecord[]> {
    const data = await this.read();
    const processed = new Set(data.actions.map((action) => action.triggerCommentId));
    return data.comments
      .filter((comment) => comment.channelId === channelId && !processed.has(comment.id))
      .slice(0, limit);
  }

  async getPost(postId: string): Promise<MaxEngagementPostRecord | null> {
    const data = await this.read();
    return data.posts.find((post) => post.id === postId) ?? null;
  }

  async getThread(threadId: string | null): Promise<MaxEngagementThreadRecord | null> {
    if (!threadId) {
      return null;
    }
    const data = await this.read();
    return data.threads.find((thread) => thread.id === threadId) ?? null;
  }

  async countActions(channelId: string, actionType: "reply" | "initiative", sinceIso: string): Promise<number> {
    const data = await this.read();
    const since = new Date(sinceIso).getTime();
    return data.actions.filter((action) =>
      action.channelId === channelId &&
      action.actionType === actionType &&
      new Date(action.createdAt).getTime() >= since
    ).length;
  }

  async countUserTeasesToday(channelId: string, authorUserId: string | null, sinceIso: string): Promise<number> {
    if (!authorUserId) {
      return 0;
    }

    const data = await this.read();
    const since = new Date(sinceIso).getTime();
    const triggerIds = new Set(data.comments
      .filter((comment) =>
        comment.channelId === channelId &&
        comment.authorUserId === authorUserId &&
        new Date(comment.postedAt ?? 0).getTime() >= since
      )
      .map((comment) => comment.id));

    return data.actions.filter((action) =>
      action.channelId === channelId &&
      triggerIds.has(action.triggerCommentId) &&
      action.finalTeasingLevel > 0 &&
      new Date(action.createdAt).getTime() >= since
    ).length;
  }

  async createBotAction(input: BotActionInput): Promise<void> {
    await this.update((data) => {
      data.actions.push({
        id: randomUUID(),
        channelId: input.channelId,
        postId: input.postId,
        threadId: input.threadId,
        triggerCommentId: input.triggerCommentId,
        actionType: input.actionType,
        status: input.status,
        requestedTeasingLevel: input.requestedTeasingLevel,
        finalTeasingLevel: input.finalTeasingLevel,
        safetyReason: input.safetyReason,
        generatedText: input.generatedText,
        requiresHumanReview: input.requiresHumanReview,
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        deletedAt: null
      });
    });
  }

  async upsertMaxPost(channel: MaxEngagementChannelRecord, post: MaxApiPost): Promise<MaxEngagementPostRecord> {
    let saved: MaxEngagementPostRecord | null = null;
    await this.update((data) => {
      const classification = classifyPostText(post.text);
      const existing = data.posts.find((item) => item.channelId === channel.id && item.maxPostId === post.id);
      const next = {
        id: existing?.id ?? randomUUID(),
        channelId: channel.id,
        maxPostId: post.id,
        text: post.text,
        classification: classification.classification,
        classificationConfidence: classification.confidence,
        sourceUrl: post.url ?? null,
        authorName: post.authorName ?? null,
        postedAt: post.postedAt ?? null,
        commentsBefore: post.commentsCount ?? null,
        reactionsBefore: post.reactionsCount ?? null,
        commentsAfter: (post.commentsCount ?? 0) + data.comments.filter((comment) => comment.postId === existing?.id).length,
        reactionsAfter: post.reactionsCount ?? null
      };

      if (existing) {
        Object.assign(existing, next);
        saved = existing;
      } else {
        data.posts.push(next);
        saved = next;
      }
    });

    return saved ?? fail("Failed to save local post");
  }

  async upsertMaxThread(channelId: string, postId: string, maxThreadId: string): Promise<MaxEngagementThreadRecord> {
    let saved: MaxEngagementThreadRecord | null = null;
    await this.update((data) => {
      const existing = data.threads.find((thread) => thread.postId === postId && thread.maxThreadId === maxThreadId);
      const next = {
        id: existing?.id ?? randomUUID(),
        channelId,
        postId,
        maxThreadId,
        status: (existing?.status ?? "active") as MaxEngagementThreadStatus
      };

      if (existing) {
        Object.assign(existing, next);
        saved = existing;
      } else {
        data.threads.push(next);
        saved = next;
      }
    });

    return saved ?? fail("Failed to save local thread");
  }

  async upsertMaxComment(
    channelId: string,
    postId: string,
    threadId: string,
    comment: MaxApiComment
  ): Promise<MaxEngagementCommentRecord> {
    let saved: MaxEngagementCommentRecord | null = null;
    await this.update((data) => {
      const existing = data.comments.find((item) => item.channelId === channelId && item.maxCommentId === comment.id);
      const next = {
        id: existing?.id ?? randomUUID(),
        channelId,
        postId,
        threadId,
        maxCommentId: comment.id,
        authorUserId: comment.authorUserId ?? null,
        authorName: comment.authorName ?? null,
        text: comment.text,
        postedAt: comment.postedAt ?? null
      };

      if (existing) {
        Object.assign(existing, next);
        saved = existing;
      } else {
        data.comments.push(next);
        saved = next;
      }
    });

    return saved ?? fail("Failed to save local comment");
  }

  async listActions(filters: { view?: string | null; level?: string | null } = {}): Promise<LocalBotActionRecord[]> {
    const data = await this.read();
    return data.actions
      .filter((action) => filters.view !== "teases" || action.finalTeasingLevel > 0)
      .filter((action) => filters.level !== "3" || action.finalTeasingLevel === 3)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async updateAction(id: string, command: "approve" | "skip" | "stop-thread" | "delete-own"): Promise<void> {
    await this.update((data) => {
      const action = data.actions.find((item) => item.id === id);
      if (!action) {
        throw new Error("Action not found");
      }

      action.reviewedAt = new Date().toISOString();
      if (command === "approve") {
        action.status = "approved";
      }
      if (command === "skip") {
        action.status = "skipped";
      }
      if (command === "delete-own") {
        action.actionType = "delete_own_comment";
        action.status = "deleted";
        action.deletedAt = new Date().toISOString();
      }
      if (command === "stop-thread") {
        action.status = "skipped";
        action.safetyReason = "Skipped because thread was stopped from local demo admin";
        const thread = data.threads.find((item) => item.id === action.threadId);
        if (thread) {
          thread.status = "stopped";
        }
      }
    });
  }

  async listChannels(): Promise<MaxEngagementChannelRecord[]> {
    const data = await this.read();
    return data.channels;
  }

  async updateChannel(id: string, patch: Partial<MaxEngagementChannelRecord>): Promise<void> {
    await this.update((data) => {
      const channel = data.channels.find((item) => item.id === id);
      if (!channel) {
        throw new Error("Channel not found");
      }

      Object.assign(channel, normalizeChannelPatch(patch));
    });
  }

  async listStyleExamples(channelId?: string | null): Promise<LocalStyleExampleRecord[]> {
    const data = await this.read();
    return data.styleExamples
      .filter((example) => !channelId || channelId === "all" || example.channelId === channelId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createStyleExamples(input: {
    channelId: string | null;
    exampleType: LocalStyleExampleRecord["exampleType"];
    sourceType: LocalStyleExampleRecord["sourceType"];
    texts: string[];
    notes: string | null;
  }): Promise<number> {
    const rows = input.texts.map((text) => text.trim()).filter(Boolean).slice(0, 100);
    await this.update((data) => {
      for (const text of rows) {
        data.styleExamples.push({
          id: randomUUID(),
          channelId: input.channelId,
          exampleType: input.exampleType,
          sourceType: input.sourceType,
          text,
          notes: input.notes,
          createdAt: new Date().toISOString()
        });
      }
    });
    return rows.length;
  }

  async deleteStyleExample(id: string): Promise<void> {
    await this.update((data) => {
      data.styleExamples = data.styleExamples.filter((example) => example.id !== id);
    });
  }

  async getMaxPollingMarker(): Promise<number | null> {
    const data = await this.read();
    return data.maxPolling?.marker ?? null;
  }

  async setMaxPollingMarker(marker: number | null): Promise<void> {
    await this.update((data) => {
      data.maxPolling.marker = marker;
    });
  }

  async importMaxUpdates(updates: MaxUpdate[]): Promise<{
    received: number;
    imported: number;
    channels: number;
    messages: number;
    skipped: number;
  }> {
    const result = {
      received: updates.length,
      imported: 0,
      channels: 0,
      messages: 0,
      skipped: 0
    };

    await this.update((data) => {
      for (const update of updates) {
        const updateKey = getUpdateKey(update);
        if (data.maxPolling.importedUpdateKeys.includes(updateKey)) {
          result.skipped += 1;
          continue;
        }

        data.maxPolling.importedUpdateKeys.push(updateKey);
        const channel = upsertChannelFromUpdate(data, update);
        if (channel.created) {
          result.channels += 1;
        }

        if (update.update_type === "message_created" && update.message && channel.record) {
          const importedMessage = upsertMessageCreatedUpdate(data, channel.record, update);
          if (importedMessage) {
            result.messages += 1;
          } else {
            result.skipped += 1;
          }
        }

        result.imported += 1;
      }

      data.maxPolling.importedUpdateKeys = data.maxPolling.importedUpdateKeys.slice(-5000);
    });

    return result;
  }

  async analyticsSummary() {
    const data = await this.read();
    const botTeases = data.actions.filter((action) => action.finalTeasingLevel > 0).length;
    return {
      totals: {
        posts: data.posts.length,
        subscriberComments: data.comments.length,
        botActions: data.actions.length,
        botTeases,
        level3: data.actions.filter((action) => action.finalTeasingLevel === 3).length,
        toxicityEvents: data.toxicityEvents.length,
        toxicityIndex: botTeases === 0 ? 0 : Number((data.toxicityEvents.length / botTeases).toFixed(3))
      },
      engagement: data.posts.map((post) => ({
        postId: post.id,
        channelTitle: data.channels.find((channel) => channel.id === post.channelId)?.title ?? null,
        postText: post.text,
        commentsBefore: post.commentsBefore ?? null,
        commentsAfter: post.commentsAfter ?? data.comments.filter((comment) => comment.postId === post.id).length,
        reactionsBefore: post.reactionsBefore ?? null,
        reactionsAfter: post.reactionsAfter ?? null,
        commentDelta:
          post.commentsBefore === null || post.commentsBefore === undefined
            ? null
            : (post.commentsAfter ?? data.comments.filter((comment) => comment.postId === post.id).length) - post.commentsBefore,
        reactionDelta:
          post.reactionsBefore === null || post.reactionsAfter === null || post.reactionsBefore === undefined || post.reactionsAfter === undefined
            ? null
            : post.reactionsAfter - post.reactionsBefore
      })),
      topToxicity: data.toxicityEvents
    };
  }

  async resetDemoData(): Promise<void> {
    await this.write(createSeedData());
  }

  async read(): Promise<LocalDemoData> {
    try {
      return normalizeLocalDemoData(JSON.parse(await readFile(this.filePath, "utf8")) as Partial<LocalDemoData>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const data = createSeedData();
      await this.write(data);
      return data;
    }
  }

  private async update(mutator: (data: LocalDemoData) => void): Promise<void> {
    const data = await this.read();
    mutator(data);
    await this.write(data);
  }

  private async write(data: LocalDemoData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

export function createSeedData(): LocalDemoData {
  const momsChannelId = randomUUID();
  const newsChannelId = randomUUID();
  const now = new Date().toISOString();

  const channels: MaxEngagementChannelRecord[] = [
    createChannel({
      id: momsChannelId,
      maxChannelId: "max-demo-moms",
      title: "Мамочки: демо-паблик",
      channelKind: "moms",
      mode: "suitable_messages",
      teasingLevel: 1,
      botName: "МамаBot",
      botSignature: "- админ канала"
    }),
    createChannel({
      id: newsChannelId,
      maxChannelId: "max-demo-news",
      title: "Новости: демо-паблик",
      channelKind: "news",
      mode: "revive",
      teasingLevel: 2,
      politicsTeasingLevel: 0,
      botName: "NewsBot",
      botSignature: "- редакция"
    })
  ];

  const momsPostId = randomUUID();
  const newsPostId = randomUUID();
  const tragedyPostId = randomUUID();
  const momsThreadId = randomUUID();
  const newsThreadId = randomUUID();
  const tragedyThreadId = randomUUID();

  return {
    maxPolling: {
      marker: null,
      importedUpdateKeys: []
    },
    channels,
    posts: [
      createPost(momsPostId, momsChannelId, "max-demo-moms-post-1", "Мамочки, как вы укладываете детей спать летом, когда дома жарко?", "neutral", 0, 4),
      createPost(newsPostId, newsChannelId, "max-demo-news-post-1", "Во дворе открыли новую детскую площадку и уже спорят, кто должен следить за чистотой.", "disputed", 2, 7),
      createPost(tragedyPostId, newsChannelId, "max-demo-news-post-2", "После ДТП в районе перекрыли движение, есть пострадавшие.", "emergency", 5, 12)
    ],
    threads: [
      createThread(momsThreadId, momsChannelId, momsPostId, "max-demo-moms-thread-1"),
      createThread(newsThreadId, newsChannelId, newsPostId, "max-demo-news-thread-1"),
      createThread(tragedyThreadId, newsChannelId, tragedyPostId, "max-demo-news-thread-2")
    ],
    comments: [
      createComment(momsChannelId, momsPostId, momsThreadId, "max-demo-comment-1", "demo-user-1", "Анна", "А если ребенок вообще не спит днем, это нормально?", now),
      createComment(newsChannelId, newsPostId, newsThreadId, "max-demo-comment-2", "demo-user-2", "Игорь", "Ну конечно, площадку открыли, а лавочки опять забыли.", now),
      createComment(newsChannelId, tragedyPostId, tragedyThreadId, "max-demo-comment-3", "demo-user-3", "Мария", "Это ужасно, надеюсь все живы.", now),
      createComment(newsChannelId, newsPostId, newsThreadId, "max-demo-comment-4", "demo-user-4", "Олег", "Удалите это, грубо звучит.", now)
    ],
    actions: [],
    styleExamples: [
      {
        id: randomUUID(),
        channelId: momsChannelId,
        exampleType: "admin_message",
        sourceType: "manual",
        text: "Давайте спокойно, у всех дети разные, тут лучше без соревнований.",
        notes: "Мягкий тон администратора",
        createdAt: now
      },
      {
        id: randomUUID(),
        channelId: newsChannelId,
        exampleType: "too_much",
        sourceType: "manual",
        text: "Да вы и драматизируете.",
        notes: "Перебор для новостного паблика",
        createdAt: now
      }
    ],
    toxicityEvents: []
  };
}

function normalizeLocalDemoData(data: Partial<LocalDemoData>): LocalDemoData {
  const seed = createSeedData();
  return {
    maxPolling: {
      marker: data.maxPolling?.marker ?? null,
      importedUpdateKeys: Array.isArray(data.maxPolling?.importedUpdateKeys) ? data.maxPolling.importedUpdateKeys : []
    },
    channels: data.channels ?? seed.channels,
    posts: data.posts ?? seed.posts,
    threads: data.threads ?? seed.threads,
    comments: data.comments ?? seed.comments,
    actions: data.actions ?? [],
    styleExamples: data.styleExamples ?? seed.styleExamples,
    toxicityEvents: data.toxicityEvents ?? []
  };
}

function getUpdateKey(update: MaxUpdate): string {
  const messageId = update.message?.body?.mid;
  return [
    update.update_type,
    update.chat_id ?? update.message?.recipient?.chat_id ?? "no-chat",
    messageId ?? update.timestamp ?? "no-time"
  ].join(":");
}

function upsertChannelFromUpdate(data: LocalDemoData, update: MaxUpdate): {
  record: MaxEngagementChannelRecord | null;
  created: boolean;
} {
  const chatId = update.chat_id ?? update.message?.recipient?.chat_id;
  if (chatId === undefined || chatId === null) {
    return { record: null, created: false };
  }

  const maxChannelId = String(chatId);
  const existing = data.channels.find((channel) => channel.maxChannelId === maxChannelId);
  if (existing) {
    return { record: existing, created: false };
  }

  const channel = createChannel({
    id: randomUUID(),
    maxChannelId,
    title: update.is_channel ? `MAX канал ${maxChannelId}` : `MAX чат ${maxChannelId}`,
    channelKind: "news",
    mode: "suitable_messages",
    teasingLevel: 1,
    politicsTeasingLevel: 0,
    botName: "MAX Bot",
    botSignature: "- админ"
  });
  data.channels.push(channel);
  return { record: channel, created: true };
}

function upsertMessageCreatedUpdate(data: LocalDemoData, channel: MaxEngagementChannelRecord, update: MaxUpdate): boolean {
  const message = update.message;
  const text = message?.body?.text?.trim();
  const messageId = message?.body?.mid;
  if (!message || !messageId || !text) {
    return false;
  }

  const senderId = message.sender?.user_id;
  const senderName = message.sender?.name || message.sender?.username || null;
  const postedAt = typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : new Date(update.timestamp ?? Date.now()).toISOString();
  const linkedMessageId = message.link?.mid ?? message.link?.message?.body?.mid ?? null;

  if (!linkedMessageId) {
    const post = upsertLocalPost(data, channel, {
      maxPostId: String(messageId),
      text,
      sourceUrl: message.url ?? null,
      authorName: senderName,
      postedAt,
      commentsBefore: message.stat?.comments ?? 0,
      reactionsBefore: message.stat?.reactions ?? message.stat?.likes ?? null
    });
    upsertLocalThread(data, channel.id, post.id, String(messageId));
    return true;
  }

  const post = upsertLocalPost(data, channel, {
    maxPostId: String(linkedMessageId),
    text: message.link?.message?.body?.text ?? data.posts.find((item) => item.channelId === channel.id && item.maxPostId === String(linkedMessageId))?.text ?? "MAX post from linked message",
    sourceUrl: message.url ?? null,
    authorName: message.link?.sender?.name ?? null,
    postedAt,
    commentsBefore: null,
    reactionsBefore: null
  });
  const thread = upsertLocalThread(data, channel.id, post.id, String(linkedMessageId));
  upsertLocalComment(data, channel.id, post.id, thread.id, {
    maxCommentId: String(messageId),
    authorUserId: senderId === undefined || senderId === null ? null : String(senderId),
    authorName: senderName,
    text,
    postedAt
  });
  return true;
}

function upsertLocalPost(data: LocalDemoData, channel: MaxEngagementChannelRecord, input: {
  maxPostId: string;
  text: string;
  sourceUrl: string | null;
  authorName: string | null;
  postedAt: string;
  commentsBefore: number | null;
  reactionsBefore: number | null;
}) {
  const existing = data.posts.find((post) => post.channelId === channel.id && post.maxPostId === input.maxPostId);
  const classification = classifyPostText(input.text);
  const next = {
    id: existing?.id ?? randomUUID(),
    channelId: channel.id,
    maxPostId: input.maxPostId,
    text: input.text,
    classification: classification.classification,
    classificationConfidence: classification.confidence,
    sourceUrl: input.sourceUrl,
    authorName: input.authorName,
    postedAt: input.postedAt,
    commentsBefore: input.commentsBefore,
    reactionsBefore: input.reactionsBefore,
    commentsAfter: input.commentsBefore,
    reactionsAfter: input.reactionsBefore
  };

  if (existing) {
    Object.assign(existing, next);
    return existing;
  }

  data.posts.push(next);
  return next;
}

function upsertLocalThread(data: LocalDemoData, channelId: string, postId: string, maxThreadId: string): MaxEngagementThreadRecord {
  const existing = data.threads.find((thread) => thread.postId === postId && thread.maxThreadId === maxThreadId);
  if (existing) {
    return existing;
  }

  const thread: MaxEngagementThreadRecord = {
    id: randomUUID(),
    channelId,
    postId,
    maxThreadId,
    status: "active"
  };
  data.threads.push(thread);
  return thread;
}

function upsertLocalComment(data: LocalDemoData, channelId: string, postId: string, threadId: string, input: {
  maxCommentId: string;
  authorUserId: string | null;
  authorName: string | null;
  text: string;
  postedAt: string;
}) {
  const existing = data.comments.find((comment) => comment.channelId === channelId && comment.maxCommentId === input.maxCommentId);
  const next = {
    id: existing?.id ?? randomUUID(),
    channelId,
    postId,
    threadId,
    maxCommentId: input.maxCommentId,
    authorUserId: input.authorUserId,
    authorName: input.authorName,
    text: input.text,
    postedAt: input.postedAt
  };

  if (existing) {
    Object.assign(existing, next);
    return existing;
  }

  data.comments.push(next);
  return next;
}

function createChannel(input: {
  id: string;
  maxChannelId: string;
  title: string;
  channelKind: "moms" | "news";
  mode: MaxEngagementMode;
  teasingLevel: TeasingLevel;
  politicsTeasingLevel?: TeasingLevel;
  botName: string;
  botSignature: string;
}): MaxEngagementChannelRecord {
  return {
    ...input,
    enabled: true,
    level3Acknowledged: false,
    level3ReviewPolicy: "draft_required",
    replyLimitHour: 20,
    replyLimitDay: 120,
    initiativeLimitHour: 3,
    initiativeLimitDay: 15,
    userTeaseLimitDay: 1,
    politicsTeasingLevel: input.politicsTeasingLevel ?? 0,
    dryRun: true
  };
}

function createPost(
  id: string,
  channelId: string,
  maxPostId: string,
  text: string,
  classification: MaxEngagementPostClassification,
  commentsBefore: number,
  reactionsBefore: number
) {
  return {
    id,
    channelId,
    maxPostId,
    text,
    classification,
    classificationConfidence: 0.8,
    commentsBefore,
    reactionsBefore,
    commentsAfter: commentsBefore,
    reactionsAfter: reactionsBefore
  };
}

function createThread(id: string, channelId: string, postId: string, maxThreadId: string): MaxEngagementThreadRecord {
  return {
    id,
    channelId,
    postId,
    maxThreadId,
    status: "active"
  };
}

function createComment(
  channelId: string,
  postId: string,
  threadId: string,
  maxCommentId: string,
  authorUserId: string,
  authorName: string,
  text: string,
  postedAt: string
): MaxEngagementCommentRecord {
  return {
    id: randomUUID(),
    channelId,
    postId,
    threadId,
    maxCommentId,
    authorUserId,
    authorName,
    text,
    postedAt
  };
}

function normalizeChannelPatch(patch: Partial<MaxEngagementChannelRecord>): Partial<MaxEngagementChannelRecord> {
  const next = { ...patch };
  if (typeof next.teasingLevel === "number") {
    next.teasingLevel = toTeasingLevel(next.teasingLevel);
  }
  if (typeof next.politicsTeasingLevel === "number") {
    next.politicsTeasingLevel = toTeasingLevel(next.politicsTeasingLevel);
  }
  return next;
}

function toTeasingLevel(value: number): TeasingLevel {
  if (value >= 3) return 3;
  if (value >= 2) return 2;
  if (value >= 1) return 1;
  return 0;
}

function fail(message: string): never {
  throw new Error(message);
}
