import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config as loadDotenv } from "dotenv";

import { createSupabaseClientFromEnv, MaxEngagementRepository } from "./max-engagement/repository.js";
import { runDryRunWorker } from "./worker.js";
import type { MaxUpdate } from "./max-engagement/types.js";

loadDotenv({ path: ".env.local", override: false });

const host = process.env.ADMIN_HOST || "127.0.0.1";
const port = Number(process.env.ADMIN_PORT || 4317);
const supabase = createSupabaseClientFromEnv();
const repository = new MaxEngagementRepository(supabase);
const adminSecret = process.env.ADMIN_SECRET;
const webhookSecret = process.env.MAX_WEBHOOK_SECRET;

type DraftAction = {
  id: string;
  action_type: string;
  status: string;
  final_teasing_level: number;
  requires_human_review: boolean;
  safety_reason: string | null;
  generated_text: string | null;
  posted_max_comment_id: string | null;
  created_at: string;
  posted_at: string | null;
  deleted_at: string | null;
  channel_id: string;
  post_id: string | null;
  thread_id: string | null;
  trigger_comment_id: string | null;
  channel_title?: string | null;
  post_text?: string | null;
  comment_author?: string | null;
  comment_text?: string | null;
};

type AnalyticsSummary = {
  totals: {
    posts: number;
    subscriberComments: number;
    botActions: number;
    botTeases: number;
    level3: number;
    toxicityEvents: number;
    toxicityIndex: number;
  };
  engagement: Array<{
    postId: string;
    channelTitle: string | null;
    postText: string | null;
    commentsBefore: number | null;
    commentsAfter: number | null;
    reactionsBefore: number | null;
    reactionsAfter: number | null;
    commentDelta: number | null;
    reactionDelta: number | null;
  }>;
  topToxicity: Array<{
    actionId: string | null;
    eventType: string;
    severity: number;
    sourceText: string | null;
    createdAt: string;
  }>;
};

type ChannelSettings = {
  id: string;
  max_channel_id: string;
  title: string;
  channel_kind: "moms" | "news";
  enabled: boolean;
  mode: string;
  bot_name: string | null;
  bot_signature: string | null;
  tone: string;
  emoji_level: number;
  humor_level: number;
  teasing_level: number;
  level_3_acknowledged_at: string | null;
  level_3_review_policy: string;
  working_hours_enabled: boolean;
  working_hours_timezone: string;
  working_hours_start: string | null;
  working_hours_end: string | null;
  answer_delay_min_seconds: number;
  answer_delay_max_seconds: number;
  reply_limit_hour: number;
  reply_limit_day: number;
  initiative_limit_hour: number;
  initiative_limit_day: number;
  user_tease_limit_day: number;
  politics_teasing_level: number;
  dry_run: boolean;
};

type StyleExample = {
  id: string;
  channel_id: string | null;
  example_type: "admin_message" | "good_tease" | "too_much";
  source_type: "manual" | "txt" | "csv" | "json" | "screenshot" | "max" | "telegram" | "whatsapp" | "vk";
  text: string;
  notes: string | null;
  created_at: string;
  channel_title?: string | null;
};

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      sendJson(res, 400, { error: "Bad request" });
      return;
    }

    const url = new URL(req.url, `http://${host}:${port}`);

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
      sendJson(res, 200, { ok: true, service: "max-engagement-bot" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhooks/max") {
      await handleMaxWebhook(req, res);
      return;
    }

    if (!isAdminAuthorized(req)) {
      sendUnauthorized(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin") {
      sendHtml(res, renderDashboard());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/actions") {
      sendJson(res, 200, await listDraftActions({
        view: url.searchParams.get("view"),
        level: url.searchParams.get("level")
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/analytics") {
      sendJson(res, 200, await getAnalyticsSummary());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/channels") {
      sendJson(res, 200, await listChannels());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/style-examples") {
      sendJson(res, 200, await listStyleExamples(url.searchParams.get("channelId")));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/style-examples") {
      sendJson(res, 200, await createStyleExamples(await readJson(req)));
      return;
    }

    const styleExampleMatch = url.pathname.match(/^\/api\/style-examples\/([0-9a-f-]+)$/);
    if (req.method === "DELETE" && styleExampleMatch) {
      const [, id] = styleExampleMatch;
      sendJson(res, 200, await deleteStyleExample(id));
      return;
    }

    const channelMatch = url.pathname.match(/^\/api\/channels\/([0-9a-f-]+)$/);
    if (req.method === "PATCH" && channelMatch) {
      const [, id] = channelMatch;
      sendJson(res, 200, await updateChannel(id, await readJson(req)));
      return;
    }

    const actionMatch = url.pathname.match(/^\/api\/actions\/([0-9a-f-]+)\/(approve|skip|stop-thread|delete-own)$/);
    if (req.method === "POST" && actionMatch) {
      const [, id, command] = actionMatch;
      sendJson(res, 200, await updateAction(id, command as "approve" | "skip" | "stop-thread" | "delete-own"));
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`MAX engagement admin: http://${host}:${port}`);
});

async function handleMaxWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!webhookSecret) {
    sendJson(res, 503, { error: "MAX_WEBHOOK_SECRET is required" });
    return;
  }

  if (!safeEqual(getHeaderValue(req, "x-max-bot-api-secret"), webhookSecret)) {
    sendJson(res, 401, { error: "Invalid MAX webhook secret" });
    return;
  }

  const updates = extractWebhookUpdates(await readJson(req));
  const imported = await repository.importMaxUpdates(updates);
  sendJson(res, 200, { ok: true, imported });

  void runDryRunWorker(repository)
    .then((worker) => {
      console.log(JSON.stringify({ at: new Date().toISOString(), source: "max-webhook", imported, worker }));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
    });
}

async function listDraftActions(filters: { view: string | null; level: string | null } = { view: null, level: null }): Promise<{ actions: DraftAction[] }> {
  let query = supabase
    .from("max_engagement_bot_actions")
    .select(
      "id, action_type, status, final_teasing_level, requires_human_review, safety_reason, generated_text, posted_max_comment_id, created_at, posted_at, deleted_at, channel_id, post_id, thread_id, trigger_comment_id"
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (filters.view === "review") {
    query = query.in("status", ["draft", "approved", "queued", "failed"]);
  }

  if (filters.view === "teases") {
    query = query.gt("final_teasing_level", 0);
  }

  if (filters.level === "3") {
    query = query.eq("final_teasing_level", 3);
  }

  const { data: actions, error } = await query;

  if (error) {
    throw error;
  }

  const rows = (actions ?? []) as DraftAction[];
  if (rows.length === 0) {
    return { actions: [] };
  }

  const [channels, posts, comments] = await Promise.all([
    fetchByIds("max_engagement_channels", rows.map((row) => row.channel_id), "id,title"),
    fetchByIds("max_engagement_posts", rows.map((row) => row.post_id).filter(isString), "id,text"),
    fetchByIds(
      "max_engagement_comments",
      rows.map((row) => row.trigger_comment_id).filter(isString),
      "id,author_name,text"
    )
  ]);

  return {
    actions: rows.map((row) => ({
      ...row,
      channel_title: getText(channels.get(row.channel_id), "title"),
      post_text: row.post_id ? getText(posts.get(row.post_id), "text") : null,
      comment_author: row.trigger_comment_id ? getText(comments.get(row.trigger_comment_id), "author_name") : null,
      comment_text: row.trigger_comment_id ? getText(comments.get(row.trigger_comment_id), "text") : null
    }))
  };
}

async function fetchByIds(table: string, ids: string[], select: string): Promise<Map<string, Record<string, unknown>>> {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase.from(table).select(select).in("id", uniqueIds);
  if (error) {
    throw error;
  }

  return new Map(((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => [String(row.id), row]));
}

async function updateAction(id: string, command: "approve" | "skip" | "stop-thread" | "delete-own"): Promise<{ ok: true }> {
  if (command === "approve") {
    const { error } = await supabase
      .from("max_engagement_bot_actions")
      .update({
        status: "approved",
        reviewed_by: "local-admin",
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id);

    if (error) {
      throw error;
    }
  }

  if (command === "skip") {
    const { error } = await supabase
      .from("max_engagement_bot_actions")
      .update({
        status: "skipped",
        reviewed_by: "local-admin",
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id);

    if (error) {
      throw error;
    }
  }

  if (command === "stop-thread") {
    const { data: action, error: actionError } = await supabase
      .from("max_engagement_bot_actions")
      .select("thread_id")
      .eq("id", id)
      .maybeSingle();

    if (actionError) {
      throw actionError;
    }

    const threadId = typeof action?.thread_id === "string" ? action.thread_id : null;
    if (threadId) {
      const { error: threadError } = await supabase
        .from("max_engagement_threads")
        .update({
          status: "stopped",
          stop_reason: "Stopped from local admin panel",
          stopped_at: new Date().toISOString()
        })
        .eq("id", threadId);

      if (threadError) {
        throw threadError;
      }
    }

    const { error } = await supabase
      .from("max_engagement_bot_actions")
      .update({
        status: "skipped",
        reviewed_by: "local-admin",
        reviewed_at: new Date().toISOString(),
        safety_reason: "Skipped because thread was stopped from local admin panel"
      })
      .eq("id", id);

    if (error) {
      throw error;
    }
  }

  if (command === "delete-own") {
    const { error } = await supabase
      .from("max_engagement_bot_actions")
      .update({
        action_type: "delete_own_comment",
        status: "deleted",
        deleted_at: new Date().toISOString(),
        reviewed_by: "local-admin",
        reviewed_at: new Date().toISOString(),
        safety_reason: "Marked for immediate own-comment deletion from local admin panel"
      })
      .eq("id", id);

    if (error) {
      throw error;
    }
  }

  return { ok: true };
}

async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const [postsResult, commentsResult, actionsResult, toxicityResult] = await Promise.all([
    supabase
      .from("max_engagement_posts")
      .select("id, channel_id, text, comments_before, comments_after, reactions_before, reactions_after")
      .order("collected_at", { ascending: false })
      .limit(50),
    supabase.from("max_engagement_comments").select("id", { count: "exact", head: true }).eq("comment_kind", "subscriber"),
    supabase
      .from("max_engagement_bot_actions")
      .select("id, final_teasing_level", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("max_engagement_toxicity_events")
      .select("action_id, event_type, severity, source_text, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(20)
  ]);

  if (postsResult.error) throw postsResult.error;
  if (commentsResult.error) throw commentsResult.error;
  if (actionsResult.error) throw actionsResult.error;
  if (toxicityResult.error) throw toxicityResult.error;

  const posts = (postsResult.data ?? []) as Array<Record<string, unknown>>;
  const actions = (actionsResult.data ?? []) as Array<{ id: string; final_teasing_level: number }>;
  const toxicity = (toxicityResult.data ?? []) as Array<{
    action_id: string | null;
    event_type: string;
    severity: number;
    source_text: string | null;
    created_at: string;
  }>;
  const channels = await fetchByIds("max_engagement_channels", posts.map((post) => String(post.channel_id)), "id,title");
  const botTeases = actions.filter((action) => action.final_teasing_level > 0).length;
  const level3 = actions.filter((action) => action.final_teasing_level === 3).length;
  const toxicityIndex = botTeases === 0 ? 0 : Number((toxicity.length / botTeases).toFixed(3));

  return {
    totals: {
      posts: posts.length,
      subscriberComments: commentsResult.count ?? 0,
      botActions: actionsResult.count ?? actions.length,
      botTeases,
      level3,
      toxicityEvents: toxicityResult.count ?? toxicity.length,
      toxicityIndex
    },
    engagement: posts.map((post) => {
      const commentsBefore = toNullableNumber(post.comments_before);
      const commentsAfter = toNullableNumber(post.comments_after);
      const reactionsBefore = toNullableNumber(post.reactions_before);
      const reactionsAfter = toNullableNumber(post.reactions_after);

      return {
        postId: String(post.id),
        channelTitle: getText(channels.get(String(post.channel_id)), "title"),
        postText: getText(post, "text"),
        commentsBefore,
        commentsAfter,
        reactionsBefore,
        reactionsAfter,
        commentDelta: commentsBefore === null || commentsAfter === null ? null : commentsAfter - commentsBefore,
        reactionDelta: reactionsBefore === null || reactionsAfter === null ? null : reactionsAfter - reactionsBefore
      };
    }),
    topToxicity: toxicity.map((event) => ({
      actionId: event.action_id,
      eventType: event.event_type,
      severity: event.severity,
      sourceText: event.source_text,
      createdAt: event.created_at
    }))
  };
}

async function listChannels(): Promise<{ channels: ChannelSettings[] }> {
  const { data, error } = await supabase
    .from("max_engagement_channels")
    .select(
      "id, max_channel_id, title, channel_kind, enabled, mode, bot_name, bot_signature, tone, emoji_level, humor_level, teasing_level, level_3_acknowledged_at, level_3_review_policy, working_hours_enabled, working_hours_timezone, working_hours_start, working_hours_end, answer_delay_min_seconds, answer_delay_max_seconds, reply_limit_hour, reply_limit_day, initiative_limit_hour, initiative_limit_day, user_tease_limit_day, politics_teasing_level, dry_run"
    )
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return {
    channels: (data ?? []) as ChannelSettings[]
  };
}

async function updateChannel(id: string, body: unknown): Promise<{ ok: true }> {
  const input = body as Record<string, unknown>;
  const teasingLevel = clampInteger(input.teasing_level, 0, 3, "teasing_level");
  const level3Acknowledged = Boolean(input.level_3_acknowledged);

  if (teasingLevel === 3 && !level3Acknowledged) {
    throw new HttpError(400, "Уровень 3 требует явного подтверждения риска");
  }

  const patch = {
    enabled: Boolean(input.enabled),
    dry_run: Boolean(input.dry_run),
    title: requiredString(input.title, "title"),
    channel_kind: enumString(input.channel_kind, ["moms", "news"], "channel_kind"),
    mode: enumString(
      input.mode,
      ["off", "mentions_only", "questions_only", "suitable_messages", "revive", "moderation_only"],
      "mode"
    ),
    bot_name: optionalString(input.bot_name),
    bot_signature: optionalString(input.bot_signature),
    tone: enumString(input.tone, ["friendly", "neutral", "official", "conversational"], "tone"),
    emoji_level: clampInteger(input.emoji_level, 0, 3, "emoji_level"),
    humor_level: clampInteger(input.humor_level, 0, 3, "humor_level"),
    teasing_level: teasingLevel,
    level_3_acknowledged_at: teasingLevel === 3 ? new Date().toISOString() : null,
    level_3_review_policy: enumString(input.level_3_review_policy, ["draft_required", "post_moderation"], "level_3_review_policy"),
    working_hours_enabled: Boolean(input.working_hours_enabled),
    working_hours_timezone: optionalString(input.working_hours_timezone) || "Europe/Moscow",
    working_hours_start: optionalTime(input.working_hours_start),
    working_hours_end: optionalTime(input.working_hours_end),
    answer_delay_min_seconds: clampInteger(input.answer_delay_min_seconds, 0, 86400, "answer_delay_min_seconds"),
    answer_delay_max_seconds: clampInteger(input.answer_delay_max_seconds, 0, 86400, "answer_delay_max_seconds"),
    reply_limit_hour: clampInteger(input.reply_limit_hour, 0, 10000, "reply_limit_hour"),
    reply_limit_day: clampInteger(input.reply_limit_day, 0, 100000, "reply_limit_day"),
    initiative_limit_hour: clampInteger(input.initiative_limit_hour, 0, 10000, "initiative_limit_hour"),
    initiative_limit_day: clampInteger(input.initiative_limit_day, 0, 100000, "initiative_limit_day"),
    user_tease_limit_day: clampInteger(input.user_tease_limit_day, 0, 1000, "user_tease_limit_day"),
    politics_teasing_level: clampInteger(input.politics_teasing_level, 0, 3, "politics_teasing_level")
  };

  if (patch.answer_delay_max_seconds < patch.answer_delay_min_seconds) {
    throw new HttpError(400, "Максимальная задержка не может быть меньше минимальной");
  }

  const { error } = await supabase.from("max_engagement_channels").update(patch).eq("id", id);
  if (error) {
    throw error;
  }

  return { ok: true };
}

async function listStyleExamples(channelId: string | null): Promise<{ examples: StyleExample[] }> {
  let query = supabase
    .from("max_engagement_style_examples")
    .select("id, channel_id, example_type, source_type, text, notes, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (channelId && channelId !== "all") {
    query = query.eq("channel_id", channelId);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as StyleExample[];
  const channels = await fetchByIds("max_engagement_channels", rows.map((row) => row.channel_id).filter(isString), "id,title");

  return {
    examples: rows.map((row) => ({
      ...row,
      channel_title: row.channel_id ? getText(channels.get(row.channel_id), "title") : null
    }))
  };
}

async function createStyleExamples(body: unknown): Promise<{ ok: true; inserted: number }> {
  const input = body as Record<string, unknown>;
  const channelId = optionalString(input.channel_id);
  const exampleType = enumString(input.example_type, ["admin_message", "good_tease", "too_much"], "example_type");
  const sourceType = enumString(
    input.source_type,
    ["manual", "txt", "csv", "json", "screenshot", "max", "telegram", "whatsapp", "vk"],
    "source_type"
  );
  const notes = optionalString(input.notes);
  const values = Array.isArray(input.texts) ? input.texts : [input.text];
  const rows = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((text) => text.length > 0)
    .slice(0, 100)
    .map((text) => ({
      channel_id: channelId,
      example_type: exampleType,
      source_type: sourceType,
      text,
      notes
    }));

  if (rows.length === 0) {
    throw new HttpError(400, "Нужно добавить хотя бы один текстовый пример");
  }

  const { error } = await supabase.from("max_engagement_style_examples").insert(rows);
  if (error) {
    throw error;
  }

  return { ok: true, inserted: rows.length };
}

async function deleteStyleExample(id: string): Promise<{ ok: true }> {
  const { error } = await supabase.from("max_engagement_style_examples").delete().eq("id", id);
  if (error) {
    throw error;
  }

  return { ok: true };
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate": 'Basic realm="MAX engagement admin"'
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function isString(value: string | null | undefined): value is string {
  return typeof value === "string";
}

function getText(row: Record<string, unknown> | undefined, key: string): string | null {
  return typeof row?.[key] === "string" ? row[key] : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function extractWebhookUpdates(body: unknown): MaxUpdate[] {
  if (Array.isArray(body)) {
    return body.filter(isMaxUpdate);
  }

  if (isRecord(body)) {
    if (Array.isArray(body.updates)) {
      return body.updates.filter(isMaxUpdate);
    }

    if (isMaxUpdate(body)) {
      return [body];
    }
  }

  throw new HttpError(400, "MAX webhook payload does not contain updates");
}

function isMaxUpdate(value: unknown): value is MaxUpdate {
  return isRecord(value) && typeof value.update_type === "string";
}

function isAdminAuthorized(req: IncomingMessage): boolean {
  if (!adminSecret) {
    return true;
  }

  const authorization = getHeaderValue(req, "authorization");
  if (!authorization) {
    return false;
  }

  if (authorization.startsWith("Bearer ")) {
    return safeEqual(authorization.slice("Bearer ".length).trim(), adminSecret);
  }

  if (authorization.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
    return safeEqual(password, adminSecret);
  }

  return false;
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}

function safeEqual(left: string | null | undefined, right: string): boolean {
  if (!left) {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) {
    throw new HttpError(400, `${field} is required`);
  }
  return result;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function enumString<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && allowed.includes(value as T)) {
    return value as T;
  }

  throw new HttpError(400, `${field} has invalid value`);
}

function clampInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${field} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

function optionalTime(value: unknown): string | null {
  const time = optionalString(value);
  if (!time) {
    return null;
  }

  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) {
    throw new HttpError(400, "working hours must use HH:MM format");
  }

  return time.length === 5 ? `${time}:00` : time;
}

function renderDashboard(): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MAX Engagement Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #17202a;
      --muted: #667085;
      --line: #d9dee7;
      --accent: #12695f;
      --accent-2: #8a4b12;
      --danger: #a03434;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 20px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      position: sticky;
      top: 0;
      z-index: 2;
    }

    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
    }

    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 18px 20px 32px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }

    .tab {
      background: #fff;
    }

    .tab.active {
      border-color: var(--accent);
      color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }

    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      box-shadow: var(--shadow);
      min-width: 0;
    }

    .metric strong {
      display: block;
      font-size: 22px;
      line-height: 1.1;
      margin-bottom: 5px;
    }

    .metric span {
      color: var(--muted);
      font-size: 12px;
    }

    .status {
      color: var(--muted);
      min-height: 20px;
    }

    button {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      min-height: 34px;
      padding: 0 12px;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
    }

    button:hover { border-color: #aeb7c5; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.warn { color: var(--accent-2); }
    button.danger { color: var(--danger); }
    button:disabled { cursor: wait; opacity: .55; }

    .list {
      display: grid;
      gap: 10px;
    }

    .analytics-list {
      display: grid;
      gap: 10px;
    }

    .settings-grid {
      display: grid;
      gap: 12px;
    }

    .settings-form {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 14px;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 12px;
    }

    .field {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    .field.wide {
      grid-column: span 2;
    }

    .field.full {
      grid-column: 1 / -1;
    }

    label {
      color: var(--muted);
      font-size: 12px;
    }

    input, select, textarea {
      width: 100%;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 9px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }

    textarea {
      min-height: 70px;
      resize: vertical;
    }

    input[type="checkbox"] {
      width: 18px;
      min-height: 18px;
    }

    .check-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
    }

    .risk {
      grid-column: 1 / -1;
      border: 1px solid #e4b9b9;
      background: #fff5f5;
      border-radius: 8px;
      padding: 10px;
    }

    .split {
      display: grid;
      grid-template-columns: minmax(280px, 390px) minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }

    .item {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .item-head {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 0 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fafbfc;
      color: var(--muted);
    }

    .badge.level { color: var(--accent-2); border-color: #e3c7a2; background: #fff8ef; }
    .badge.review { color: var(--danger); border-color: #e4b9b9; background: #fff5f5; }

    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }

    .item-body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 0;
    }

    .cell {
      padding: 14px;
      min-width: 0;
    }

    .cell + .cell {
      border-left: 1px solid var(--line);
    }

    .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }

    .text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .empty {
      padding: 42px 18px;
      text-align: center;
      color: var(--muted);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    @media (max-width: 760px) {
      header, .toolbar, .item-head {
        align-items: stretch;
        flex-direction: column;
        display: flex;
      }

      .actions { justify-content: flex-start; }
      .item-body { grid-template-columns: 1fr; }
      .cell + .cell { border-left: 0; border-top: 1px solid var(--line); }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .form-grid { grid-template-columns: 1fr; }
      .field.wide, .field.full { grid-column: 1; }
      .split { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>MAX Engagement Admin</h1>
    <button id="refresh">Обновить</button>
  </header>
  <main>
    <nav class="tabs" aria-label="Разделы">
      <button class="tab active" data-view="review">Ревью</button>
      <button class="tab" data-view="teases">Журнал подколов</button>
      <button class="tab" data-view="level3">Только уровень 3</button>
      <button class="tab" data-view="analytics">Аналитика</button>
      <button class="tab" data-view="settings">Настройки каналов</button>
      <button class="tab" data-view="style">Стиль</button>
    </nav>
    <div class="toolbar">
      <div class="status" id="status">Загрузка...</div>
    </div>
    <section class="metrics" id="metrics" hidden></section>
    <section class="list" id="list"></section>
  </main>
  <script>
    const list = document.getElementById("list");
    const metrics = document.getElementById("metrics");
    const status = document.getElementById("status");
    const refresh = document.getElementById("refresh");
    const tabs = Array.from(document.querySelectorAll(".tab"));
    let currentView = "review";

    refresh.addEventListener("click", load);
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        currentView = tab.dataset.view;
        tabs.forEach((item) => item.classList.toggle("active", item === tab));
        load();
      });
    });
    load();

    async function load() {
      refresh.disabled = true;
      status.textContent = "Загрузка...";
      try {
        if (currentView === "analytics") {
          const response = await fetch("/api/analytics");
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Ошибка загрузки");
          renderAnalytics(payload);
          status.textContent = "Аналитика по текущим данным Supabase";
        } else if (currentView === "settings") {
          const response = await fetch("/api/channels");
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Ошибка загрузки");
          renderSettings(payload.channels || []);
          status.textContent = payload.channels.length
            ? "Каналов: " + payload.channels.length
            : "Нет подключенных каналов";
        } else if (currentView === "style") {
          const [channelsResponse, examplesResponse] = await Promise.all([
            fetch("/api/channels"),
            fetch("/api/style-examples")
          ]);
          const channelsPayload = await channelsResponse.json();
          const examplesPayload = await examplesResponse.json();
          if (!channelsResponse.ok) throw new Error(channelsPayload.error || "Ошибка загрузки каналов");
          if (!examplesResponse.ok) throw new Error(examplesPayload.error || "Ошибка загрузки примеров");
          renderStyle(channelsPayload.channels || [], examplesPayload.examples || []);
          status.textContent = "Примеров стиля: " + (examplesPayload.examples || []).length;
        } else {
          const query = currentView === "level3" ? "?view=teases&level=3" : "?view=" + currentView;
          const response = await fetch("/api/actions" + query);
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Ошибка загрузки");
          renderActions(payload.actions || []);
          status.textContent = payload.actions.length
            ? "Записей: " + payload.actions.length
            : "Нет записей для выбранного фильтра";
        }
      } catch (error) {
        status.textContent = error.message;
        list.innerHTML = "";
        metrics.hidden = true;
        metrics.innerHTML = "";
      } finally {
        refresh.disabled = false;
      }
    }

    function renderSettings(channels) {
      metrics.hidden = true;
      metrics.innerHTML = "";

      if (!channels.length) {
        list.innerHTML = '<div class="empty">Каналы не найдены. Запустите seed или подключите канал MAX.</div>';
        return;
      }

      list.innerHTML = '<div class="settings-grid">' + channels.map((channel) => \`
        <form class="settings-form" data-channel-id="\${channel.id}" onsubmit="saveChannel(event)">
          <div class="item-head" style="padding: 0 0 12px; border-bottom: 1px solid var(--line);">
            <div>
              <strong>\${escapeHtml(channel.title)}</strong>
              <div class="meta">
                <span class="badge">\${escapeHtml(channel.max_channel_id)}</span>
                <span class="badge">\${channel.enabled ? "включен" : "выключен"}</span>
                <span class="badge">\${channel.dry_run ? "dry-run" : "live"}</span>
              </div>
            </div>
            <div class="actions">
              <button class="primary" type="submit">Сохранить</button>
            </div>
          </div>
          <div class="form-grid">
            \${field("Название", "title", channel.title, "text", "wide")}
            \${field("Имя бота", "bot_name", channel.bot_name || "", "text")}
            \${selectField("Тип паблика", "channel_kind", channel.channel_kind, [["moms", "мамочки"], ["news", "новости"]])}
            \${selectField("Режим", "mode", channel.mode, [
              ["off", "выключен"],
              ["mentions_only", "только упоминания"],
              ["questions_only", "только вопросы"],
              ["suitable_messages", "все подходящие"],
              ["revive", "оживление"],
              ["moderation_only", "модерация без ответов"]
            ])}
            \${selectField("Тон", "tone", channel.tone, [
              ["friendly", "дружелюбный"],
              ["neutral", "нейтральный"],
              ["official", "официальный"],
              ["conversational", "разговорный"]
            ])}
            \${numberField("Уровень подкола", "teasing_level", channel.teasing_level, 0, 3)}
            \${numberField("Политика/спорное", "politics_teasing_level", channel.politics_teasing_level, 0, 3)}
            \${selectField("Ревью уровня 3", "level_3_review_policy", channel.level_3_review_policy, [
              ["draft_required", "черновик обязателен"],
              ["post_moderation", "пост-модерация"]
            ])}
            \${numberField("Эмодзи", "emoji_level", channel.emoji_level, 0, 3)}
            \${numberField("Юмор", "humor_level", channel.humor_level, 0, 3)}
            \${numberField("Ответов/час", "reply_limit_hour", channel.reply_limit_hour, 0, 10000)}
            \${numberField("Ответов/сутки", "reply_limit_day", channel.reply_limit_day, 0, 100000)}
            \${numberField("Инициатив/час", "initiative_limit_hour", channel.initiative_limit_hour, 0, 10000)}
            \${numberField("Инициатив/сутки", "initiative_limit_day", channel.initiative_limit_day, 0, 100000)}
            \${numberField("Подколов на пользователя/сутки", "user_tease_limit_day", channel.user_tease_limit_day, 0, 1000, "wide")}
            \${numberField("Мин. задержка, сек", "answer_delay_min_seconds", channel.answer_delay_min_seconds, 0, 86400)}
            \${numberField("Макс. задержка, сек", "answer_delay_max_seconds", channel.answer_delay_max_seconds, 0, 86400)}
            \${field("Часовой пояс", "working_hours_timezone", channel.working_hours_timezone, "text")}
            \${field("Начало работы", "working_hours_start", normalizeTime(channel.working_hours_start), "time")}
            \${field("Конец работы", "working_hours_end", normalizeTime(channel.working_hours_end), "time")}
            <div class="field"><label>Включен</label><div class="check-row"><input name="enabled" type="checkbox" \${channel.enabled ? "checked" : ""}> <span>бот активен</span></div></div>
            <div class="field"><label>Dry-run</label><div class="check-row"><input name="dry_run" type="checkbox" \${channel.dry_run ? "checked" : ""}> <span>не публиковать в MAX</span></div></div>
            <div class="field"><label>Рабочее время</label><div class="check-row"><input name="working_hours_enabled" type="checkbox" \${channel.working_hours_enabled ? "checked" : ""}> <span>учитывать расписание</span></div></div>
            <div class="field full">
              <label>Подпись</label>
              <textarea name="bot_signature">\${escapeHtml(channel.bot_signature || "")}</textarea>
            </div>
            <div class="risk">
              <div class="check-row">
                <input name="level_3_acknowledged" type="checkbox" \${channel.level_3_acknowledged_at ? "checked" : ""}>
                <span>Понимаю риски уровня 3: прямой стёб над репликой требует регулярного ревью и может быть сохранён только с этим подтверждением.</span>
              </div>
            </div>
          </div>
        </form>
      \`).join("") + '</div>';
    }

    function renderStyle(channels, examples) {
      metrics.hidden = true;
      metrics.innerHTML = "";

      const channelOptions = channels.map((channel) =>
        \`<option value="\${escapeHtml(channel.id)}">\${escapeHtml(channel.title)}</option>\`
      ).join("");

      list.innerHTML = \`
        <div class="split">
          <form class="settings-form" onsubmit="saveStyleExamples(event)">
            <div class="item-head" style="padding: 0 0 12px; border-bottom: 1px solid var(--line);">
              <div>
                <strong>Примеры стиля</strong>
                <div class="meta">
                  <span class="badge">admin_message</span>
                  <span class="badge">good_tease</span>
                  <span class="badge">too_much</span>
                </div>
              </div>
              <div class="actions">
                <button class="primary" type="submit">Добавить</button>
              </div>
            </div>
            <div class="form-grid" style="grid-template-columns: 1fr;">
              <div class="field">
                <label>Канал</label>
                <select name="channel_id">\${channelOptions}</select>
              </div>
              \${selectField("Тип примера", "example_type", "admin_message", [
                ["admin_message", "сообщение администратора"],
                ["good_tease", "удачный подкол"],
                ["too_much", "перебор"]
              ])}
              \${selectField("Источник", "source_type", "manual", [
                ["manual", "ручной ввод"],
                ["txt", ".txt"],
                ["csv", ".csv"],
                ["json", ".json"],
                ["max", "MAX"],
                ["telegram", "Telegram"],
                ["whatsapp", "WhatsApp"],
                ["vk", "VK"]
              ])}
              <div class="field">
                <label>Файл .txt/.csv/.json</label>
                <input name="style_file" type="file" accept=".txt,.csv,.json,text/plain,application/json,text/csv">
              </div>
              <div class="field">
                <label>Тексты</label>
                <textarea name="text" placeholder="Один пример на абзац или строку"></textarea>
              </div>
              <div class="field">
                <label>Заметка</label>
                <input name="notes" type="text" placeholder="Например: тон мягкий, без перехода на личности">
              </div>
            </div>
          </form>
          <section class="list">
            \${examples.length ? examples.map((example) => \`
              <article class="item">
                <div class="item-head">
                  <div>
                    <strong>\${escapeHtml(example.channel_title || "Канал")}</strong>
                    <div class="meta">
                      <span class="badge">\${escapeHtml(example.example_type)}</span>
                      <span class="badge">\${escapeHtml(example.source_type)}</span>
                      <span class="badge">\${new Date(example.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                  <div class="actions">
                    <button class="danger" onclick="deleteStyleExample('\${example.id}')">Удалить</button>
                  </div>
                </div>
                <div class="cell">
                  <div class="text">\${escapeHtml(example.text)}</div>
                  \${example.notes ? \`<div class="label" style="margin-top: 12px;">Заметка</div><div class="text">\${escapeHtml(example.notes)}</div>\` : ""}
                </div>
              </article>
            \`).join("") : '<div class="empty">Примеры пока не загружены.</div>'}
          </section>
        </div>
      \`;
    }

    function renderActions(actions) {
      metrics.hidden = true;
      metrics.innerHTML = "";

      if (!actions.length) {
        list.innerHTML = '<div class="empty">Нет черновиков. Запустите seed и dry-run worker, если нужен тестовый пример.</div>';
        return;
      }

      list.innerHTML = actions.map((action) => \`
        <article class="item">
          <div class="item-head">
            <div>
              <strong>\${escapeHtml(action.channel_title || "Канал")}</strong>
              <div class="meta">
                <span class="badge">\${escapeHtml(action.status)}</span>
                <span class="badge">\${escapeHtml(action.action_type)}</span>
                <span class="badge level">уровень \${action.final_teasing_level}</span>
                \${action.requires_human_review ? '<span class="badge review">ревью обязательно</span>' : ''}
                <span class="badge">\${new Date(action.created_at).toLocaleString()}</span>
              </div>
            </div>
            <div class="actions">
              <button class="primary" onclick="sendCommand('\${action.id}', 'approve')">Одобрить</button>
              <button class="warn" onclick="sendCommand('\${action.id}', 'skip')">Пропустить</button>
              <button class="danger" onclick="sendCommand('\${action.id}', 'stop-thread')">Стоп тред</button>
              <button class="danger" onclick="sendCommand('\${action.id}', 'delete-own')">Удалить свой</button>
            </div>
          </div>
          <div class="item-body">
            <div class="cell">
              <div class="label">Комментарий подписчика</div>
              <div class="text"><strong>\${escapeHtml(action.comment_author || "Автор")}</strong>: \${escapeHtml(action.comment_text || "")}</div>
              <div class="label" style="margin-top: 12px;">Пост</div>
              <div class="text">\${escapeHtml(action.post_text || "")}</div>
            </div>
            <div class="cell">
              <div class="label">Черновик ответа</div>
              <div class="text">\${escapeHtml(action.generated_text || "")}</div>
              <div class="label" style="margin-top: 12px;">Safety reason</div>
              <div class="text">\${escapeHtml(action.safety_reason || "")}</div>
            </div>
          </div>
        </article>
      \`).join("");
    }

    function renderAnalytics(payload) {
      const totals = payload.totals || {};
      metrics.hidden = false;
      metrics.innerHTML = [
        ["Посты", totals.posts],
        ["Комментарии", totals.subscriberComments],
        ["Действия бота", totals.botActions],
        ["Подколы", totals.botTeases],
        ["Уровень 3", totals.level3],
        ["Индекс токсичности", totals.toxicityIndex]
      ].map(([label, value]) => \`
        <div class="metric">
          <strong>\${escapeHtml(value ?? 0)}</strong>
          <span>\${escapeHtml(label)}</span>
        </div>
      \`).join("");

      const engagement = payload.engagement || [];
      const toxicity = payload.topToxicity || [];

      list.innerHTML = \`
        <div class="analytics-list">
          \${engagement.length ? engagement.map((post) => \`
            <article class="item">
              <div class="item-head">
                <div>
                  <strong>\${escapeHtml(post.channelTitle || "Канал")}</strong>
                  <div class="meta">
                    <span class="badge">комм. Δ \${formatDelta(post.commentDelta)}</span>
                    <span class="badge">реакц. Δ \${formatDelta(post.reactionDelta)}</span>
                  </div>
                </div>
              </div>
              <div class="cell">
                <div class="label">Пост</div>
                <div class="text">\${escapeHtml(post.postText || "")}</div>
              </div>
            </article>
          \`).join("") : '<div class="empty">Пока нет постов для аналитики.</div>'}
          \${toxicity.length ? toxicity.map((event) => \`
            <article class="item">
              <div class="item-head">
                <div>
                  <strong>Негативная реакция</strong>
                  <div class="meta">
                    <span class="badge review">\${escapeHtml(event.eventType)}</span>
                    <span class="badge">severity \${escapeHtml(event.severity)}</span>
                    <span class="badge">\${new Date(event.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              </div>
              <div class="cell">
                <div class="text">\${escapeHtml(event.sourceText || "")}</div>
              </div>
            </article>
          \`).join("") : ""}
        </div>
      \`;
    }

    async function sendCommand(id, command) {
      status.textContent = "Сохраняю...";
      const response = await fetch("/api/actions/" + id + "/" + command, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        status.textContent = payload.error || "Ошибка";
        return;
      }
      await load();
    }

    async function saveChannel(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const id = form.dataset.channelId;
      const body = Object.fromEntries(new FormData(form).entries());
      for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) {
        body[checkbox.name] = checkbox.checked;
      }
      for (const number of form.querySelectorAll('input[type="number"]')) {
        body[number.name] = Number(number.value);
      }

      if (Number(body.teasing_level) === 3 && !body.level_3_acknowledged) {
        status.textContent = "Уровень 3 требует явного подтверждения риска";
        return;
      }

      status.textContent = "Сохраняю настройки...";
      const response = await fetch("/api/channels/" + id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (!response.ok) {
        status.textContent = payload.error || "Ошибка сохранения";
        return;
      }
      await load();
    }

    async function saveStyleExamples(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const file = data.get("style_file");
      const manualText = String(data.get("text") || "");
      let texts = splitExamples(manualText);
      let sourceType = String(data.get("source_type") || "manual");

      if (file && file.size) {
        const fileText = await file.text();
        sourceType = sourceType === "manual" ? detectSourceType(file.name) : sourceType;
        texts = texts.concat(parseExamplesFromFile(file.name, fileText));
      }

      texts = Array.from(new Set(texts.map((text) => text.trim()).filter(Boolean))).slice(0, 100);
      if (!texts.length) {
        status.textContent = "Добавьте текст или файл с примерами";
        return;
      }

      status.textContent = "Сохраняю примеры...";
      const response = await fetch("/api/style-examples", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel_id: data.get("channel_id"),
          example_type: data.get("example_type"),
          source_type: sourceType,
          notes: data.get("notes"),
          texts
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        status.textContent = payload.error || "Ошибка сохранения";
        return;
      }
      form.reset();
      await load();
    }

    async function deleteStyleExample(id) {
      status.textContent = "Удаляю пример...";
      const response = await fetch("/api/style-examples/" + id, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        status.textContent = payload.error || "Ошибка удаления";
        return;
      }
      await load();
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function formatDelta(value) {
      if (value === null || value === undefined) return "нет данных";
      return value > 0 ? "+" + value : String(value);
    }

    function field(label, name, value, type, className = "") {
      return \`<div class="field \${className}">
        <label>\${escapeHtml(label)}</label>
        <input name="\${escapeHtml(name)}" type="\${escapeHtml(type)}" value="\${escapeHtml(value || "")}">
      </div>\`;
    }

    function numberField(label, name, value, min, max, className = "") {
      return \`<div class="field \${className}">
        <label>\${escapeHtml(label)}</label>
        <input name="\${escapeHtml(name)}" type="number" min="\${min}" max="\${max}" step="1" value="\${escapeHtml(value ?? 0)}">
      </div>\`;
    }

    function selectField(label, name, value, options) {
      return \`<div class="field">
        <label>\${escapeHtml(label)}</label>
        <select name="\${escapeHtml(name)}">
          \${options.map(([optionValue, optionLabel]) => \`
            <option value="\${escapeHtml(optionValue)}" \${optionValue === value ? "selected" : ""}>\${escapeHtml(optionLabel)}</option>
          \`).join("")}
        </select>
      </div>\`;
    }

    function normalizeTime(value) {
      if (!value) return "";
      return String(value).slice(0, 5);
    }

    function splitExamples(value) {
      return String(value)
        .split(/\\n\\s*\\n|\\r?\\n/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    function detectSourceType(fileName) {
      const name = String(fileName).toLowerCase();
      if (name.endsWith(".json")) return "json";
      if (name.endsWith(".csv")) return "csv";
      if (name.endsWith(".txt")) return "txt";
      return "manual";
    }

    function parseExamplesFromFile(fileName, content) {
      const sourceType = detectSourceType(fileName);
      if (sourceType === "json") {
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            return parsed.map((item) => typeof item === "string" ? item : item?.text).filter(Boolean);
          }
          if (Array.isArray(parsed.examples)) {
            return parsed.examples.map((item) => typeof item === "string" ? item : item?.text).filter(Boolean);
          }
        } catch {
          return splitExamples(content);
        }
      }

      if (sourceType === "csv") {
        return content
          .split(/\\r?\\n/)
          .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")).find(Boolean) || "")
          .filter(Boolean);
      }

      return splitExamples(content);
    }
  </script>
</body>
</html>`;
}
