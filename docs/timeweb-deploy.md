# Timeweb Cloud deployment

Главное правило: бот размещается отдельно от DecorRent. Нельзя менять рабочую
инфраструктуру DecorRent без отдельного подтверждения владельца.

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

## Изолированный вариант запуска

Бот запускается как отдельный worker-контейнер без публикации портов наружу:

```bash
cp .env.timeweb.example .env.timeweb
docker compose -f docker-compose.timeweb.yml up -d --build
```

Имена изолированных ресурсов:

- compose project: `max-engagement-bot`;
- container: `max-engagement-bot-worker`;
- network: `max-engagement-bot-net`;
- env file: `.env.timeweb`.

Такой запуск не требует Nginx, домена и открытых портов, потому что бот работает
как фоновый обработчик Supabase/MAX.

## Когда нужно сначала написать владельцу

Перед любым из этих действий нужно остановиться и запросить подтверждение:

- изменение общей Nginx-конфигурации сервера;
- публикация нового порта наружу;
- подключение домена или поддомена;
- изменение PM2;
- изменение GitHub Actions;
- изменение существующих Docker networks или compose-файлов DecorRent;
- использование базы данных или Supabase-проекта DecorRent.
