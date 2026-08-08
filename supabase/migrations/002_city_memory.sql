create table if not exists public.city_memory_cities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.city_memory_publics (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.city_memory_cities(id) on delete cascade,
  channel_id uuid not null references public.max_engagement_channels(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  constraint city_memory_publics_unique unique (city_id, channel_id)
);

create table if not exists public.city_memory_objects (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.city_memory_cities(id) on delete cascade,
  public_id uuid not null references public.city_memory_publics(id) on delete cascade,
  object_type text not null check (
    object_type in (
      'organization',
      'institution',
      'place',
      'service',
      'event',
      'temporary_change',
      'recommendation',
      'topic'
    )
  ),
  canonical_name text not null,
  aliases text[] not null default '{}',
  categories text[] not null default '{}',
  related_terms text[] not null default '{}',
  merged_into_id uuid references public.city_memory_objects(id) on delete set null,
  confidence numeric(4, 3) not null default 0 check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.city_memory_sources (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.city_memory_cities(id) on delete cascade,
  public_id uuid not null references public.city_memory_publics(id) on delete cascade,
  channel_id uuid not null references public.max_engagement_channels(id) on delete cascade,
  source_type text not null check (source_type in ('post', 'comment', 'admin', 'manual', 'system')),
  source_id text not null,
  author_name text,
  text_excerpt text not null,
  url text,
  received_at timestamptz not null default now(),
  constraint city_memory_sources_unique unique (public_id, source_type, source_id)
);

create table if not exists public.city_memory_knowledge (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.city_memory_cities(id) on delete cascade,
  public_id uuid not null references public.city_memory_publics(id) on delete cascade,
  object_id uuid not null references public.city_memory_objects(id) on delete cascade,
  knowledge_kind text not null check (
    knowledge_kind in (
      'address',
      'contact',
      'service',
      'hours',
      'event',
      'temporary_change',
      'resident_recommendation',
      'correction',
      'summary'
    )
  ),
  content text not null,
  normalized_content text not null,
  source_ids uuid[] not null default '{}',
  received_at timestamptz not null default now(),
  last_verified_at timestamptz,
  valid_until timestamptz,
  confidence numeric(4, 3) not null default 0 check (confidence >= 0 and confidence <= 1),
  trust text not null check (
    trust in ('official', 'admin', 'multi_resident', 'single_resident', 'disputed', 'stale')
  ),
  confirmations integer not null default 1 check (confirmations >= 0),
  refutations integer not null default 0 check (refutations >= 0),
  status text not null default 'active' check (status in ('active', 'needs_review', 'blocked', 'deleted')),
  contradiction_group_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint city_memory_knowledge_unique unique (object_id, knowledge_kind, normalized_content)
);

create table if not exists public.city_memory_revisions (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references public.city_memory_knowledge(id) on delete cascade,
  previous_content text,
  next_content text not null,
  source_id uuid not null references public.city_memory_sources(id) on delete cascade,
  change_type text not null check (change_type in ('created', 'confirmed', 'corrected', 'refuted', 'merged', 'blocked')),
  created_at timestamptz not null default now()
);

create table if not exists public.city_memory_blocked_items (
  id uuid primary key default gen_random_uuid(),
  city_id uuid references public.city_memory_cities(id) on delete cascade,
  public_id uuid references public.city_memory_publics(id) on delete cascade,
  source_id uuid references public.city_memory_sources(id) on delete set null,
  reason text not null,
  text_excerpt text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.city_memory_conversation_summaries (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.city_memory_cities(id) on delete cascade,
  public_id uuid not null references public.city_memory_publics(id) on delete cascade,
  thread_id uuid references public.max_engagement_threads(id) on delete set null,
  summary text not null,
  source_message_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists city_memory_publics_city_idx
  on public.city_memory_publics(city_id);

create index if not exists city_memory_objects_lookup_idx
  on public.city_memory_objects(city_id, public_id, canonical_name);

create index if not exists city_memory_objects_aliases_idx
  on public.city_memory_objects using gin(aliases);

create index if not exists city_memory_objects_related_terms_idx
  on public.city_memory_objects using gin(related_terms);

create index if not exists city_memory_knowledge_object_idx
  on public.city_memory_knowledge(object_id, status, confidence desc);

create index if not exists city_memory_knowledge_review_idx
  on public.city_memory_knowledge(status, updated_at desc);

create index if not exists city_memory_knowledge_contradiction_idx
  on public.city_memory_knowledge(contradiction_group_id)
  where contradiction_group_id is not null;

create index if not exists city_memory_blocked_items_review_idx
  on public.city_memory_blocked_items(created_at desc);

alter table public.city_memory_cities enable row level security;
alter table public.city_memory_publics enable row level security;
alter table public.city_memory_objects enable row level security;
alter table public.city_memory_sources enable row level security;
alter table public.city_memory_knowledge enable row level security;
alter table public.city_memory_revisions enable row level security;
alter table public.city_memory_blocked_items enable row level security;
alter table public.city_memory_conversation_summaries enable row level security;
