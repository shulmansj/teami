# Team Context Contract (Superseded)

Status: superseded
Current product path: no
Superseded by: `execution/integrations/linear/README.md` and current team source/tests
Date superseded: 2026-07-11

The former Phase 1 contract described webhook and remote-runner fields from a
retired architecture. It is not current guidance and must not be used to infer
a hosted trigger, remote credential, or setup path.

Current team behavior is implemented and tested in:

- `execution/integrations/linear/src/team-registry.mjs`
- `execution/integrations/linear/src/team-resolver.mjs`
- `execution/integrations/linear/src/team-command-context.mjs`
- `execution/integrations/linear/test/team-registry.test.mjs`
- `execution/integrations/linear/test/team-resolver.test.mjs`

The current product uses a local team registry, local Linear credential
targets, explicit product-repo resources, team-confined mutations, and a
foreground polling gateway. See the Linear integration owner doc linked above.
