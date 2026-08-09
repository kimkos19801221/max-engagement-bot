# Timeweb Cloud deployment

The bot is deployed on the same Timeweb Cloud server that hosts DecorRent to save money.
It must still run as an isolated Docker Compose project so it does not change or break DecorRent.

## Target Layout

- Server: existing DecorRent Timeweb Cloud server.
- Remote directory: `/opt/max-engagement-bot`.
- Compose project: `max-engagement-bot`.
- Worker container: `max-engagement-bot-worker`.
- Web container: `max-engagement-bot-web`.
- Docker network: `max-engagement-bot-net`.
- Env file: `/opt/max-engagement-bot/.env.timeweb`.

Do not reuse DecorRent container names, networks, env files, ports, PM2 processes, or compose project names.

## Do Not Touch

- DecorRent domain and Nginx config.
- DecorRent Dockerfile and Docker Compose files.
- DecorRent PM2/systemd processes.
- DecorRent environment variables.
- DecorRent database, migrations, or Supabase project.
- DecorRent GitHub Actions or deploy automation.

The bot can share the same VM, CPU, RAM, and Docker daemon. It should not share app-level runtime configuration.

## Deploy

From the local project:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-timeweb-env.ps1
powershell -ExecutionPolicy Bypass -File scripts/build-timeweb-package.ps1
powershell -ExecutionPolicy Bypass -File scripts/deploy-timeweb-ssh.ps1 -HostName <TIMEWEB_IP> -User root
```

The deploy script uploads the archive and `.env.timeweb`, then runs:

```bash
cd /opt/max-engagement-bot
docker compose -p max-engagement-bot -f docker-compose.timeweb.yml up -d --build
docker compose -p max-engagement-bot -f docker-compose.timeweb.yml ps
```

## Runtime

- `worker` runs `npm run max:watch` with long polling.
- `web` runs the admin server on port `4317` inside Docker only.
- No host port is published by default.
- Worker writes heartbeat to `.local-data/runtime/max-poll-heartbeat.json`.
- Worker healthcheck fails if heartbeat is stale.

## Required Env

Required in `.env.timeweb`:

```text
ENGAGEMENT_STORAGE=supabase
MAX_API_BASE_URL=https://platform-api2.max.ru
MAX_API_MODE=http
MAX_API_TOKEN=...
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
OPENAI_API_KEY=...
ADMIN_SECRET=...
```

Useful stability settings:

```text
MAX_UPDATES_TIMEOUT=25
MAX_POLL_IDLE_DELAY_MS=1000
MAX_POLL_ERROR_DELAY_MS=5000
MAX_API_REQUEST_TIMEOUT_MS=45000
MAX_POLL_WATCHDOG_MS=120000
MAX_WORKER_HEARTBEAT_MAX_AGE_MS=180000
```

## Checks On Server

```bash
cd /opt/max-engagement-bot
docker compose -p max-engagement-bot -f docker-compose.timeweb.yml ps
docker compose -p max-engagement-bot -f docker-compose.timeweb.yml logs --tail=100 worker
docker compose -p max-engagement-bot -f docker-compose.timeweb.yml exec worker node scripts/check-worker-health.mjs
```

Expected worker logs include stages like:

```text
[max-poll] step=get_marker
[max-poll] step=get_updates
[max-poll] step=import_updates
[max-poll] step=worker
```

## Stop Only The Bot

```bash
cd /opt/max-engagement-bot
docker compose -p max-engagement-bot -f docker-compose.timeweb.yml down
```

This must not stop DecorRent containers.
