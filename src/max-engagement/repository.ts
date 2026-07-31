import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

import type {
  MaxEngagementChannelRecord,
  MaxEngagementCommentRecord,
  MaxEngagementMode,
  MaxEngagementPostClassification,
  MaxEngagementPostRecord,
  MaxEngagementThreadRecord,
  MaxEngagementThreadStatus,
  MaxEngagementTone,
  TeasingLevel
} from "./types.js";

type ChannelRow = Record<string, unknown>;
type CommentRow = Record<string, unknown>;
type PostRow = Record<string, unknown>;
type ThreadRow = Record<string, unknown>;

export function createSupabaseClientFromEnv(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required for the engagement worker");
  }

  return createClient(url, key, {
    auth: {
      persistSession: false
    },
    realtime: {
      transport: WebSocket as never
    }
  });
}

export class MaxEngagementRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async listRunnableChannels(limit = 25): Promise<MaxEngagementChannelRecord[]> {
    const { data, error } = await this.supabase
      .from("max_engagement_channels")
      .select("*")
      .eq("enabled", true)
      .neq("mode", "off")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    return (data ?? []).map(mapChannel);
  }

  async listUnprocessedSubscriberComments(channelId: string, limit = 50): Promise<MaxEngagementCommentRecord[]> {
    const { data, error } = await this.supabase
      .from("max_engagement_comments")
      .select(
        "id, channel_id, post_id, thread_id, max_comment_id, author_user_id, author_name, text, posted_at"
      )
      .eq("channel_id", channelId)
      .eq("comment_kind", "subscriber")
      .order("collected_at", { ascending: true })
      .limit(limit);

    if (error) {
      throw error;
    }

    const rows = (data ?? []).map(mapComment);
    if (rows.length === 0) {
      return [];
    }

    const processed = await this.listProcessedTriggerIds(rows.map((row) => row.id));
    return rows.filter((row) => !processed.has(row.id));
  }

  async getPost(postId: string): Promise<MaxEngagementPostRecord | null> {
    const { data, error } = await this.supabase
      .from("max_engagement_posts")
      .select("id, channel_id, max_post_id, text, classification, classification_confidence")
      .eq("id", postId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? mapPost(data as PostRow) : null;
  }

  async getThread(threadId: string | null): Promise<MaxEngagementThreadRecord | null> {
    if (!threadId) {
      return null;
    }

    const { data, error } = await this.supabase
      .from("max_engagement_threads")
      .select("id, channel_id, post_id, max_thread_id, status")
      .eq("id", threadId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? mapThread(data as ThreadRow) : null;
  }

  async countActions(channelId: string, actionType: "reply" | "initiative", sinceIso: string): Promise<number> {
    const { count, error } = await this.supabase
      .from("max_engagement_bot_actions")
      .select("id", { count: "exact", head: true })
      .eq("channel_id", channelId)
      .eq("action_type", actionType)
      .gte("created_at", sinceIso);

    if (error) {
      throw error;
    }

    return count ?? 0;
  }

  async countUserTeasesToday(channelId: string, authorUserId: string | null, sinceIso: string): Promise<number> {
    if (!authorUserId) {
      return 0;
    }

    const { data: comments, error: commentsError } = await this.supabase
      .from("max_engagement_comments")
      .select("id")
      .eq("channel_id", channelId)
      .eq("author_user_id", authorUserId)
      .gte("collected_at", sinceIso);

    if (commentsError) {
      throw commentsError;
    }

    const triggerIds = (comments ?? []).map((row: { id: string }) => row.id);
    if (triggerIds.length === 0) {
      return 0;
    }

    const { count, error } = await this.supabase
      .from("max_engagement_bot_actions")
      .select("id", { count: "exact", head: true })
      .eq("channel_id", channelId)
      .in("trigger_comment_id", triggerIds)
      .gt("final_teasing_level", 0)
      .gte("created_at", sinceIso);

    if (error) {
      throw error;
    }

    return count ?? 0;
  }

  async createBotAction(input: {
    channelId: string;
    postId: string;
    threadId: string | null;
    triggerCommentId: string;
    actionType: "reply" | "initiative" | "moderate" | "stop_thread";
    status: "draft" | "queued" | "skipped";
    requestedTeasingLevel: TeasingLevel;
    finalTeasingLevel: TeasingLevel;
    safetyReason: string;
    generatedText: string | null;
    requiresHumanReview: boolean;
  }): Promise<void> {
    const { error } = await this.supabase.from("max_engagement_bot_actions").insert({
      channel_id: input.channelId,
      post_id: input.postId,
      thread_id: input.threadId,
      trigger_comment_id: input.triggerCommentId,
      action_type: input.actionType,
      status: input.status,
      requested_teasing_level: input.requestedTeasingLevel,
      final_teasing_level: input.finalTeasingLevel,
      safety_reason: input.safetyReason,
      generated_text: input.generatedText,
      requires_human_review: input.requiresHumanReview
    });

    if (error) {
      throw error;
    }
  }

  private async listProcessedTriggerIds(triggerIds: string[]): Promise<Set<string>> {
    const { data, error } = await this.supabase
      .from("max_engagement_bot_actions")
      .select("trigger_comment_id")
      .in("trigger_comment_id", triggerIds);

    if (error) {
      throw error;
    }

    const ids = (data ?? [])
      .map((row: { trigger_comment_id: string | null }) => row.trigger_comment_id)
      .filter((id): id is string => typeof id === "string");

    return new Set(ids);
  }
}

function mapChannel(row: ChannelRow): MaxEngagementChannelRecord {
  return {
    id: String(row.id),
    maxChannelId: String(row.max_channel_id),
    title: String(row.title),
    channelKind: row.channel_kind as MaxEngagementChannelRecord["channelKind"],
    enabled: Boolean(row.enabled),
    mode: row.mode as MaxEngagementMode,
    teasingLevel: toTeasingLevel(row.teasing_level),
    level3Acknowledged: Boolean(row.level_3_acknowledged_at),
    level3ReviewPolicy: row.level_3_review_policy as MaxEngagementChannelRecord["level3ReviewPolicy"],
    replyLimitHour: Number(row.reply_limit_hour),
    replyLimitDay: Number(row.reply_limit_day),
    initiativeLimitHour: Number(row.initiative_limit_hour),
    initiativeLimitDay: Number(row.initiative_limit_day),
    userTeaseLimitDay: Number(row.user_tease_limit_day),
    politicsTeasingLevel: toTeasingLevel(row.politics_teasing_level),
    dryRun: Boolean(row.dry_run),
    botName: typeof row.bot_name === "string" ? row.bot_name : undefined,
    botSignature: typeof row.bot_signature === "string" ? row.bot_signature : undefined
  };
}

function mapComment(row: CommentRow): MaxEngagementCommentRecord {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    postId: String(row.post_id),
    threadId: typeof row.thread_id === "string" ? row.thread_id : null,
    maxCommentId: typeof row.max_comment_id === "string" ? row.max_comment_id : null,
    authorUserId: typeof row.author_user_id === "string" ? row.author_user_id : null,
    authorName: typeof row.author_name === "string" ? row.author_name : null,
    text: String(row.text),
    postedAt: typeof row.posted_at === "string" ? row.posted_at : null
  };
}

function mapPost(row: PostRow): MaxEngagementPostRecord {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    maxPostId: String(row.max_post_id),
    text: typeof row.text === "string" ? row.text : null,
    classification: row.classification as MaxEngagementPostClassification,
    classificationConfidence: Number(row.classification_confidence)
  };
}

function mapThread(row: ThreadRow): MaxEngagementThreadRecord {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    postId: String(row.post_id),
    maxThreadId: String(row.max_thread_id),
    status: row.status as MaxEngagementThreadStatus
  };
}

function toTeasingLevel(value: unknown): TeasingLevel {
  const numeric = Number(value);
  if (numeric >= 3) {
    return 3;
  }
  if (numeric >= 2) {
    return 2;
  }
  if (numeric >= 1) {
    return 1;
  }
  return 0;
}
