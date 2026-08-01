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
  MaxApiComment,
  MaxApiPost,
  MaxUpdate,
  MaxEngagementTone,
  TeasingLevel
} from "./types.js";
import { classifyPostText } from "./content-safety.js";

type ChannelRow = Record<string, unknown>;
type CommentRow = Record<string, unknown>;
type PostRow = Record<string, unknown>;
type ThreadRow = Record<string, unknown>;

export type BotActionInput = {
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
};

export type EngagementRepository = {
  listRunnableChannels(limit?: number): Promise<MaxEngagementChannelRecord[]>;
  listUnprocessedSubscriberComments(channelId: string, limit?: number): Promise<MaxEngagementCommentRecord[]>;
  getPost(postId: string): Promise<MaxEngagementPostRecord | null>;
  getThread(threadId: string | null): Promise<MaxEngagementThreadRecord | null>;
  countActions(channelId: string, actionType: "reply" | "initiative", sinceIso: string): Promise<number>;
  countUserTeasesToday(channelId: string, authorUserId: string | null, sinceIso: string): Promise<number>;
  createBotAction(input: BotActionInput): Promise<void>;
};

export type MaxUpdatesImportResult = {
  received: number;
  imported: number;
  channels: number;
  messages: number;
  skipped: number;
};

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

  async importMaxUpdates(updates: MaxUpdate[]): Promise<MaxUpdatesImportResult> {
    const result: MaxUpdatesImportResult = {
      received: updates.length,
      imported: 0,
      channels: 0,
      messages: 0,
      skipped: 0
    };

    for (const update of updates) {
      const channel = await this.upsertChannelFromUpdate(update);
      if (channel.created) {
        result.channels += 1;
      }

      if (update.update_type === "message_created" && update.message && channel.record) {
        const imported = await this.importMessageCreatedUpdate(channel.record, update);
        if (imported) {
          result.messages += 1;
        } else {
          result.skipped += 1;
        }
      }

      result.imported += 1;
    }

    return result;
  }

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

  async createBotAction(input: BotActionInput): Promise<void> {
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

  async upsertMaxPost(channel: MaxEngagementChannelRecord, post: MaxApiPost): Promise<MaxEngagementPostRecord> {
    const classification = classifyPostText(post.text);
    const { data, error } = await this.supabase
      .from("max_engagement_posts")
      .upsert(
        {
          channel_id: channel.id,
          max_post_id: post.id,
          source_url: post.url ?? null,
          author_name: post.authorName ?? null,
          text: post.text,
          posted_at: post.postedAt ?? null,
          classification: classification.classification,
          classification_confidence: classification.confidence,
          classification_reason: classification.reason,
          forced_teasing_level: classification.classification === "neutral" || classification.classification === "entertainment" ? channel.teasingLevel : 0,
          comments_before: post.commentsCount ?? null,
          reactions_before: post.reactionsCount ?? null
        },
        { onConflict: "channel_id,max_post_id" }
      )
      .select("id, channel_id, max_post_id, text, classification, classification_confidence")
      .single();

    if (error) {
      throw error;
    }

    return mapPost(data as PostRow);
  }

  async upsertMaxThread(channelId: string, postId: string, maxThreadId: string): Promise<MaxEngagementThreadRecord> {
    const { data, error } = await this.supabase
      .from("max_engagement_threads")
      .upsert(
        {
          channel_id: channelId,
          post_id: postId,
          max_thread_id: maxThreadId,
          status: "active"
        },
        { onConflict: "post_id,max_thread_id" }
      )
      .select("id, channel_id, post_id, max_thread_id, status")
      .single();

    if (error) {
      throw error;
    }

    return mapThread(data as ThreadRow);
  }

  async upsertMaxComment(
    channelId: string,
    postId: string,
    threadId: string,
    comment: MaxApiComment
  ): Promise<MaxEngagementCommentRecord> {
    const { data: existing, error: existingError } = await this.supabase
      .from("max_engagement_comments")
      .select("id")
      .eq("channel_id", channelId)
      .eq("max_comment_id", comment.id)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existing) {
      const { data, error } = await this.supabase
        .from("max_engagement_comments")
        .update({
          post_id: postId,
          thread_id: threadId,
          parent_max_comment_id: comment.parentCommentId ?? null,
          author_user_id: comment.authorUserId ?? null,
          author_name: comment.authorName ?? null,
          text: comment.text,
          posted_at: comment.postedAt ?? null
        })
        .eq("id", existing.id)
        .select("id, channel_id, post_id, thread_id, max_comment_id, author_user_id, author_name, text, posted_at")
        .single();

      if (error) {
        throw error;
      }

      return mapComment(data as CommentRow);
    }

    const { data, error } = await this.supabase
      .from("max_engagement_comments")
      .insert({
        channel_id: channelId,
        post_id: postId,
        thread_id: threadId,
        max_comment_id: comment.id,
        parent_max_comment_id: comment.parentCommentId ?? null,
        author_user_id: comment.authorUserId ?? null,
        author_name: comment.authorName ?? null,
        text: comment.text,
        comment_kind: "subscriber",
        sentiment: "unknown",
        posted_at: comment.postedAt ?? null
      })
      .select("id, channel_id, post_id, thread_id, max_comment_id, author_user_id, author_name, text, posted_at")
      .single();

    if (error) {
      throw error;
    }

    return mapComment(data as CommentRow);
  }

  private async upsertChannelFromUpdate(update: MaxUpdate): Promise<{
    record: MaxEngagementChannelRecord | null;
    created: boolean;
  }> {
    const chatId = update.chat_id ?? update.message?.recipient?.chat_id;
    if (chatId === undefined || chatId === null) {
      return { record: null, created: false };
    }

    const maxChannelId = String(chatId);
    const { data: existing, error: existingError } = await this.supabase
      .from("max_engagement_channels")
      .select("*")
      .eq("max_channel_id", maxChannelId)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existing) {
      return { record: mapChannel(existing as ChannelRow), created: false };
    }

    const { data, error } = await this.supabase
      .from("max_engagement_channels")
      .insert({
        max_channel_id: maxChannelId,
        title: update.is_channel ? `MAX канал ${maxChannelId}` : `MAX чат ${maxChannelId}`,
        channel_kind: "news",
        enabled: false,
        mode: "off",
        teasing_level: 1,
        politics_teasing_level: 0,
        bot_name: "MAX Bot",
        bot_signature: "- админ",
        dry_run: true
      })
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return { record: mapChannel(data as ChannelRow), created: true };
  }

  private async importMessageCreatedUpdate(channel: MaxEngagementChannelRecord, update: MaxUpdate): Promise<boolean> {
    const message = update.message;
    const text = message?.body?.text?.trim();
    const messageId = message?.body?.mid;
    if (!message || !messageId || !text) {
      return false;
    }

    const senderId = message.sender?.user_id;
    const senderName = message.sender?.name || message.sender?.username || null;
    const postedAt = typeof message.timestamp === "number"
      ? new Date(message.timestamp).toISOString()
      : new Date(update.timestamp ?? Date.now()).toISOString();
    const linkedMessageId = message.link?.mid ?? message.link?.message?.body?.mid ?? null;

    if (!linkedMessageId) {
      const post = await this.upsertMaxPost(channel, {
        id: String(messageId),
        channelId: channel.maxChannelId,
        text,
        url: message.url ?? undefined,
        authorName: senderName ?? undefined,
        postedAt,
        commentsCount: message.stat?.comments ?? 0,
        reactionsCount: message.stat?.reactions ?? message.stat?.likes
      });
      await this.upsertMaxThread(channel.id, post.id, String(messageId));
      return true;
    }

    const post = await this.upsertMaxPost(channel, {
      id: String(linkedMessageId),
      channelId: channel.maxChannelId,
      text: message.link?.message?.body?.text ?? "MAX post from linked message",
      url: message.url ?? undefined,
      authorName: message.link?.sender?.name ?? undefined,
      postedAt,
      commentsCount: nullToUndefined(message.stat?.comments),
      reactionsCount: nullToUndefined(message.stat?.reactions ?? message.stat?.likes)
    });
    const thread = await this.upsertMaxThread(channel.id, post.id, String(linkedMessageId));
    await this.upsertMaxComment(channel.id, post.id, thread.id, {
      id: String(messageId),
      postId: String(linkedMessageId),
      threadId: String(linkedMessageId),
      authorUserId: senderId === undefined || senderId === null ? undefined : String(senderId),
      authorName: senderName ?? undefined,
      text,
      postedAt
    });
    return true;
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

function nullToUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}
