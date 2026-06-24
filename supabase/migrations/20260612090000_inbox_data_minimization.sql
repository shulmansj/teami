-- Data minimization, step 1 of 2 (additive): the hosted inbox stores no
-- product content. Webhook bodies are verified and normalized in memory;
-- only a body hash, an allowlisted header subset, and derived routing facts
-- are persisted.
--
-- This migration is compatible with BOTH function versions: the old function
-- keeps writing raw_body/raw_payload (columns remain), and the new function
-- writes raw_body_sha256/project_status_type (columns now exist). Rollout:
-- apply this, deploy the minimized function, then apply the step-2 scrub
-- migration (20260612090001) to remove previously stored content.

alter table public.agentic_factory_inbox_webhook_deliveries
  alter column raw_body drop not null,
  add column if not exists raw_body_sha256 text;

alter table public.agentic_factory_inbox_trigger_events
  add column if not exists project_status_type text;
