alter table public.max_engagement_channels
  alter column antispam_enabled set default true,
  alter column antispam_delete_links set default true;

update public.max_engagement_channels
set
  antispam_enabled = true,
  antispam_delete_links = true,
  updated_at = now()
where coalesce(platform, 'max') = 'max'
  and community_type = 'chat'
  and (
    antispam_enabled is distinct from true
    or antispam_delete_links is distinct from true
  );
