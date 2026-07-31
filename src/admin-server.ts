import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config as loadDotenv } from "dotenv";

import { createSupabaseClientFromEnv } from "./max-engagement/repository.js";

loadDotenv({ path: ".env.local", override: false });

const host = process.env.ADMIN_HOST || "127.0.0.1";
const port = Number(process.env.ADMIN_PORT || 4317);
const supabase = createSupabaseClientFromEnv();

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

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      sendJson(res, 400, { error: "Bad request" });
      return;
    }

    const url = new URL(req.url, `http://${host}:${port}`);

    if (req.method === "GET" && url.pathname === "/") {
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

    const actionMatch = url.pathname.match(/^\/api\/actions\/([0-9a-f-]+)\/(approve|skip|stop-thread|delete-own)$/);
    if (req.method === "POST" && actionMatch) {
      const [, id, command] = actionMatch;
      sendJson(res, 200, await updateAction(id, command as "approve" | "skip" | "stop-thread" | "delete-own"));
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`MAX engagement admin: http://${host}:${port}`);
});

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

function isString(value: string | null | undefined): value is string {
  return typeof value === "string";
}

function getText(row: Record<string, unknown> | undefined, key: string): string | null {
  return typeof row?.[key] === "string" ? row[key] : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
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
  </script>
</body>
</html>`;
}
