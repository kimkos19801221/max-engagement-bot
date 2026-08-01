import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { LocalEngagementRepository } from "./max-engagement/local-repository.js";
import type { MaxEngagementMode, TeasingLevel } from "./max-engagement/types.js";

const host = process.env.ADMIN_HOST || "127.0.0.1";
const port = Number(process.env.ADMIN_PORT || 4317);
const repository = new LocalEngagementRepository();

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

    if (req.method === "POST" && url.pathname === "/api/reset") {
      await repository.resetDemoData();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/actions") {
      sendJson(res, 200, { actions: await enrichActions(url.searchParams.get("view"), url.searchParams.get("level")) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/channels") {
      sendJson(res, 200, { channels: await repository.listChannels() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/analytics") {
      sendJson(res, 200, await repository.analyticsSummary());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/style-examples") {
      const data = await repository.read();
      const examples = await repository.listStyleExamples(url.searchParams.get("channelId"));
      sendJson(res, 200, {
        examples: examples.map((example) => ({
          ...example,
          channelTitle: data.channels.find((channel) => channel.id === example.channelId)?.title ?? null
        }))
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/style-examples") {
      const body = await readJson(req);
      const input = body as Record<string, unknown>;
      const texts = Array.isArray(input.texts) ? input.texts : [input.text];
      const inserted = await repository.createStyleExamples({
        channelId: asNullableString(input.channelId),
        exampleType: enumValue(input.exampleType, ["admin_message", "good_tease", "too_much"], "admin_message"),
        sourceType: enumValue(input.sourceType, ["manual", "txt", "csv", "json", "screenshot", "max", "telegram", "whatsapp", "vk"], "manual"),
        texts: texts.map((item) => String(item)),
        notes: asNullableString(input.notes)
      });
      sendJson(res, 200, { ok: true, inserted });
      return;
    }

    const styleMatch = url.pathname.match(/^\/api\/style-examples\/([0-9a-f-]+)$/);
    if (req.method === "DELETE" && styleMatch) {
      await repository.deleteStyleExample(styleMatch[1]);
      sendJson(res, 200, { ok: true });
      return;
    }

    const actionMatch = url.pathname.match(/^\/api\/actions\/([0-9a-f-]+)\/(approve|skip|stop-thread|delete-own)$/);
    if (req.method === "POST" && actionMatch) {
      await repository.updateAction(actionMatch[1], actionMatch[2] as "approve" | "skip" | "stop-thread" | "delete-own");
      sendJson(res, 200, { ok: true });
      return;
    }

    const channelMatch = url.pathname.match(/^\/api\/channels\/([0-9a-f-]+)$/);
    if (req.method === "PATCH" && channelMatch) {
      const body = await readJson(req);
      const input = body as Record<string, unknown>;
      await repository.updateChannel(channelMatch[1], {
        enabled: Boolean(input.enabled),
        dryRun: Boolean(input.dryRun),
        mode: enumValue<MaxEngagementMode>(input.mode, ["off", "mentions_only", "questions_only", "suitable_messages", "revive", "moderation_only"], "off"),
        teasingLevel: toTeasingLevel(input.teasingLevel),
        politicsTeasingLevel: toTeasingLevel(input.politicsTeasingLevel),
        replyLimitHour: Number(input.replyLimitHour),
        replyLimitDay: Number(input.replyLimitDay),
        initiativeLimitHour: Number(input.initiativeLimitHour),
        initiativeLimitDay: Number(input.initiativeLimitDay),
        userTeaseLimitDay: Number(input.userTeaseLimitDay),
        botName: asNullableString(input.botName) ?? undefined,
        botSignature: asNullableString(input.botSignature) ?? undefined
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`MAX engagement demo admin: http://${host}:${port}`);
});

async function enrichActions(view: string | null, level: string | null) {
  const [data, actions] = await Promise.all([repository.read(), repository.listActions({ view, level })]);
  return actions.map((action) => {
    const channel = data.channels.find((item) => item.id === action.channelId);
    const post = data.posts.find((item) => item.id === action.postId);
    const comment = data.comments.find((item) => item.id === action.triggerCommentId);
    return {
      ...action,
      channelTitle: channel?.title ?? null,
      postText: post?.text ?? null,
      commentAuthor: comment?.authorName ?? null,
      commentText: comment?.text ?? null
    };
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function enumValue<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function toTeasingLevel(value: unknown): TeasingLevel {
  const numeric = Number(value);
  if (numeric >= 3) return 3;
  if (numeric >= 2) return 2;
  if (numeric >= 1) return 1;
  return 0;
}

function renderDashboard(): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MAX Engagement Demo</title>
  <style>
    :root { color-scheme: light; --bg: #f6f7f8; --panel: #fff; --text: #1f252c; --muted: #68707c; --line: #dfe3e8; --accent: #176b87; --danger: #b42318; --warn: #9a6700; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 Arial, sans-serif; }
    header { padding: 18px 24px; border-bottom: 1px solid var(--line); background: var(--panel); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 20px; }
    main { max-width: 1180px; margin: 0 auto; padding: 20px; }
    .tabs, .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { border: 1px solid var(--line); background: #fff; color: var(--text); padding: 8px 11px; border-radius: 6px; cursor: pointer; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.danger { border-color: #f0b7b2; color: var(--danger); }
    button.warn { border-color: #efd28a; color: var(--warn); }
    .status { color: var(--muted); margin: 14px 0; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .metric, .item, form { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; }
    .metric span, .meta, label { color: var(--muted); font-size: 12px; }
    .list { display: grid; gap: 12px; }
    .item-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 10px; margin-bottom: 10px; }
    .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; margin: 4px 4px 0 0; color: var(--muted); }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .text { white-space: pre-wrap; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 8px; font: inherit; }
    textarea { min-height: 110px; resize: vertical; }
    .check { display: flex; align-items: center; gap: 8px; }
    .check input { width: auto; }
    @media (max-width: 760px) { header, .item-head { display: block; } .grid, .split, .form-grid { grid-template-columns: 1fr; } main { padding: 12px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>MAX Engagement Demo</h1>
      <div class="meta">Локальный режим без Supabase, GitHub и реальных MAX-токенов</div>
    </div>
    <div class="tabs">
      <button onclick="setView('actions')">Черновики</button>
      <button onclick="setView('teases')">Подколы</button>
      <button onclick="setView('level3')">Уровень 3</button>
      <button onclick="setView('analytics')">Аналитика</button>
      <button onclick="setView('channels')">Настройки</button>
      <button onclick="setView('style')">Стиль</button>
      <button class="warn" onclick="resetDemo()">Сброс demo</button>
    </div>
  </header>
  <main>
    <div id="status" class="status">Загрузка...</div>
    <section id="metrics" class="grid" hidden></section>
    <section id="list" class="list"></section>
  </main>
  <script>
    let view = "actions";
    const status = document.getElementById("status");
    const metrics = document.getElementById("metrics");
    const list = document.getElementById("list");
    load();

    function setView(next) { view = next; load(); }

    async function load() {
      status.textContent = "Загрузка...";
      metrics.hidden = true;
      metrics.innerHTML = "";
      if (view === "analytics") return renderAnalytics(await getJson("/api/analytics"));
      if (view === "channels") return renderChannels((await getJson("/api/channels")).channels);
      if (view === "style") return renderStyle((await getJson("/api/channels")).channels, (await getJson("/api/style-examples")).examples);
      const query = view === "teases" ? "?view=teases" : view === "level3" ? "?level=3" : "";
      renderActions((await getJson("/api/actions" + query)).actions);
    }

    async function getJson(path) {
      const response = await fetch(path);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Ошибка");
      status.textContent = "";
      return payload;
    }

    function renderActions(actions) {
      if (!actions.length) {
        list.innerHTML = '<div class="item">Черновиков нет. Запустите <code>npm run demo:sync</code>.</div>';
        return;
      }
      list.innerHTML = actions.map(action => \`
        <article class="item">
          <div class="item-head">
            <div>
              <strong>\${escapeHtml(action.channelTitle || "Канал")}</strong>
              <div class="meta">
                <span class="badge">\${escapeHtml(action.status)}</span>
                <span class="badge">\${escapeHtml(action.actionType)}</span>
                <span class="badge">уровень \${action.finalTeasingLevel}</span>
                \${action.requiresHumanReview ? '<span class="badge">ревью обязательно</span>' : ''}
              </div>
            </div>
            <div class="actions">
              <button class="primary" onclick="sendAction('\${action.id}', 'approve')">Одобрить</button>
              <button class="warn" onclick="sendAction('\${action.id}', 'skip')">Пропустить</button>
              <button class="danger" onclick="sendAction('\${action.id}', 'stop-thread')">Стоп тред</button>
              <button class="danger" onclick="sendAction('\${action.id}', 'delete-own')">Удалить свой</button>
            </div>
          </div>
          <div class="split">
            <div><div class="meta">Комментарий</div><div class="text"><strong>\${escapeHtml(action.commentAuthor || "Автор")}</strong>: \${escapeHtml(action.commentText || "")}</div><br><div class="meta">Пост</div><div class="text">\${escapeHtml(action.postText || "")}</div></div>
            <div><div class="meta">Черновик</div><div class="text">\${escapeHtml(action.generatedText || "")}</div><br><div class="meta">Причина безопасности</div><div class="text">\${escapeHtml(action.safetyReason || "")}</div></div>
          </div>
        </article>\`).join("");
    }

    function renderAnalytics(payload) {
      const totals = payload.totals || {};
      metrics.hidden = false;
      metrics.innerHTML = [
        ["Посты", totals.posts], ["Комментарии", totals.subscriberComments], ["Действия", totals.botActions],
        ["Подколы", totals.botTeases], ["Уровень 3", totals.level3], ["Токсичность", totals.toxicityIndex]
      ].map(([label, value]) => \`<div class="metric"><strong>\${escapeHtml(value ?? 0)}</strong><span>\${escapeHtml(label)}</span></div>\`).join("");
      list.innerHTML = (payload.engagement || []).map(post => \`
        <article class="item"><strong>\${escapeHtml(post.channelTitle || "Канал")}</strong>
        <div class="meta"><span class="badge">комм. Δ \${formatDelta(post.commentDelta)}</span><span class="badge">реакц. Δ \${formatDelta(post.reactionDelta)}</span></div>
        <div class="text">\${escapeHtml(post.postText || "")}</div></article>\`).join("") || '<div class="item">Нет данных.</div>';
      status.textContent = "";
    }

    function renderChannels(channels) {
      list.innerHTML = channels.map(channel => \`
        <form onsubmit="saveChannel(event)" data-id="\${channel.id}">
          <div class="item-head"><strong>\${escapeHtml(channel.title)}</strong><button class="primary" type="submit">Сохранить</button></div>
          <div class="form-grid">
            \${checkbox("enabled", "Включен", channel.enabled)}
            \${checkbox("dryRun", "Dry-run", channel.dryRun)}
            \${select("mode", channel.mode, [["off","выключен"],["mentions_only","только упоминания"],["questions_only","только вопросы"],["suitable_messages","все подходящие"],["revive","оживление"],["moderation_only","модерация"]])}
            \${number("teasingLevel", "Уровень подкола", channel.teasingLevel, 0, 3)}
            \${number("politicsTeasingLevel", "Политика/спорное", channel.politicsTeasingLevel, 0, 3)}
            \${number("replyLimitHour", "Ответов/час", channel.replyLimitHour, 0, 10000)}
            \${number("replyLimitDay", "Ответов/сутки", channel.replyLimitDay, 0, 100000)}
            \${number("initiativeLimitHour", "Инициатив/час", channel.initiativeLimitHour, 0, 10000)}
            \${number("initiativeLimitDay", "Инициатив/сутки", channel.initiativeLimitDay, 0, 100000)}
            \${number("userTeaseLimitDay", "Подколов на пользователя/сутки", channel.userTeaseLimitDay, 0, 1000)}
            \${field("botName", "Имя бота", channel.botName || "")}
            \${field("botSignature", "Подпись", channel.botSignature || "")}
          </div>
        </form>\`).join("");
      status.textContent = "";
    }

    function renderStyle(channels, examples) {
      const options = channels.map(channel => \`<option value="\${channel.id}">\${escapeHtml(channel.title)}</option>\`).join("");
      list.innerHTML = \`
        <div class="split">
          <form onsubmit="saveStyle(event)">
            <div class="item-head"><strong>Добавить пример</strong><button class="primary" type="submit">Добавить</button></div>
            <label>Канал</label><select name="channelId">\${options}</select>
            <label>Тип</label><select name="exampleType"><option value="admin_message">сообщение админа</option><option value="good_tease">удачный подкол</option><option value="too_much">перебор</option></select>
            <label>Текст</label><textarea name="text"></textarea>
            <label>Заметка</label><input name="notes">
          </form>
          <section class="list">
            \${examples.map(example => \`<article class="item"><div class="item-head"><strong>\${escapeHtml(example.channelTitle || "Канал")}</strong><button class="danger" onclick="deleteStyle('\${example.id}')">Удалить</button></div><div class="meta">\${escapeHtml(example.exampleType)} / \${escapeHtml(example.sourceType)}</div><div class="text">\${escapeHtml(example.text)}</div></article>\`).join("") || '<div class="item">Нет примеров.</div>'}
          </section>
        </div>\`;
      status.textContent = "";
    }

    async function sendAction(id, command) { await fetch("/api/actions/" + id + "/" + command, { method: "POST" }); load(); }
    async function resetDemo() { await fetch("/api/reset", { method: "POST" }); load(); }
    async function deleteStyle(id) { await fetch("/api/style-examples/" + id, { method: "DELETE" }); load(); }

    async function saveChannel(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const body = Object.fromEntries(new FormData(form).entries());
      for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) body[checkbox.name] = checkbox.checked;
      for (const numberInput of form.querySelectorAll('input[type="number"]')) body[numberInput.name] = Number(numberInput.value);
      await fetch("/api/channels/" + form.dataset.id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      load();
    }

    async function saveStyle(event) {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget).entries());
      await fetch("/api/style-examples", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...data, sourceType: "manual", texts: splitExamples(data.text) }) });
      event.currentTarget.reset();
      load();
    }

    function field(name, label, value) { return \`<div><label>\${label}</label><input name="\${name}" value="\${escapeHtml(value)}"></div>\`; }
    function number(name, label, value, min, max) { return \`<div><label>\${label}</label><input name="\${name}" type="number" min="\${min}" max="\${max}" value="\${escapeHtml(value)}"></div>\`; }
    function checkbox(name, label, checked) { return \`<label class="check"><input name="\${name}" type="checkbox" \${checked ? "checked" : ""}> \${label}</label>\`; }
    function select(name, value, options) { return \`<div><label>Режим</label><select name="\${name}">\${options.map(([optionValue, label]) => \`<option value="\${optionValue}" \${optionValue === value ? "selected" : ""}>\${label}</option>\`).join("")}</select></div>\`; }
    function escapeHtml(value) { return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
    function splitExamples(value) { return String(value || "").split(/\\n\\s*\\n|\\r?\\n/).map(item => item.trim()).filter(Boolean); }
    function formatDelta(value) { if (value === null || value === undefined) return "нет данных"; return value > 0 ? "+" + value : String(value); }
  </script>
</body>
</html>`;
}
