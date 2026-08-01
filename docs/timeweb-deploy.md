# Timeweb Cloud deployment

Главное правило: проект MAX engagement bot размещается отдельно от DecorRent. Без отдельного подтверждения владельца нельзя менять рабочую инфраструктуру DecorRent.

## Что не трогаем

- домен `decorrent.ru`;
- Nginx-конфигурацию DecorRent;
- Dockerfile и Docker Compose DecorRent;
- команды сборки и запуска DecorRent;
- переменные окружения DecorRent;
- базу данных, migrations и Supabase-проект DecorRent;
- сетевые настройки DecorRent;
- порты DecorRent;
- процессы PM2 DecorRent;
- GitHub Actions и автоматический деплой DecorRent.

## Изолированный запуск

Compose-файл проекта использует отдельные имена:

- compose project: `max-engagement-bot`;
- worker container: `max-engagement-bot-worker`;
- web container: `max-engagement-bot-web`;
- network: `max-engagement-bot-net`;
- env file: `.env.timeweb`.

Запуск:

```bash
cp .env.example .env.timeweb
docker compose -f docker-compose.timeweb.yml up -d --build
```

`worker` запускает dry-run обработчик по расписанию.

`web` запускает админку и MAX webhook endpoint внутри Docker-сети на `4317`, но не публикует порт наружу. Это сделано специально, чтобы не менять общую сетевую конфигурацию сервера без согласования.

## Обязательные переменные

- `SUPABASE_URL`;
- `SUPABASE_SECRET_KEY` или `SUPABASE_SERVICE_ROLE_KEY`;
- `MAX_API_BASE_URL=https://platform-api2.max.ru`;
- `MAX_API_TOKEN`;
- `MAX_WEBHOOK_SECRET`;
- `ADMIN_SECRET`.

`ADMIN_SECRET` защищает админку через HTTP Basic или `Authorization: Bearer <secret>`.

`MAX_WEBHOOK_SECRET` должен совпадать с secret в MAX webhook subscription. Сервер проверяет заголовок `X-Max-Bot-Api-Secret`.

## Webhook

Локальный endpoint приложения:

```text
POST /webhooks/max
```

MAX production webhook должен быть доступен по HTTPS на 443 порту. Если для этого нужно добавить домен, reverse proxy, Nginx location, TLS-сертификат или проброс порта на сервере, сначала нужно согласование, потому что это уже общая инфраструктура.

## Боевой переключатель

До финального включения все каналы должны оставаться с `dry_run=true`. Реальная публикация комментариев включается отдельно, после проверки:

- webhook принимает события;
- Supabase пишет посты и комментарии;
- worker создаёт draft/queued actions;
- админка защищена `ADMIN_SECRET`;
- тестовый канал проверен отдельно от основного канала.
