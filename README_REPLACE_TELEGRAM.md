# Telegram transport — replacement package

Цель этого пакета: добавить Telegram как второй транспорт к существующей Алине, не меняя `city-assistant.ts` и не ломая MAX.

## Что делает пакет

- вводит нейтральный `UnifiedChatMessage` и `ChatClient`;
- явно разделяет платформы `max` / `telegram`;
- сохраняет входящие Telegram attachments как `{ kind, raw }` без потери исходного payload;
- добавляет Telegram long polling (`getUpdates`);
- Telegram и MAX используют один Supabase и один `city-assistant`;
- MAX worker теперь обрабатывает только `platform=max`, Telegram worker — только `platform=telegram`;
- MAX post/comment pipeline остаётся на существующем `MaxClient`;
- `city-assistant.ts` НЕ заменять и НЕ трогать.

## ВАЖНЫЙ порядок установки

### 1. Сначала применить migration 007

`supabase/migrations/007_chat_platform_transport.sql`

Она:
- добавляет `platform text not null default 'max'`;
- сохраняет все существующие строки как MAX;
- меняет уникальность канала с `max_channel_id` на `(platform, max_channel_id)`.

**Не деплоить новый код до успешного применения migration 007.**

### 2. Скопировать файлы с сохранением путей

Заменяемые существующие файлы:
- `package.json`
- `src/max-engagement/types.ts`
- `src/max-engagement/repository.ts`
- `src/max-engagement/local-repository.ts`
- `src/max-engagement/antispam.ts`
- `src/worker.ts`

Новые файлы:
- `src/chat-transport/types.ts`
- `src/chat-transport/max-adapter.ts`
- `src/chat-transport/telegram-adapter.ts`
- `src/chat-transport/telegram-adapter.test.ts`
- `src/telegram-client.ts`
- `src/telegram-worker.ts`
- `src/telegram-timeweb-runtime.ts`
- `supabase/migrations/007_chat_platform_transport.sql`

### 3. Проверить локально

```powershell
npm run typecheck
npm test
```

На подготовленном пакете проверено:
- typecheck: passed
- tests: 9 files / 40 tests passed

### 4. Telegram env

Новый токен сюда/в git не писать. В Timeweb secrets/env добавить:

```env
TELEGRAM_BOT_TOKEN=NEW_TOKEN_FROM_BOTFATHER
TELEGRAM_UPDATES_TIMEOUT=25
TELEGRAM_POLL_OFFSET_FILE=/tmp/telegram-poll-offset.json
TELEGRAM_POLL_HEARTBEAT_FILE=/tmp/telegram-poll-heartbeat.json
```

Также Telegram app использует существующие production `SUPABASE_*`, `OPENAI_API_KEY`, `ENGAGEMENT_STORAGE=supabase`.

### 5. Timeweb App Platform

Создать отдельное приложение, например:

`max-engagement-bot-telegram`

Runtime command:

```text
npm run telegram:timeweb
```

`telegram:timeweb` запускает:
- `npm run web` — порт 3000 и `/healthz` для Timeweb healthcheck;
- `npm run telegram:watch` — постоянный Telegram polling.

MAX web/worker приложения не заменять Telegram-командой.

## Первый тест

1. В BotFather отключить Group Privacy.
2. Добавить бота в тестовую Telegram-группу (при необходимости удалить и добавить заново после смены Privacy Mode).
3. Написать обычное текстовое сообщение в группе.
4. В логах Telegram app должны появиться `step=get_updates`, затем `step=import_messages`.
5. В Supabase должна появиться строка `max_engagement_channels` с `platform='telegram'` и chat id группы.
6. MAX worker должен продолжать видеть только `platform='max'`.

## Вложения

Входящие Telegram contact/media payload уже сохраняются как raw attachments. Отдельная реализация исходящей отправки contact cards/media в этом пакете НЕ добавлена.

## Rollback

Если Telegram app не запускается:
- остановить только `max-engagement-bot-telegram`;
- MAX web/worker продолжат работать отдельно;
- migration 007 оставлять можно: default `platform='max'` обратимо совместим с существующими MAX-строками.
