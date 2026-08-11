-- Add an explicit transport dimension without renaming legacy MAX columns.
-- Existing rows remain MAX because of the default.
alter table public.max_engagement_channels
  add column if not exists platform text not null default 'max'
    check (platform in ('max', 'telegram'));

-- The original schema made max_channel_id globally unique. That would allow a
-- Telegram numeric chat id to collide with a MAX id, so identity becomes
-- (platform, max_channel_id). max_channel_id is kept as a legacy column name.
alter table public.max_engagement_channels
  drop constraint if exists max_engagement_channels_max_channel_id_key;

create unique index if not exists max_engagement_channels_platform_external_id_uidx
  on public.max_engagement_channels(platform, max_channel_id);

create index if not exists max_engagement_channels_platform_runnable_idx
  on public.max_engagement_channels(platform, enabled, mode, updated_at desc);
