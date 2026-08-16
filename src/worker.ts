import "dotenv/config";
import { config as loadDotenv } from "dotenv";

import { hasStopTrigger, looksLikeQuestion } from "./max-engagement/content-safety.js";
import { generateDryRunDraft, generatePostInitiativeDraft } from "./max-engagement/draft-generator.js";
import { analyzeCityMessage, buildFallbackCityReply, generateCityReply, type CityAssistantReply } from "./max-engagement/city-assistant.js";
import type { CityMemoryCandidate } from "./city-memory/types.js";
import { moderateChatMessage } from "./max-engagement/antispam.js";
import {
  buildFallbackContactDirectoryCandidate,
  buildMaxContactAttachments,
  classifyProfessionalContactAttachment,
  formatContactDirectoryText,
  hasContactAttachment,
  hasRawAttachments,
  type ContactDirectoryRecord
} from "./max-engagement/contact-directory.js";
import { extractCityMemoryCandidatesFromMessage } from "./max-engagement/city-memory-extractor.js";
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

import type { ChatClient, ChatPlatform } from "./chat-transport/types.js";
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
  const channels = (await repository.listRunnableChannels()).filter(
    (channel) => (channel.platform ?? "max") === "max"
  );
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
        applyProcessedResult(
          result,
          await processChatMessageSafely(repository, maxClient, channel, message)
        );
      }
      continue;
    }

    const comments = await repository.listUnprocessedSubscriberComments(channel.id);
    result.comments += comments.length;

    for (const comment of comments) {
      applyProcessedResult(
        result,
        await processCommentSafely(repository, maxClient, channel, comment)
      );
    }

    const posts = await repository.listUnprocessedPosts(channel.id);
    result.posts += posts.length;

    for (const post of posts) {
      applyProcessedResult(
        result,
        await processPostSafely(repository, maxClient, channel, post)
      );
    }
  }

  return result;
}

export async function runChatWorker(
  repository: EngagementRepository,
  chatClient: ChatClient,
  platform: ChatPlatform
): Promise<WorkerResult> {
  const channels = (await repository.listRunnableChannels()).filter((channel) =>
    (channel.platform ?? "max") === platform && (channel.communityType ?? "channel") === "chat"
  );
  const result: WorkerResult = {
    channels: channels.length, posts: 0, comments: 0, chatMessages: 0, actions: 0, posted: 0, skipped: 0, failed: 0
  };

  for (const channel of channels) {
    const messages = await repository.listUnprocessedChatMessages(channel.id);
    result.chatMessages += messages.length;
    for (const message of messages) {
      applyProcessedResult(result, await processChatMessageSafely(repository, chatClient, channel, message));
    }
  }

  return result;
}

async function processChatMessageSafely(
  repository: EngagementRepository,
  maxClient: ChatClient,
  channel: MaxEngagementChannelRecord,
  message: MaxEngagementChatMessageRecord
): Promise<ProcessedResult> {
  try {
    return await processChatMessage(repository, maxClient, channel, message);
  } catch (error) {
    const errorMessage = formatWorkerError(error);
    console.error(`[worker] chat_message_failed channel=${channel.id} message=${message.id}: ${errorMessage}`);

    await createFailedActionSafely(repository, {
      channelId: channel.id,
      postId: null,
      chatMessageId: message.id,
      threadId: null,
      triggerCommentId: null,
      actionType: "reply",
      safetyReason: "Chat message processing failed",
      errorMessage
    });
    await markChatMessageProcessedSafely(repository, message.id);
    return "failed";
  }
}

async function processChatMessage(
  repository: EngagementRepository,
  maxClient: ChatClient,
  channel: MaxEngagementChannelRecord,
  message: MaxEngagementChatMessageRecord
): Promise<ProcessedResult> {
  const claimed = await repository.claimChatMessage(message.id);
  if (!claimed) {
    return "skipped";
  }

  if (!message.text.trim() && !hasRawAttachments(message)) {
    await repository.markChatMessageProcessed(message.id);
    return "skipped";
  }

  const antispam = await moderateChatMessage({
    channel,
    message,
    maxClient
  });

  if (antispam.shouldStopPipeline) {
    await repository.createBotAction({
      channelId: channel.id,
      postId: null,
      chatMessageId: message.id,
      threadId: null,
      triggerCommentId: null,
      actionType: "moderate",
      status: antispam.deleteSucceeded ? "deleted" : "failed",
      requestedTeasingLevel: 0,
      finalTeasingLevel: 0,
      safetyReason: antispam.deleteSucceeded ? "blocked_link/delete_success" : "blocked_link/delete_failed",
      generatedText: null,
      requiresHumanReview: false,
      errorMessage: antispam.errorMessage ?? null
    });
    await repository.markChatMessageProcessed(message.id);
    return antispam.deleteSucceeded ? "skipped" : "failed";
  }

  if (message.authorIsBot) {
    await repository.markChatMessageProcessed(message.id);
    return "skipped";
  }

  /*
   * Отдельный тихий pipeline для карточек контактов специалистов.
   * Он выполняется до reply-rate-limit: сохранение контакта не является публичным ответом.
   * Сырые attachments уже сохранены repository, поэтому даже неизвестный формат MAX
   * не теряется и может быть изучен позже.
   */
  if (hasRawAttachments(message)) {
    let contactSaved = false;
    try {
      const contactContext = await repository.listRecentChatMessages(channel.id, message.postedAt, 12);
      const candidate = await classifyProfessionalContactAttachment({
        channel,
        message,
        recentMessages: contactContext
      });

      if (candidate) {
        await repository.saveContactDirectoryCandidate({ channel, message, candidate });
        contactSaved = true;
      }

      if (!contactSaved && hasContactAttachment(message)) {
        const fallbackCandidate = buildFallbackContactDirectoryCandidate({
          message,
          recentMessages: contactContext
        });
        if (fallbackCandidate) {
          await repository.saveContactDirectoryCandidate({ channel, message, candidate: fallbackCandidate });
          contactSaved = true;
        }
      }
    } catch (error) {
      console.error(`[worker] contact_directory_save_skipped channel=${channel.id} message=${message.id}: ${formatWorkerError(error)}`);
    }

    // Contact-only/attachment-only messages should never fall through into the normal
    // text assistant if the contact classifier did not confidently classify them.
    if (!message.text.trim()) {
      await repository.markChatMessageProcessed(message.id);
      return "skipped";
    }
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
    repository.listRecentChatMessages(channel.id, message.postedAt, 40)
  ]);

  const replyToMessage = message.replyToMaxMessageId
    ? recentMessages.find((item) => item.maxMessageId === message.replyToMaxMessageId) ?? null
    : null;

  // The decision model must not see retrieved facts or contacts: available data must
  // never become a reason to interrupt a conversation. Memory extraction is independent
  // and best-effort, so a learning failure cannot suppress a useful reply.
  const [plan, extractedMemory] = await Promise.all([
    analyzeCityMessage({ channel, message, recentMessages, replyToMessage }),
    extractCityMemoryCandidatesSafely({ channel, message, recentMessages, replyToMessage })
  ]);

  if (!plan.shouldReply) {
    await saveMemoryCandidatesSafely(repository, channel, message, extractedMemory);
    await repository.markChatMessageProcessed(message.id);
    return "skipped";
  }

  if (replyCountHour >= channel.replyLimitHour || replyCountDay >= channel.replyLimitDay) {
    await saveMemoryCandidatesSafely(repository, channel, message, extractedMemory);
    await repository.createBotAction({
      channelId: channel.id, postId: null, chatMessageId: message.id, threadId: null, triggerCommentId: null,
      actionType: "reply", status: "skipped", requestedTeasingLevel: 0, finalTeasingLevel: 0,
      safetyReason: "Chat reply limit reached", generatedText: null, requiresHumanReview: false
    });
    await repository.markChatMessageProcessed(message.id);
    return "skipped";
  }

  const plannedQuery = plan.searchTerms.map((term) => term.trim()).filter(Boolean).join(" ");
  const retrievalQuery = (plannedQuery || [message.text, replyToMessage?.text ?? ""].filter(Boolean).join(" ")).slice(0, 2000);
  let memory = [] as Awaited<ReturnType<EngagementRepository["searchCityMemory"]>>;
  let contacts: ContactDirectoryRecord[] = [];
  try {
    [memory, contacts] = await Promise.all([
      plan.shouldSearchMemory
        ? repository.searchCityMemory({ query: retrievalQuery || message.text, channelId: channel.id, limit: 10, excludeSourceId: message.maxMessageId || message.id })
        : Promise.resolve([]),
      plan.shouldSearchContacts ? repository.searchContactDirectory({
        channel,
        query: { text: retrievalQuery || message.text },
        limit: 6
      }) : Promise.resolve([])
    ]);
  } catch (error) {
    console.error(`[worker] city_context_retrieval_failed channel=${channel.id} message=${message.id}: ${formatWorkerError(error)}`);
  }

  const latestMessages = await repository.listRecentChatMessages(channel.id, null, 40);
  let draft: CityAssistantReply;
  try {
    draft = await generateCityReply({
      channel,
      message,
      recentMessages: latestMessages,
      plan,
      memory,
      contacts
    });
  } catch (error) {
    const reason = `OpenAI city agent skipped: ${error instanceof Error ? error.message : String(error)}`;
    draft = buildFallbackCityReply({ channel, message, reason });
  } finally {
    await saveMemoryCandidatesSafely(repository, channel, message, extractedMemory);
  }

  return await createAndMaybePublishChatReply({
    repository,
    maxClient,
    channel,
    message,
    draft,
    availableContacts: contacts
  });
}

async function extractCityMemoryCandidatesSafely(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  recentMessages: MaxEngagementChatMessageRecord[];
  replyToMessage: MaxEngagementChatMessageRecord | null;
}): Promise<CityMemoryCandidate[]> {
  try {
    return await extractCityMemoryCandidatesFromMessage(input);
  } catch (error) {
    console.error(`[worker] city_memory_extraction_skipped message=${input.message.id}: ${formatWorkerError(error)}`);
    return [];
  }
}

async function saveMemoryCandidatesSafely(
  repository: EngagementRepository,
  channel: MaxEngagementChannelRecord,
  message: MaxEngagementChatMessageRecord,
  candidates: CityMemoryCandidate[]
): Promise<void> {
  try {
    for (const candidate of candidates) {
      await repository.ingestCityMemoryCandidate({
        channel,
        sourceId: message.maxMessageId || message.id,
        authorName: message.authorName,
        text: message.text,
        receivedAt: message.postedAt,
        candidate
      });
    }
  } catch (error) {
    console.error(`[worker] city_memory_save_skipped message=${message.id}: ${formatWorkerError(error)}`);
  }
}

async function createAndMaybePublishChatReply(input: {
  repository: EngagementRepository;
  maxClient: ChatClient;
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  draft: CityAssistantReply;
  availableContacts?: ContactDirectoryRecord[];
}): Promise<ProcessedResult> {
  const { repository, maxClient, channel, message, draft } = input;

  if (!draft.shouldReply || !draft.text.trim()) {
    const isError = draft.safetyReason.startsWith("OpenAI API key") || draft.safetyReason.startsWith("OpenAI chat reply skipped");
    await repository.createBotAction({
      channelId: channel.id, postId: null, chatMessageId: message.id, threadId: null, triggerCommentId: null,
      actionType: "reply", status: isError ? "failed" : "skipped", requestedTeasingLevel: 0, finalTeasingLevel: 0,
      safetyReason: draft.safetyReason, generatedText: null, requiresHumanReview: false,
      errorMessage: isError ? draft.safetyReason : null
    });
    await repository.markChatMessageProcessed(message.id);
    return isError ? "failed" : "skipped";
  }

  const selectedContacts = (input.availableContacts ?? []).filter((contact) =>
    (draft.usedContactIds ?? []).includes(contact.id)
  );
  const attachments = buildMaxContactAttachments(selectedContacts);

  let status: "draft" | "posted" | "failed" = channel.dryRun ? "draft" : "posted";
  let postedMaxCommentId: string | null = null;
  let errorMessage: string | null = null;
  if (!channel.dryRun) {
    try {
      const published = await maxClient.sendChatMessage({
        chatId: channel.maxChannelId,
        text: draft.text,
        replyToMessageId: message.maxMessageId,
        attachments: attachments.length ? attachments : undefined
      });
      postedMaxCommentId = published.messageId;
    } catch (error) {
      if (attachments.length === 0) {
        status = "failed";
        errorMessage = error instanceof Error ? error.message : String(error);
      } else {
        try {
          const fallbackDetails = formatContactDirectoryText(selectedContacts).trim();
          const fallbackText = fallbackDetails && !draft.text.includes(fallbackDetails)
            ? `${draft.text}
${fallbackDetails}`.slice(0, 1800)
            : draft.text;
          const published = await maxClient.sendChatMessage({
            chatId: channel.maxChannelId,
            text: fallbackText,
            replyToMessageId: message.maxMessageId
          });
          postedMaxCommentId = published.messageId;
          errorMessage = `Contact-card attachment fallback used: ${error instanceof Error ? error.message : String(error)}`;
        } catch (fallbackError) {
          status = "failed";
          errorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        }
      }
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

async function processPostSafely(
  repository: EngagementRepository,
  maxClient: MaxClient,
  channel: MaxEngagementChannelRecord,
  post: MaxEngagementPostRecord
): Promise<ProcessedResult> {
  try {
    return await processPost(repository, maxClient, channel, post);
  } catch (error) {
    const errorMessage = formatWorkerError(error);
    console.error(`[worker] post_failed channel=${channel.id} post=${post.id}: ${errorMessage}`);

    await createFailedActionSafely(repository, {
      channelId: channel.id,
      postId: post.id,
      chatMessageId: null,
      threadId: null,
      triggerCommentId: null,
      actionType: "initiative",
      safetyReason: "Post processing failed",
      errorMessage
    });
    return "failed";
  }
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

async function processCommentSafely(
  repository: EngagementRepository,
  maxClient: MaxClient,
  channel: MaxEngagementChannelRecord,
  comment: MaxEngagementCommentRecord
): Promise<ProcessedResult> {
  try {
    return await processComment(repository, maxClient, channel, comment);
  } catch (error) {
    const errorMessage = formatWorkerError(error);
    console.error(`[worker] comment_failed channel=${channel.id} comment=${comment.id}: ${errorMessage}`);

    await createFailedActionSafely(repository, {
      channelId: channel.id,
      postId: comment.postId,
      chatMessageId: null,
      threadId: comment.threadId,
      triggerCommentId: comment.id,
      actionType: "reply",
      safetyReason: "Comment processing failed",
      errorMessage
    });
    return "failed";
  }
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

async function createFailedActionSafely(
  repository: EngagementRepository,
  input: {
    channelId: string;
    postId: string | null;
    chatMessageId: string | null;
    threadId: string | null;
    triggerCommentId: string | null;
    actionType: "reply" | "initiative" | "moderate" | "stop_thread";
    safetyReason: string;
    errorMessage: string;
  }
): Promise<void> {
  try {
    await repository.createBotAction({
      channelId: input.channelId,
      postId: input.postId,
      chatMessageId: input.chatMessageId,
      threadId: input.threadId,
      triggerCommentId: input.triggerCommentId,
      actionType: input.actionType,
      status: "failed",
      requestedTeasingLevel: 0,
      finalTeasingLevel: 0,
      safetyReason: input.safetyReason,
      generatedText: null,
      requiresHumanReview: false,
      errorMessage: input.errorMessage
    });
  } catch (error) {
    console.error(`[worker] failed_action_write_failed: ${formatWorkerError(error)}`);
  }
}

async function markChatMessageProcessedSafely(
  repository: EngagementRepository,
  messageId: string
): Promise<void> {
  try {
    await repository.markChatMessageProcessed(messageId);
  } catch (error) {
    console.error(`[worker] mark_chat_message_processed_failed message=${messageId}: ${formatWorkerError(error)}`);
  }
}

function formatWorkerError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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
  const errorDelayMs = Math.max(
    1000,
    Number(process.env.MAX_ENGAGEMENT_ERROR_DELAY_MS || 5000)
  );

  while (true) {
    try {
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
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      await sleep(errorDelayMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
