alter table public.max_engagement_chat_messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

create table if not exists public.city_contact_directory (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.city_memory_cities(id) on delete cascade,
  public_id uuid not null references public.city_memory_publics(id) on delete cascade,
  channel_id uuid not null references public.max_engagement_channels(id) on delete cascade,

  category text not null,
  normalized_category text not null,

  contact_name text,
  phone text,
  normalized_phone text,
  max_contact_id text,

  attachment_fingerprint text not null,
  raw_attachment jsonb not null,

  source_message_id text not null,
  source_author_name text,
  source_context text not null default '',

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  times_shared integer not null default 1 check (times_shared >= 1),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists city_contact_directory_category_idx
  on public.city_contact_directory(channel_id, normalized_category, last_seen_at desc);

create index if not exists city_contact_directory_phone_idx
  on public.city_contact_directory(channel_id, normalized_phone)
  where normalized_phone is not null;

create index if not exists city_contact_directory_max_contact_idx
  on public.city_contact_directory(channel_id, max_contact_id)
  where max_contact_id is not null;

create unique index if not exists city_contact_directory_attachment_unique_idx
  on public.city_contact_directory(channel_id, attachment_fingerprint);

alter table public.city_contact_directory enable row level security;
