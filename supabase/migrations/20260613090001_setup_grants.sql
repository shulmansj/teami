-- Team-scoped setup grants and deferred first-delivery confirmation.

create table if not exists public.agentic_factory_inbox_setup_grants (
  id text primary key,
  grant_id text not null unique,
  secret_hash text not null,
  workspace_id text not null,
  team_id text not null,
  domain_id text,
  webhook_id text,
  status text not null check (status in ('provisional', 'confirmed', 'revoked', 'expired', 'superseded')),
  scopes text[] not null default '{}'::text[],
  uses_remaining integer not null default 8,
  expires_at timestamptz not null,
  confirmation_expires_at timestamptz not null,
  confirmed_at timestamptz,
  confirmation_delivery_id text,
  created_at timestamptz not null default now(),
  created_by text not null default 'anonymous_init',
  revoked_at timestamptz,
  revoked_reason text,
  last_used_at timestamptz
);

create index if not exists agentic_factory_inbox_setup_grants_workspace_team_status_idx
  on public.agentic_factory_inbox_setup_grants(workspace_id, team_id, status);

create unique index if not exists agentic_factory_inbox_setup_grants_one_active_team_idx
  on public.agentic_factory_inbox_setup_grants(workspace_id, team_id)
  where status in ('provisional', 'confirmed');

alter table public.agentic_factory_inbox_linear_webhook_secrets
  add column if not exists setup_grant_id text,
  add column if not exists team_id text,
  add column if not exists confirmation_state text not null default 'confirmed';

do $$
begin
  alter table public.agentic_factory_inbox_linear_webhook_secrets
    add constraint agentic_factory_inbox_linear_webhook_secrets_confirmation_state_check
    check (confirmation_state in ('provisional', 'confirmed'));
exception
  when duplicate_object then null;
end $$;

alter table public.agentic_factory_inbox_setup_grants enable row level security;

revoke all on table public.agentic_factory_inbox_setup_grants from anon, authenticated;

grant all on table public.agentic_factory_inbox_setup_grants to service_role;
