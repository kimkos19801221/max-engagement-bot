create table if not exists public.max_engagement_channels (
  id uuid primary key default gen_random_uuid(),
  max_channel_id text not null unique,
  title text not null,
  channel_kind text not null check (channel_kind in ('moms', 'news')),
  enabled boolean not null default false,
  mode text not null default 'off' check (
    mode in (
      'off',
      'mentions_only',
      'questions_only',
      'suitable_messages',
      'revive',
      'moderation_only'
    )
  ),
  bot_name text,
  bot_avatar_url text,
  bot_signature text,
  tone text not null default 'conversational' check (
    tone in ('friendly', 'neutral', 'official', 'conversational')
  ),
  address_style text not null default 'you_informal' check (
    address_style in ('you_informal', 'you_formal')
  ),
  emoji_level smallint not null default 1 check (emoji_level between 0 and 3),
  humor_level smallint not null default 1 check (humor_level between 0 and 3),
  teasing_level smallint not null default 1 check (teasing_level between 0 and 3),
  level_3_acknowledged_at timestamptz,
  level_3_review_policy text not null default 'draft_required' check (
    level_3_review_policy in ('draft_required', 'post_moderation')
  ),
  working_hours_enabled boolean not null default false,
  working_hours_timezone text not null default 'Europe/Moscow',
  working_hours_start time,
  working_hours_end time,
  answer_delay_min_seconds integer not null default 45 check (answer_delay_min_seconds >= 0),
  answer_delay_max_seconds integer not null default 240 check (answer_delay_max_seconds >= 0),
  reply_limit_hour integer not null default 20 check (reply_limit_hour >= 0),
  reply_limit_day integer not null default 120 check (reply_limit_day >= 0),
  initiative_limit_hour integer not null default 3 check (initiative_limit_hour >= 0),
  initiative_limit_day integer not null default 15 check (initiative_limit_day >= 0),
  user_tease_limit_day integer not null default 1 check (user_tease_limit_day >= 0),
  politics_teasing_level smallint not null default 0 check (politics_teasing_level between 0 and 3),
  dry_run boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint max_engagement_delay_order check (answer_delay_max_seconds >= answer_delay_min_seconds),
  constraint max_engagement_level_3_ack check (
    teasing_level < 3 or level_3_acknowledged_at is not null
  )
);

create table if not exists public.max_engagement_style_examples (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references public.max_engagement_channels(id) on delete cascade,
  example_type text not null check (
    example_type in ('admin_message', 'good_tease', 'too_much')
  ),
  source_type text not null default 'manual' check (
    source_type in ('manual', 'txt', 'csv', 'json', 'screenshot', 'max', 'telegram', 'whatsapp', 'vk')
  ),
  text text not null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.max_engagement_posts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.max_engagement_channels(id) on delete cascade,
  max_post_id text not null,
  source_url text,
  author_name text,
  text text,
  posted_at timestamptz,
  classification text not null default 'unknown' check (
    classification in (
      'unknown',
      'neutral',
      'entertainment',
      'tragedy',
      'emergency',
      'death',
      'violence',
      'child_harm',
      'politics',
      'disputed'
    )
  ),
  classification_confidence numeric(4, 3) not null default 0 check (
    classification_confidence >= 0 and classification_confidence <= 1
  ),
  classification_reason text,
  forced_teasing_level smallint not null default 0 check (forced_teasing_level between 0 and 3),
  comments_before integer,
  reactions_before integer,
  comments_after integer,
  reactions_after integer,
  collected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint max_engagement_posts_unique unique (channel_id, max_post_id)
);

create table if not exists public.max_engagement_threads (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.max_engagement_channels(id) on delete cascade,
  post_id uuid not null references public.max_engagement_posts(id) on delete cascade,
  max_thread_id text not null,
  status text not null default 'active' check (
    status in ('active', 'stopped', 'muted', 'review_required')
  ),
  stop_reason text,
  stopped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint max_engagement_threads_unique unique (post_id, max_thread_id)
);

create table if not exists public.max_engagement_comments (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.max_engagement_channels(id) on delete cascade,
  post_id uuid not null references public.max_engagement_posts(id) on delete cascade,
  thread_id uuid references public.max_engagement_threads(id) on delete set null,
  max_comment_id text,
  parent_max_comment_id text,
  author_user_id text,
  author_name text,
  text text not null,
  comment_kind text not null default 'subscriber' check (
    comment_kind in ('subscriber', 'admin', 'bot')
  ),
  sentiment text not null default 'unknown' check (
    sentiment in ('unknown', 'neutral', 'positive', 'negative', 'upset', 'complaint')
  ),
  risk_flags text[] not null default '{}',
  posted_at timestamptz,
  collected_at timestamptz not null default now()
);

create table if not exists public.max_engagement_bot_actions (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.max_engagement_channels(id) on delete cascade,
  post_id uuid references public.max_engagement_posts(id) on delete cascade,
  thread_id uuid references public.max_engagement_threads(id) on delete set null,
  trigger_comment_id uuid references public.max_engagement_comments(id) on delete set null,
  action_type text not null check (
    action_type in ('reply', 'initiative', 'moderate', 'stop_thread', 'delete_own_comment')
  ),
  status text not null default 'queued' check (
    status in ('queued', 'draft', 'approved', 'posted', 'skipped', 'deleted', 'failed')
  ),
  requested_teasing_level smallint not null default 0 check (requested_teasing_level between 0 and 3),
  final_teasing_level smallint not null default 0 check (final_teasing_level between 0 and 3),
  safety_reason text,
  generated_text text,
  posted_max_comment_id text,
  requires_human_review boolean not null default false,
  reviewed_by text,
  reviewed_at timestamptz,
  scheduled_for timestamptz,
  posted_at timestamptz,
  deleted_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint max_engagement_level_3_review check (
    final_teasing_level < 3 or requires_human_review
  )
);

create table if not exists public.max_engagement_toxicity_events (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.max_engagement_channels(id) on delete cascade,
  action_id uuid references public.max_engagement_bot_actions(id) on delete cascade,
  event_type text not null check (
    event_type in ('complaint', 'negative_reply', 'negative_reaction', 'unsubscribe_signal', 'admin_report')
  ),
  severity smallint not null default 1 check (severity between 1 and 5),
  source_user_id text,
  source_text text,
  created_at timestamptz not null default now()
);

create index if not exists max_engagement_channels_enabled_idx
  on public.max_engagement_channels(enabled, mode);

create index if not exists max_engagement_posts_channel_collected_idx
  on public.max_engagement_posts(channel_id, collected_at desc);

create index if not exists max_engagement_posts_classification_idx
  on public.max_engagement_posts(classification);

create index if not exists max_engagement_threads_status_idx
  on public.max_engagement_threads(channel_id, status);

create index if not exists max_engagement_comments_author_idx
  on public.max_engagement_comments(channel_id, author_user_id, collected_at desc);

create index if not exists max_engagement_bot_actions_review_idx
  on public.max_engagement_bot_actions(status, requires_human_review, created_at desc);

create index if not exists max_engagement_bot_actions_channel_posted_idx
  on public.max_engagement_bot_actions(channel_id, posted_at desc);

create index if not exists max_engagement_toxicity_channel_idx
  on public.max_engagement_toxicity_events(channel_id, created_at desc);

create or replace function public.set_max_engagement_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_max_engagement_channels_updated_at on public.max_engagement_channels;
create trigger set_max_engagement_channels_updated_at
before update on public.max_engagement_channels
for each row
execute function public.set_max_engagement_updated_at();

drop trigger if exists set_max_engagement_posts_updated_at on public.max_engagement_posts;
create trigger set_max_engagement_posts_updated_at
before update on public.max_engagement_posts
for each row
execute function public.set_max_engagement_updated_at();

drop trigger if exists set_max_engagement_threads_updated_at on public.max_engagement_threads;
create trigger set_max_engagement_threads_updated_at
before update on public.max_engagement_threads
for each row
execute function public.set_max_engagement_updated_at();

drop trigger if exists set_max_engagement_bot_actions_updated_at on public.max_engagement_bot_actions;
create trigger set_max_engagement_bot_actions_updated_at
before update on public.max_engagement_bot_actions
for each row
execute function public.set_max_engagement_updated_at();

alter table public.max_engagement_channels enable row level security;
alter table public.max_engagement_style_examples enable row level security;
alter table public.max_engagement_posts enable row level security;
alter table public.max_engagement_threads enable row level security;
alter table public.max_engagement_comments enable row level security;
alter table public.max_engagement_bot_actions enable row level security;
alter table public.max_engagement_toxicity_events enable row level security;

