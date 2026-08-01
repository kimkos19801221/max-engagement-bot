import "dotenv/config";
import { config as loadDotenv } from "dotenv";

import { hasStopTrigger, looksLikeQuestion } from "./max-engagement/content-safety.js";
import { generateDryRunDraft } from "./max-engagement/draft-generator.js";
import { MaxEngagementRepository, createSupabaseClientFromEnv, type EngagementRepository } from "./max-engagement/repository.js";
import { decideEngagementAction } from "./max-engagement/safety.js";
import type {
  MaxEngagementChannelRecord,
  MaxEngagementCommentRecord,
  MaxEngagementPostContext,
  MaxEngagementPostRecord,
  MaxEngagementThreadRecord
} from "./max-engagement/types.js";

loadDotenv({ path: ".env.local", override: false });

type WorkerResult = {
  channels: number;
  comments: number;
  actions: number;
  skipped: number;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export async function runDryRunWorker(repository: EngagementRepository = new MaxEngagementRepository(createSupabaseClientFromEnv())): Promise<WorkerResult> {
  const channels = await repository.listRunnableChannels();
  const result: WorkerResult = {
    channels: channels.length,
    comments: 0,
    actions: 0,
    skipped: 0
  };

  for (const channel of channels) {
    const comments = await repository.listUnprocessedSubscriberComments(channel.id);
    result.comments += comments.length;

    for (const comment of comments) {
      const processed = await processComment(repository, channel, comment);
      if (processed) {
        result.actions += 1;
      } else {
        result.skipped += 1;
      }
    }
  }

  return result;
}

async function processComment(
  repository: EngagementRepository,
  channel: MaxEngagementChannelRecord,
  comment: MaxEngagementCommentRecord
): Promise<boolean> {
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

  const context = buildContext({
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

  if (!decision.shouldAct || !decision.actionType) {
    return false;
  }

  if (decision.actionType === "delete_own_comment") {
    return false;
  }

  const draft = generateDryRunDraft({
    channel,
    comment,
    decision,
    post
  });

  await repository.createBotAction({
    channelId: channel.id,
    postId: comment.postId,
    threadId: comment.threadId,
    triggerCommentId: comment.id,
    actionType: decision.actionType,
    status: decision.requiresHumanReview ? "draft" : channel.dryRun ? "draft" : "queued",
    requestedTeasingLevel: channel.teasingLevel,
    finalTeasingLevel: decision.finalTeasingLevel,
    safetyReason: draft.safetyReason,
    generatedText: draft.text || null,
    requiresHumanReview: decision.requiresHumanReview
  });

  return true;
}

function buildContext(input: {
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
