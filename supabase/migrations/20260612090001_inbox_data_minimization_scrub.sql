-- Data minimization, step 2 of 2 (scrub): remove product content stored
-- before minimization. Scoped to pre-minimization rows only (no
-- raw_body_sha256): rows written by the minimized function keep their
-- allowlisted header subset and are never touched. Idempotent and safe to
-- re-run at any point in the rollout, including after the minimized function
-- is deployed -- a re-run cleans any rows the previous function wrote during
-- the deploy window (see supabase/README.md rollout ordering note). The
-- raw_body / raw_payload columns are kept nullable for rollback room; a later
-- cleanup migration can drop them once the minimized function has been stable
-- in production.

update public.agentic_factory_inbox_webhook_deliveries
set raw_body = null,
    raw_headers = '{}'::jsonb
where raw_body_sha256 is null
  and (raw_body is not null or raw_headers <> '{}'::jsonb);

-- Backfill the derived routing fact from the legacy payload before nulling
-- it, mirroring projectStatusTypeFromPayload / normalizeProjectStatusType in
-- the inbox function, so historical trigger events keep routing correctly
-- after raw_payload is gone. The candidate fallback chains mirror JS `||`
-- truthiness: JSON null, false, 0, and "" all fall through to the next
-- candidate (SQL coalesce would not), and a truthy-but-unusable candidate
-- (e.g. a non-allowlisted string) stops the chain exactly like the TS code.
update public.agentic_factory_inbox_trigger_events t
set project_status_type = coalesce(t.project_status_type, d.derived),
    raw_payload = null
from (
  select id,
         case
           when lower(btrim(txt, E' \t\n\r')) in
             ('planned', 'backlog', 'started', 'completed', 'canceled', 'cancelled')
             then lower(btrim(txt, E' \t\n\r'))
           else null
         end as derived
  from (
    select id,
           case
             when jsonb_typeof(cand) = 'string' then cand #>> '{}'
             when jsonb_typeof(obj_value) = 'string' then obj_value #>> '{}'
             else null
           end as txt
    from (
      select id,
             cand,
             case
               when jsonb_typeof(cand) = 'object' then
                 case
                   when (cand -> 'type') is not null
                        and (cand -> 'type') not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
                     then cand -> 'type'
                   when (cand -> 'name') is not null
                        and (cand -> 'name') not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
                     then cand -> 'name'
                   else null
                 end
               else null
             end as obj_value
      from (
        select id,
               case
                 when (raw_payload -> 'data' -> 'status') is not null
                      and (raw_payload -> 'data' -> 'status') not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
                   then raw_payload -> 'data' -> 'status'
                 when (raw_payload -> 'data' -> 'projectStatus') is not null
                      and (raw_payload -> 'data' -> 'projectStatus') not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
                   then raw_payload -> 'data' -> 'projectStatus'
                 when (raw_payload -> 'data' -> 'workflowStatus') is not null
                      and (raw_payload -> 'data' -> 'workflowStatus') not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
                   then raw_payload -> 'data' -> 'workflowStatus'
                 when (raw_payload -> 'data' -> 'state') is not null
                      and (raw_payload -> 'data' -> 'state') not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
                   then raw_payload -> 'data' -> 'state'
                 else null
               end as cand
        from public.agentic_factory_inbox_trigger_events
        where raw_payload is not null
      ) s0
    ) s1
  ) s2
) d
where t.id = d.id
  and t.raw_payload is not null;
