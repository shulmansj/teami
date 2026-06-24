-- Runner credential stored scope. Additive only: legacy credentials keep
-- webhook_ids = [] and null team/domain scope for workspace-wide behavior.

alter table public.agentic_factory_inbox_runner_credentials
  add column if not exists team_id text,
  add column if not exists webhook_ids jsonb not null default '[]'::jsonb,
  add column if not exists domain_id text;
