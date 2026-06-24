-- Audit and throttle steady-state GitHub broker credential re-mints per setup grant.

alter table public.agentic_factory_inbox_setup_grants
  add column if not exists github_broker_remint_count integer not null default 0,
  add column if not exists github_broker_remint_window_started_at timestamptz;
