import "dotenv/config";
import { config as loadDotenv } from "dotenv";

import { hasStopTrigger, looksLikeQuestion } from "./max-engagement/content-safety.js";
import { generateDryRunDraft, generatePostInitiativeDraft } from "./max-engagement/draft-generator.js";
import { analyzeCityMessage, generateCityReply } from "./max-engagement/city-assistant.js";
import { createMaxClientFromEnv } from "./max-engagement/max-client.js";
import { MaxEngagementRepository, createSupabaseClientFromEnv, type EngagementRepository } from "./max-engagement/repository.js";
import { decideEngagementAction } from "./max-engagement/safety.js";
import type {
  MaxClient,
  MaxEngagementChannelRecord,
  MaxEngagementChatMessageRecord,
  MaxEngagementCommentRecord,
  MaxEngagementPostContext,
  MaxEngagementPostRecord,
  MaxEngagementThreadRecord,
  TeasingLevel
} from "./max-engagement/types.js";

loadDotenv({ path: ".env.local", override: false });

type WorkerResult = {
  channels: number;
  posts: number;
  comments: number;
  chatMessages: number;
  actions: number;
  posted: number;
  skipped: number;
  failed: number;
};

type ProcessedResult = "skipped" | "drafted" | "posted" | "failed";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export async function runDryRunWorker(
  repository: EngagementRepository = new MaxEngagementRepository(createSupabaseClientFromEnv()),
  maxClient: MaxClient = createMaxClientFromEnv()
): Promise<WorkerResult> {
  const channels = await repository.listRunnableChannels();
  const result: WorkerResult = {
    channels: channels.length,
    posts: 0,
    comments: 0,
    chatMessages: 0,
    actions: 0,
    posted: 0,
    skipped: 0,
    failed: 0
  };

  for (const channel of channels) {
    if ((channel.communityType ?? "channel") === "chat") {
      const messages = await repository.listUnprocessedChatMessages(channel.id);
      result.chatMessages += messages.length;
      for (const message of messages) {
        applyProcessedResult(result, await processChatMessage(repository, maxClient, channel, message));
      }
      continue;
    }

    const comments = await repository.listUnprocessedSubscriberComments(channel.id);
    result.comments += comments.length;

    for (const comment of comments) {
      applyProcessedResult(result, await processComment(repository, maxClient, channel, comment));
    }

    const posts = await repository.listUnprocessedPosts(channel.id);
    result.posts += posts.length;

    for (const post of posts) {
      applyProcessedResult(result, await processPost(repository, maxClient, channel, post));
    }
  }

  return result;
}


async function processChatMessage(
  repository: EngagementRepository,
  maxClient: MaxClient,
  channel: MaxEngagementChannelRecord,
  message: MaxEngagementChatMessageRecord
): Promise<ProcessedResult> {
  const claimed = await repository.claimChatMessage(message.id);
  if (!claimed) {
    return "skipped";
  }

  if (message.authorIsBot || !message.text.trim()) {
    await repository.markChatMessageProcessed(message.id);
    return "skipped";
  }

  const mentionsBot = Boolean(channel.botName && message.text.toLowerCase().includes(channel.botName.toLowerCase()));
  const isQuestion = looksLikeQuestion(message.text);
  const modeAllows =
    channel.mode === "city_assistant" ||
    channel.mode === "suitable_messages" ||
    (channel.mode === "mentions_only" && mentionsBot) ||
    (channel.mode === "questions_only" && isQuestion);

  if (!modeAllows || channel.mode === "moderation_only" || channel.mode === "off") {
    await repository.markChatMessageProcessed(message.id);
    return "skipped";
  }

  const [replyCountHour, replyCountDay, recentMessages] = await Promise.all([
    repository.countActions(channel.id, "reply", new Date(Date.now() - HOUR_MS).toISOString()),
    repository.countActions(channel.id, "reply", new Date(Date.now() - DAY_MS).toISOString()),
    repository.listRecentChatMessages(channel.id, message.postedAt, 30)
  ]);

  if (replyCountHour >= channel.replyLimitHour || replyCountDay >= channel.replyLimitDay) {
    await repository.createBotAction({
      channelId: channel.id, postId: null, chatMessageId: message.id, threadId: null, triggerCommentId: null,
      actionType: "reply", status: "skipped", requestedTeasingLevel: 0, finalTeasingLevel: 0,
      safetyReason: "Chat reply limit reached", generatedText: null, requiresHumanReview: false
    });
    await repository.markChatMessageProcessed(message.id);
    return "skipped";
  }

  const replyToMessage = message.replyToMaxMessageId
    ? recentMessages.find((item) => item.maxMessageId === message.replyToMaxMessageId) ?? null
    : null;

  const memoryPreview = await repository.searchCityMemory({
    query: message.text,
    channelId: channel.id,
    limit: 8
  });

  let plan;
  try {
    plan = await analyzeCityMessage({ channel, message, recentMessages, replyToMessage, memoryPreview });
  } catch (error) {
    const reason = `OpenAI chat analysis skipped: ${error instanceof Error ? error.message : String(error)}`;
    await repository.createBotAction({
      channelId: channel.id, postId: null, chatMessageId: message.id, threadId: null, triggerCommentId: null,
      actionType: "reply", status: "failed", requestedTeasingLevel: 0, finalTeasingLevel: 0,
      safetyReason: reason, generatedText: null, requiresHumanReview: false, errorMessage: reason
    });
    await repository.markChatMessageProcessed(message.id);
    return "failed";
  }

  const hardBlockedRisk =
    plan.riskBehavior === "silent" ||
    plan.riskBehavior === "moderation_review" ||
    plan.risk === "personal_data" ||
    plan.risk === "accusation" ||
    plan.risk === "unverified_treatment";

  if (hardBlockedRisk) {
    await repository.createBotAction({
      channelId: channel.id, postId: null, chatMessageId: message.id, threadId: null, triggerCommentId: null,
      actionType: "reply", status: "skipped", requestedTeasingLevel: 0, finalTeasingLevel: 0,
      safetyReason: `Server risk guard: ${plan.risk}/${plan.riskBehavior}; ${plan.reason}`,
      generatedText: null, requiresHumanReview: plan.riskBehavior === "moderation_review"
    });
    await repository.markChatMessageProcessed(message.id);
    return "skipped";
  }

  if (plan.shouldSaveMemory && plan.memoryCandidate) {
    try {
      await repository.ingestCityMemoryCandidate({
        channel,
        sourceId: message.maxMessageId || message.id,
        authorName: message.authorName,
        text: message.text,
        receivedAt: message.postedAt,
        candidate: plan.memoryCandidate
      });
    } catch (error) {
      console.error(`City memory save skipped for ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const memoryQuery = plan.searchTerms.length > 0
    ? plan.searchTerms.join(" ")
    : [plan.category, plan.subcategory, message.text].filter(Boolean).join(" ");
  const memory = plan.shouldSearchMemory
    ? await repository.searchCityMemory({ query: memoryQuery, channelId: channel.id, limit: 6 })
    : [];

  const latestMessages = await repository.listRecentChatMessages(channel.id, null, 30);
  let draft;
  try {
    draft = await generateCityReply({ channel, message, recentMessages: latestMessages, plan, memory });
  } catch (error) {
    const reason = `OpenAI final reply skipped: ${error instanceof Error ? error.message : String(error)}`;
    await repository.createBotAction({
      channelId: channel.id, postId: null, chatMessageId: message.id, threadId: null, triggerCommentId: null,
      actionType: "reply", status: "failed", requestedTeasingLevel: 0, finalTeasingLevel: 0,
      safetyReason: reason, generatedText: null, requiresHumanReview: false, errorMessage: reason
    });
    await repository.markChatMessageProcessed(message.id);
    return "failed";
  }

  if (!draft.shouldReply || !draft.text.trim()) {
    const isError = draft.safetyReason.startsWith("OpenAI API key") || draft.safetyReason.startsWith("OpenAI chat reply skipped");
    if (isError) {
      await repository.createBotAction({
        channelId: channel.id, postId: null, chatMessageId: message.id, threadId: null, triggerCommentId: null,
        actionType: "reply", status: "failed", requestedTeasingLevel: 0, finalTeasingLevel: 0,
        safetyReason: draft.safetyReason, generatedText: null, requiresHumanReview: false, errorMessage: draft.safetyReason
      });
    }
    await repository.markChatMessageProcessed(message.id);
    return isError ? "failed" : "skipped";
  }

  let status: "draft" | "posted" | "failed" = channel.dryRun ? "draft" : "posted";
  let postedMaxCommentId: string | null = null;
  let errorMessage: string | null = null;
  if (!channel.dryRun) {
    try {
      const published = await maxClient.sendChatMessage({
        chatId: channel.maxChannelId,
        text: draft.text,
        replyToMessageId: message.maxMessageId
      });
      postedMaxCommentId = published.messageId;
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  await repository.createBotAction({
    channelId: channel.id, postId: null, chatMessageId: message.id, threadId: null, triggerCommentId: null,
    actionType: "reply", status, requestedTeasingLevel: 0, finalTeasingLevel: 0,
    safetyReason: draft.safetyReason, generatedText: draft.text, requiresHumanReview: channel.dryRun,
    postedMaxCommentId, errorMessage
  });
  await repository.markChatMessageProcessed(message.id);
  if (status === "posted") return "posted";
  if (status === "failed") return "failed";
  return "drafted";
}

async function processPost(
  repository: EngagementRepository,
  maxClient: MaxClient,
  channel: MaxEngagementChannelRecord,
  post: MaxEngagementPostRecord
): Promise<ProcessedResult> {
  if (!post.text?.trim()) {
    return await saveSkippedPostPreview({
      repository,
      maxClient,
      channel,
      post,
      reason: "Пост найден, но в нём нет текста"
    });
  }

  if (
    channel.mode !== "suitable_messages" &&
    channel.mode !== "revive" &&
    channel.mode !== "questions_only"
  ) {
    return await saveSkippedPostPreview({
      repository,
      maxClient,
      channel,
      post,
      reason: `Пост найден, но текущий режим канала "${channel.mode}" не обрабатывает новые публикации`
    });
  }

  if (channel.mode === "questions_only" && !looksLikeQuestion(post.text)) {
    return await saveSkippedPostPreview({
      repository,
      maxClient,
      channel,
      post,
      reason: "Пост найден, но пропущен режимом «только вопросы»"
    });
  }

  const [initiativeCountHour, initiativeCountDay] = await Promise.all([
    repository.countActions(
      channel.id,
      "initiative",
      new Date(Date.now() - HOUR_MS).toISOString()
    ),
    repository.countActions(
      channel.id,
      "initiative",
      new Date(Date.now() - DAY_MS).toISOString()
    )
  ]);

  const context: MaxEngagementPostContext = {
    classification: post.classification,
    classificationConfidence: post.classificationConfidence,
    isQuestion: looksLikeQuestion(post.text),
    mentionsBot: channel.botName
      ? post.text.toLowerCase().includes(channel.botName.toLowerCase())
      : false,
    threadStatus: "active",
    currentUserTeasesToday: 0,
    replyCountHour: 0,
    replyCountDay: 0,
    initiativeCountHour,
    initiativeCountDay,
    hasStopTrigger: hasStopTrigger(post.text)
  };

  const decision = decideEngagementAction(
    { ...channel, mode: "revive" },
    context
  );

  if (!decision.shouldAct || decision.actionType !== "initiative") {
    return await saveSkippedPostPreview({
      repository,
      maxClient,
      channel,
      post,
      reason: `Пост найден, но правило безопасности решило не отвечать: ${decision.reason}`
    });
  }

  const draft = await generatePostInitiativeDraft({
    channel,
    decision,
    post
  });

  if (!draft.text.trim()) {
    return await createAndMaybePublishAction({
      repository,
      maxClient,
      channel,
      post,
      threadId: null,
      triggerCommentId: null,
      actionType: "initiative",
      requiresHumanReview: true,
      requestedTeasingLevel: channel.teasingLevel,
      finalTeasingLevel: decision.finalTeasingLevel,
      safetyReason: draft.safetyReason,
      text: `⚠️ ИИ не создал комментарий. Причина: ${draft.safetyReason}`,
      replyToMaxMessageId: post.maxPostId
    });
  }

  return await createAndMaybePublishAction({
    repository,
    maxClient,
    channel,
    post,
    threadId: null,
    triggerCommentId: null,
    actionType: "initiative",
    requiresHumanReview: decision.requiresHumanReview,
    requestedTeasingLevel: channel.teasingLevel,
    finalTeasingLevel: decision.finalTeasingLevel,
    safetyReason: draft.safetyReason,
    text: draft.text,
    replyToMaxMessageId: post.maxPostId
  });
}

async function saveSkippedPostPreview(input: {
  repository: EngagementRepository;
  maxClient: MaxClient;
  channel: MaxEngagementChannelRecord;
  post: MaxEngagementPostRecord;
  reason: string;
}): Promise<ProcessedResult> {
  if (!input.channel.dryRun) {
    return "skipped";
  }

  return await createAndMaybePublishAction({
    repository: input.repository,
    maxClient: input.maxClient,
    channel: input.channel,
    post: input.post,
    threadId: null,
    triggerCommentId: null,
    actionType: "initiative",
    requiresHumanReview: true,
    requestedTeasingLevel: input.channel.teasingLevel,
    finalTeasingLevel: input.channel.teasingLevel,
    safetyReason: input.reason,
    text: `⚠️ ${input.reason}`,
    replyToMaxMessageId: input.post.maxPostId
  });
}

async function processComment(
  repository: EngagementRepository,
  maxClient: MaxClient,
  channel: MaxEngagementChannelRecord,
  comment: MaxEngagementCommentRecord
): Promise<ProcessedResult> {
  const [post, thread, replyCountHour, replyCountDay, initiativeCountHour, initiativeCountDay, userTeasesToday] =
    await Promise.all([
      repository.getPost(comment.postId),
      repository.getThread(comment.threadId),
      repository.countActions(channel.id, "reply", new Date(Date.now() - HOUR_MS).toISOString()),
      repository.countActions(channel.id, "reply", new Date(Date.now() - DAY_MS).toISOString()),
      repository.countActions(channel.id, "initiative", new Date(Date.now() - HOUR_MS).toISOString()),
      repository.countActions(channel.id, "initiative", new Date(Date.now() - DAY_MS).toISOString()),
      repository.countUserTeasesToday(channel.id, comment.authorUserId, new Date(Date.now() - DAY_MS).toISOString())
    ]);

  const context = buildCommentContext({
    channel,
    comment,
    post,
    thread,
    replyCountHour,
    replyCountDay,
    initiativeCountHour,
    initiativeCountDay,
    userTeasesToday
  });
  const decision = decideEngagementAction(channel, context);

  if (!decision.shouldAct || !decision.actionType || decision.actionType === "delete_own_comment") {
    return "skipped";
  }

  const draft = await generateDryRunDraft({ channel, comment, decision, post });
  const replyToMaxMessageId = comment.maxCommentId ?? post?.maxPostId ?? "";

  return await createAndMaybePublishAction({
    repository,
    maxClient,
    channel,
    post,
    threadId: comment.threadId,
    triggerCommentId: comment.id,
    actionType: decision.actionType,
    requiresHumanReview: decision.requiresHumanReview,
    requestedTeasingLevel: channel.teasingLevel,
    finalTeasingLevel: decision.finalTeasingLevel,
    safetyReason: draft.safetyReason,
    text: draft.text,
    replyToMaxMessageId
  });
}

async function createAndMaybePublishAction(input: {
  repository: EngagementRepository;
  maxClient: MaxClient;
  channel: MaxEngagementChannelRecord;
  post: MaxEngagementPostRecord | null;
  threadId: string | null;
  triggerCommentId: string | null;
  actionType: "reply" | "initiative" | "moderate" | "stop_thread";
  requiresHumanReview: boolean;
  requestedTeasingLevel: TeasingLevel;
  finalTeasingLevel: TeasingLevel;
  safetyReason: string;
  text: string;
  replyToMaxMessageId: string;
}): Promise<ProcessedResult> {
  const { channel, post } = input;
  let status: "draft" | "queued" | "posted" | "failed" = input.requiresHumanReview || channel.dryRun ? "draft" : "queued";
  let postedMaxCommentId: string | null = null;
  let errorMessage: string | null = null;

  if (status === "queued" && input.text.trim() && input.replyToMaxMessageId) {
    try {
      const published = await input.maxClient.publishComment({
        channelId: channel.maxChannelId,
        postId: input.replyToMaxMessageId,
        threadId: input.replyToMaxMessageId,
        text: input.text
      });
      postedMaxCommentId = published.commentId;
      status = "posted";
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      status = "failed";
    }
  }

  await input.repository.createBotAction({
    channelId: channel.id,
    postId: post?.id ?? "",
    threadId: input.threadId,
    triggerCommentId: input.triggerCommentId,
    actionType: input.actionType,
    status,
    requestedTeasingLevel: input.requestedTeasingLevel,
    finalTeasingLevel: input.finalTeasingLevel,
    safetyReason: input.safetyReason,
    generatedText: input.text || null,
    requiresHumanReview: input.requiresHumanReview,
    postedMaxCommentId,
    errorMessage
  });

  if (status === "posted") return "posted";
  if (status === "failed") return "failed";
  return "drafted";
}

function applyProcessedResult(result: WorkerResult, processed: ProcessedResult): void {
  if (processed === "skipped") {
    result.skipped += 1;
    return;
  }

  result.actions += 1;
  if (processed === "posted") result.posted += 1;
  if (processed === "failed") result.failed += 1;
}

function buildCommentContext(input: {
  channel: MaxEngagementChannelRecord;
  comment: MaxEngagementCommentRecord;
  post: MaxEngagementPostRecord | null;
  thread: MaxEngagementThreadRecord | null;
  replyCountHour: number;
  replyCountDay: number;
  initiativeCountHour: number;
  initiativeCountDay: number;
  userTeasesToday: number;
}): MaxEngagementPostContext {
  return {
    classification: input.post?.classification ?? "unknown",
    classificationConfidence: input.post?.classificationConfidence ?? 0,
    isQuestion: looksLikeQuestion(input.comment.text),
    mentionsBot: input.channel.botName ? input.comment.text.toLowerCase().includes(input.channel.botName.toLowerCase()) : false,
    threadStatus: input.thread?.status ?? "active",
    currentUserTeasesToday: input.userTeasesToday,
    replyCountHour: input.replyCountHour,
    replyCountDay: input.replyCountDay,
    initiativeCountHour: input.initiativeCountHour,
    initiativeCountDay: input.initiativeCountDay,
    hasStopTrigger: hasStopTrigger(input.comment.text)
  };
}

if (process.argv.includes("--once")) {
  runDryRunWorker()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

if (process.argv.includes("--loop")) {
  runLoop().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

async function runLoop(): Promise<void> {
  const intervalMinutes = Number(process.env.MAX_ENGAGEMENT_POLL_MINUTES || 2);
  const intervalMs = Math.max(0.25, intervalMinutes) * 60 * 1000;

  while (true) {
    const result = await runDryRunWorker();
    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          ...result
        },
        null,
        2
      )
    );
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}