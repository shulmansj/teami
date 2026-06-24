alter table public.agentic_factory_inbox_setup_grants
  add column if not exists github_install_flow text;

alter table public.agentic_factory_inbox_setup_grants
  drop constraint if exists agentic_factory_inbox_setup_grants_github_install_flow_check;

alter table public.agentic_factory_inbox_setup_grants
  add constraint agentic_factory_inbox_setup_grants_github_install_flow_check
  check (
    github_install_flow is null
    or github_install_flow in ('install_app', 'authorize_existing_installation')
  );
