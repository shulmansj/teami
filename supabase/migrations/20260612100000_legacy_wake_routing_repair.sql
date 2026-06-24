-- Legacy wake routing repair.
--
-- 20260611120000_domain_identity backfilled pre-existing wakeups with
-- webhook_ids = '[]'::jsonb (no webhook identity was captured before that
-- migration). Domain-scoped runner claims filter on webhook_ids containment
-- (withWebhookIdsFilter / wakeMatchesWebhookFilter in the inbox function and
-- inbox-store.mjs), so a queued legacy wake is INVISIBLE to a domain-scoped
-- runner -- silently skipped, not failed -- which reads as false idleness and
-- can strand real decomposition work.
--
-- This migration makes every such wake either claimable (recovering the webhook
-- id from its linked trigger event where the domain-identity backfill captured a
-- real one) or terminally dead-lettered with a clear reason instead of silently
-- stranded. A dead-lettered legacy wake is NOT lost intent: the intent still
-- lives in the Linear project (invariant 6), so re-saving that project in Linear
-- regenerates a fresh wake carrying full routing identity.
--
-- Idempotent: touches only queued wakes that still carry an empty webhook_ids
-- array, so a re-run is a no-op once recovery/dead-letter has happened. Ordering:
-- requires 20260611120000_domain_identity (the webhook_id / webhook_ids columns).
-- Independent of the 20260612090001 raw_payload scrub -- recovery reads the
-- derived trigger_events.webhook_id column, never raw_payload -- so it is safe to
-- apply before or after the scrub.

-- 1. Recover webhook_ids from the linked trigger event where the domain-identity
--    backfill captured a real (non-empty) webhook id. A legacy wake mapped to a
--    single webhook, so a single-element array matches the claim filter exactly.
update public.agentic_factory_inbox_workflow_wakeups w
set webhook_ids = jsonb_build_array(e.webhook_id)
from public.agentic_factory_inbox_trigger_events e
where w.source_event_id = e.id
  and w.status = 'queued'
  and w.webhook_ids = '[]'::jsonb
  and e.webhook_id is not null
  and e.webhook_id <> '';

-- 2. Dead-letter any still-unidentified queued legacy wake. These carry no
--    recoverable routing identity, so requeue could never make them claimable by
--    a domain-scoped runner, and a routing_error row would hold the active
--    wake-key slot and block clean regeneration. dead_letter is terminal (frees
--    the slot) and visible; the repair is to re-save the source project in Linear,
--    which generates a fresh wake with full identity. The reason is migration-origin.
update public.agentic_factory_inbox_workflow_wakeups
set status = 'dead_letter',
    reason = 'legacy_wake_missing_routing_identity',
    terminal_at = now()
where status = 'queued'
  and webhook_ids = '[]'::jsonb;
