-- Bind GitHub App installations to setup grants through a server-generated state nonce.

alter table public.agentic_factory_inbox_setup_grants
  add column if not exists github_installation_id text,
  add column if not exists github_owner text,
  add column if not exists github_repo text,
  add column if not exists github_repo_verified_at timestamptz,
  add column if not exists github_install_state_hash text,
  add column if not exists github_install_state_expires_at timestamptz,
  add column if not exists github_installation_bound_at timestamptz;

create index if not exists agentic_factory_inbox_setup_grants_github_install_state_hash_idx
  on public.agentic_factory_inbox_setup_grants(github_install_state_hash)
  where github_install_state_hash is not null;
