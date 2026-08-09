alter table public.max_engagement_channels
  add column if not exists antispam_enabled boolean not null default false,
  add column if not exists antispam_delete_links boolean not null default true;

alter table public.max_engagement_chat_messages
  add column if not exists linked_text text;
