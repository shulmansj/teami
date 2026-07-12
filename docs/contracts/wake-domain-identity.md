# Wake Domain Identity Contract (Superseded)

Status: superseded
Current product path: no
Superseded by: `execution/integrations/linear/README.md` and local trigger source/tests
Date superseded: 2026-07-11

The former contract described remote webhook delivery and hosted wake storage.
That architecture was removed. This file is a tombstone, not a current design
or a roadmap to restore it.

The supported product uses Linear as the live queue and a foreground local
gateway. Current behavior is implemented and tested in:

- `execution/integrations/linear/src/gateway-loop.mjs`
- `execution/integrations/linear/src/local-trigger-store.mjs`
- `execution/integrations/linear/src/trigger-idempotency.mjs`
- `execution/integrations/linear/src/trigger-runner.mjs`
- `execution/integrations/linear/test/gateway-loop.test.mjs`
- `execution/integrations/linear/test/local-trigger-store.test.mjs`

When the gateway is stopped or the machine is off, Teami performs no work and
makes no external change. The next local poll re-reads Linear and reconciles
eligible work.
