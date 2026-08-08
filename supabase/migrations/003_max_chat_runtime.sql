alter table public.max_engagement_channels
  add column if not exists community_type text not null default 'channel'
    check (community_type in ('channel', 'chat')),
  add column if not exists city_name text;

create table if not exists public.max_engagement_chat_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.max_engagement_channels(id) on delete cascade,
  max_message_id text not null,
  author_user_id text,
  author_name text,
  author_is_bot boolean not null default false,
  text text not null,
  posted_at timestamptz,
  reply_to_max_message_id text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint max_engagement_chat_messages_unique unique (channel_id, max_message_id)
);

create table if not exists public.max_engagement_runtime_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists max_engagement_chat_messages_unprocessed_idx
  on public.max_engagement_chat_messages(channel_id, posted_at, created_at)
  where processed_at is null;

create index if not exists max_engagement_chat_messages_recent_idx
  on public.max_engagement_chat_messages(channel_id, posted_at desc, created_at desc);

create or replace function public.set_max_chat_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_max_engagement_chat_messages_updated_at
  on public.max_engagement_chat_messages;

create trigger set_max_engagement_chat_messages_updated_at
before update on public.max_engagement_chat_messages
for each row execute function public.set_max_chat_updated_at();

alter table public.max_engagement_chat_messages enable row level security;
alter table public.max_engagement_runtime_state enable row level security;