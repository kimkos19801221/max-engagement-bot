alter table public.max_engagement_bot_actions
  add column if not exists chat_message_id uuid
  references public.max_engagement_chat_messages(id)
  on delete cascade;

create index if not exists max_engagement_bot_actions_chat_message_id_idx
  on public.max_engagement_bot_actions(chat_message_id);
