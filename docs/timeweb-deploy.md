# Timeweb Cloud deployment

Главное правило: проект MAX engagement bot размещается отдельно от DecorRent. Без отдельного подтверждения владельца нельзя менять рабочую инфраструктуру DecorRent.

## Что не трогаем

- домен `decorrent.ru`;
- Nginx-конфигурацию DecorRent;
- Dockerfile и Docker Compose DecorRent;
- команды сборки и запуска DecorRent;
- переменные окружения DecorRent;
- базу данных, migrations и Supabase-проект DecorRent;
- сетевые настройки, порты и процессы PM2 DecorRent;
- GitHub Actions и автоматический деплой DecorRent.

## Изолированный запуск

Compose-файл этого проекта использует отдельные имена:

- compose project: `max-engagement-bot`;
- worker container: `max-engagement-bot-worker`;
- web container: `max-engagement-bot-web`;
- network: `max-engagement-bot-net`;
- env file: `.env.timeweb`.

Запуск:

```bash
powershell -ExecutionPolicy Bypass -File scripts/prepare-timeweb-env.ps1
docker compose -p max-engagement-bot -f docker-compose.timeweb.yml config
docker compose -p max-engagement-bot -f docker-compose.timeweb.yml up -d --build
docker compose -p max-engagement-bot -f docker-compose.timeweb.yml ps
```

`worker` запускает постоянный long polling `npm run max:watch`, хранит marker в Supabase и обрабатывает все включенные чаты через `channel_id`. `web` запускает админку и MAX webhook endpoint внутри Docker-сети на `4317`, но не публикует порт наружу. Это сделано специально, чтобы не менять общую сетевую конфигурацию сервера без согласования.

## Обязательные переменные

- `SUPABASE_URL`;
- `SUPABASE_SECRET_KEY` или `SUPABASE_SERVICE_ROLE_KEY`;
- `ENGAGEMENT_STORAGE=supabase`;
- `MAX_API_BASE_URL=https://platform-api2.max.ru`;
- `MAX_API_MODE=http`;
- `MAX_API_TOKEN`;
- `OPENAI_API_KEY`;
- `ADMIN_SECRET`.

`ADMIN_SECRET` защищает админку через HTTP Basic или `Authorization: Bearer <secret>`.

`MAX_WEBHOOK_URL` и `MAX_WEBHOOK_SECRET` нужны только если включается webhook-режим. Для текущего Timeweb-запуска достаточно long polling.

`MAX_WEBHOOK_SECRET` должен совпадать с `secret` в MAX webhook subscription. Сервер проверяет заголовок `X-Max-Bot-Api-Secret`.

## Выкладка по SSH

На локальной машине:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-timeweb-env.ps1
powershell -ExecutionPolicy Bypass -File scripts/build-timeweb-package.ps1
powershell -ExecutionPolicy Bypass -File scripts/deploy-timeweb-ssh.ps1 -HostName <TIMEWEB_IP> -User root
```

Если SSH-доступ по ключу не настроен, команда остановится на `Permission denied`.
Тогда нужно добавить публичный ключ в Timeweb Cloud или временно подключиться
паролем и настроить ключ вручную.

## Webhook

Локальный endpoint приложения:

```text
POST /webhooks/max
```

Production URL должен быть HTTPS endpoint на 443 порту, например:

```text
https://bot.example.ru/webhooks/max
```

После появления внешнего HTTPS-адреса:

```bash
npm run max:webhook:list
npm run max:webhook:subscribe
```

Если нужно снять подписку:

```bash
npm run max:webhook:delete
```

## Боевой переключатель

До финального включения все каналы должны оставаться с `dry_run=true`. Реальная публикация комментариев включается отдельно, после проверки:

- `npm run max:verify` показывает, что бот состоит в нужных чатах;
- у live-чатов есть право `write`;
- Supabase пишет посты и комментарии;
- worker создаёт draft/queued actions;
- админка защищена `ADMIN_SECRET`;
- тестовый канал проверен отдельно от основного канала.

Текущая безопасная схема:

- чаты/каналы различаются по `community_type` и внутреннему `channel_id`;
- сообщения обычных чатов пишутся в `max_engagement_chat_messages`;
- публикации каналов пишутся в `max_engagement_posts`;
- `max_engagement_runtime_state` хранит MAX polling marker;
- `city_memory_*` хранит изолированную городскую память.
