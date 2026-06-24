-- Hosted inbox domain identity facts and routing quarantine state.

alter table public.agentic_factory_inbox_webhook_deliveries
  add column if not exists webhook_id text,
  add column if not exists webhook_secret_id text;

update public.agentic_factory_inbox_webhook_deliveries
set webhook_id = ''
where webhook_id is null;

update public.agentic_factory_inbox_webhook_deliveries
set webhook_secret_id = ''
where webhook_secret_id is null;

alter table public.agentic_factory_inbox_webhook_deliveries
  alter column webhook_id set not null,
  alter column webhook_secret_id set not null;

alter table public.agentic_factory_inbox_trigger_events
  add column if not exists webhook_id text,
  add column if not exists team_ids jsonb not null default '[]'::jsonb;

update public.agentic_factory_inbox_trigger_events events
set webhook_id = deliveries.webhook_id
from public.agentic_factory_inbox_webhook_deliveries deliveries
where events.raw_event_ref = deliveries.id
  and events.webhook_id is null;

update public.agentic_factory_inbox_trigger_events
set webhook_id = ''
where webhook_id is null;

alter table public.agentic_factory_inbox_trigger_events
  alter column webhook_id set not null;

alter table public.agentic_factory_inbox_workflow_wakeups
  add column if not exists webhook_ids jsonb not null default '[]'::jsonb,
  add column if not exists team_ids jsonb not null default '[]'::jsonb,
  add column if not exists domain_id text,
  add column if not exists routing_error_reason text,
  add column if not exists routing_candidates jsonb;

update public.agentic_factory_inbox_workflow_wakeups wakeups
set
  webhook_ids = '[]'::jsonb,
  team_ids = coalesce(events.team_ids, '[]'::jsonb)
from public.agentic_factory_inbox_trigger_events events
where wakeups.source_event_id = events.id
  and wakeups.webhook_ids = '[]'::jsonb
  and wakeups.team_ids = '[]'::jsonb;

alter table public.agentic_factory_inbox_workflow_wakeups
  drop constraint if exists agentic_factory_inbox_workflow_wakeups_status_check;

alter table public.agentic_factory_inbox_workflow_wakeups
  add constraint agentic_factory_inbox_workflow_wakeups_status_check
  check (status in ('queued', 'leased', 'running', 'paused', 'completed', 'rejected', 'dead_letter', 'routing_error'));

drop index if exists public.agentic_factory_inbox_active_wake_key_idx;

create unique index agentic_factory_inbox_active_wake_key_idx
  on public.agentic_factory_inbox_workflow_wakeups(workspace_id, wake_key)
  where status in ('queued', 'leased', 'running', 'routing_error');
