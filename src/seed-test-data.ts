import { config as loadDotenv } from "dotenv";

import { createSupabaseClientFromEnv } from "./max-engagement/repository.js";

loadDotenv({ path: ".env.local", override: false });

async function main(): Promise<void> {
  const supabase = createSupabaseClientFromEnv();

  const channel = await upsertSingle("max_engagement_channels", {
    max_channel_id: "max-test-channel",
    title: "Тестовый канал MAX",
    channel_kind: "moms",
    enabled: true,
    mode: "suitable_messages",
    bot_name: "МамаBot",
    bot_signature: "- админ канала",
    teasing_level: 1,
    dry_run: true,
    reply_limit_hour: 20,
    reply_limit_day: 120,
    initiative_limit_hour: 3,
    initiative_limit_day: 15,
    user_tease_limit_day: 1
  }, "max_channel_id");

  const post = await upsertSingle("max_engagement_posts", {
    channel_id: channel.id,
    max_post_id: "max-test-post-1",
    text: "Мамочки, подскажите, как уложить малыша спать летом, когда жарко?",
    classification: "neutral",
    classification_confidence: 0.8,
    classification_reason: "manual test seed",
    forced_teasing_level: 1,
    comments_before: 0,
    reactions_before: 0
  }, "channel_id,max_post_id");

  const thread = await upsertSingle("max_engagement_threads", {
    channel_id: channel.id,
    post_id: post.id,
    max_thread_id: "max-test-thread-1",
    status: "active",
    stop_reason: null,
    stopped_at: null
  }, "post_id,max_thread_id");

  const { data: oldComment, error: oldCommentError } = await supabase
    .from("max_engagement_comments")
    .select("id")
    .eq("channel_id", channel.id)
    .eq("max_comment_id", "max-test-comment-1")
    .maybeSingle();

  if (oldCommentError) {
    throw oldCommentError;
  }

  if (oldComment) {
    const { error: deleteActionsError } = await supabase
      .from("max_engagement_bot_actions")
      .delete()
      .eq("trigger_comment_id", oldComment.id);

    if (deleteActionsError) {
      throw deleteActionsError;
    }

    const { error: deleteCommentError } = await supabase.from("max_engagement_comments").delete().eq("id", oldComment.id);
    if (deleteCommentError) {
      throw deleteCommentError;
    }
  }

  const { data: comment, error: commentError } = await supabase
    .from("max_engagement_comments")
    .insert({
      channel_id: channel.id,
      post_id: post.id,
      thread_id: thread.id,
      max_comment_id: "max-test-comment-1",
      author_user_id: "test-user-1",
      author_name: "Анна",
      text: "А если ребенок вообще не спит днем, это нормально?",
      comment_kind: "subscriber",
      sentiment: "neutral",
      posted_at: new Date().toISOString()
    })
    .select("id")
    .single();

  if (commentError) {
    throw commentError;
  }

  console.log(
    JSON.stringify(
      {
        channelId: channel.id,
        postId: post.id,
        threadId: thread.id,
        commentId: comment.id
      },
      null,
      2
    )
  );
}

async function upsertSingle(table: string, row: Record<string, unknown>, onConflict: string): Promise<Record<string, string>> {
  const supabase = createSupabaseClientFromEnv();
  const { data, error } = await supabase.from(table).upsert(row, { onConflict }).select("*").single();

  if (error) {
    throw error;
  }

  return data as Record<string, string>;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
