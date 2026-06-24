-- Hosted webhook inbox and wake queue operational store.
create table if not exists public.agentic_factory_inbox_linear_webhook_secrets (
  id text primary key,
  workspace_id text not null,
  webhook_id text not null,
  webhook_url text,
  signing_secret text not null,
  active boolean not null default true,
  rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, webhook_id)
);

create table if not exists public.agentic_factory_inbox_webhook_deliveries (
  id text primary key,
  provider text not null,
  workspace_id text not null,
  delivery_id text not null,
  signature_valid boolean not null,
  raw_headers jsonb not null default '{}'::jsonb,
  raw_body text not null,
  received_at timestamptz not null default now(),
  dedupe_key text not null,
  retention_expires_at timestamptz not null,
  unique (provider, workspace_id, delivery_id)
);

create table if not exists public.agentic_factory_inbox_trigger_events (
  id text primary key,
  schema_version integer not null default 1,
  provider text not null,
  workspace_id text not null,
  event_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  actor jsonb,
  object jsonb not null,
  changed_fields text[] not null default '{}'::text[],
  raw_event_ref text references public.agentic_factory_inbox_webhook_deliveries(id) on delete set null,
  requires_runner_verification boolean not null default true,
  raw_payload jsonb,
  unique (provider, workspace_id, event_id)
);

create table if not exists public.agentic_factory_inbox_workflow_wakeups (
  id text primary key,
  workspace_id text not null,
  trigger_type text not null,
  workflow_type text not null,
  object_type text not null,
  object_id text not null,
  wake_key text not null,
  status text not null check (status in ('queued', 'leased', 'running', 'paused', 'completed', 'rejected', 'dead_letter')),
  reason text,
  source_event_id text references public.agentic_factory_inbox_trigger_events(id) on delete set null,
  requires_runner_verification boolean not null default true,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  runner_id text,
  lease_token text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  mutation_started_at timestamptz,
  attempt_count integer not null default 0,
  terminal_at timestamptz,
  run_id text,
  last_claim_rejection_reason text
);

create unique index if not exists agentic_factory_inbox_active_wake_key_idx
  on public.agentic_factory_inbox_workflow_wakeups(workspace_id, wake_key)
  where status in ('queued', 'leased', 'running');

create index if not exists agentic_factory_inbox_wakeups_claim_idx
  on public.agentic_factory_inbox_workflow_wakeups(workspace_id, status, created_at);

create index if not exists agentic_factory_inbox_wakeups_lease_idx
  on public.agentic_factory_inbox_workflow_wakeups(status, lease_expires_at)
  where status in ('leased', 'running');

create table if not exists public.agentic_factory_inbox_runner_credentials (
  id text primary key,
  workspace_id text not null,
  credential_id text not null unique,
  token_hash text not null,
  runner_name text not null,
  capabilities text[] not null default '{}'::text[],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists agentic_factory_inbox_runner_credentials_workspace_idx
  on public.agentic_factory_inbox_runner_credentials(workspace_id, active);

create table if not exists public.agentic_factory_inbox_runner_heartbeats (
  workspace_id text not null,
  runner_id text not null,
  version text,
  capabilities text[] not null default '{}'::text[],
  last_seen_at timestamptz not null default now(),
  current_wake_id text,
  primary key (workspace_id, runner_id)
);

create table if not exists public.agentic_factory_inbox_workflow_runs (
  run_id text primary key,
  workspace_id text not null,
  workflow_type text not null,
  wake_id text not null references public.agentic_factory_inbox_workflow_wakeups(id) on delete cascade,
  object_id text not null,
  status text not null,
  started_at timestamptz not null default now(),
  terminal_at timestamptz,
  terminal_reason text,
  artifact_pointer text,
  provider_update_ids text[] not null default '{}'::text[]
);

create table if not exists public.agentic_factory_inbox_dead_letters (
  id text primary key,
  wake_id text not null references public.agentic_factory_inbox_workflow_wakeups(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.agentic_factory_inbox_linear_webhook_secrets enable row level security;
alter table public.agentic_factory_inbox_webhook_deliveries enable row level security;
alter table public.agentic_factory_inbox_trigger_events enable row level security;
alter table public.agentic_factory_inbox_workflow_wakeups enable row level security;
alter table public.agentic_factory_inbox_runner_credentials enable row level security;
alter table public.agentic_factory_inbox_runner_heartbeats enable row level security;
alter table public.agentic_factory_inbox_workflow_runs enable row level security;
alter table public.agentic_factory_inbox_dead_letters enable row level security;

revoke all on table public.agentic_factory_inbox_linear_webhook_secrets from anon, authenticated;
revoke all on table public.agentic_factory_inbox_webhook_deliveries from anon, authenticated;
revoke all on table public.agentic_factory_inbox_trigger_events from anon, authenticated;
revoke all on table public.agentic_factory_inbox_workflow_wakeups from anon, authenticated;
revoke all on table public.agentic_factory_inbox_runner_credentials from anon, authenticated;
revoke all on table public.agentic_factory_inbox_runner_heartbeats from anon, authenticated;
revoke all on table public.agentic_factory_inbox_workflow_runs from anon, authenticated;
revoke all on table public.agentic_factory_inbox_dead_letters from anon, authenticated;

grant all on table public.agentic_factory_inbox_linear_webhook_secrets to service_role;
grant all on table public.agentic_factory_inbox_webhook_deliveries to service_role;
grant all on table public.agentic_factory_inbox_trigger_events to service_role;
grant all on table public.agentic_factory_inbox_workflow_wakeups to service_role;
grant all on table public.agentic_factory_inbox_runner_credentials to service_role;
grant all on table public.agentic_factory_inbox_runner_heartbeats to service_role;
grant all on table public.agentic_factory_inbox_workflow_runs to service_role;
grant all on table public.agentic_factory_inbox_dead_letters to service_role;
