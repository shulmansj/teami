# Behavioral Knob Ownership

This marker closes the W5 knob rule for guardrails: adopter-tunable behavior
must be a Phoenix accepted asset; the guardrails below are factory-owned and
must not gain adopter config paths. Loop-level injection used by tests or
fixtures is not adopter configuration.

| Knob | Ownership | Adopter config path | Notes |
| --- | --- | --- | --- |
| Phoenix prompt/persona assets | Phoenix accepted asset | No direct config path | The accepted manifest and snapshots are the source of truth for adopter-tunable prompt behavior. |
| Phoenix accepted runtime defaults | Phoenix accepted asset | W5-1 closes or marks development-only config divergence | Runtime/model behavior belongs in accepted assets. |
| `DEFAULT_ORCHESTRATOR_MAX_ROUNDS` (`bounds.max_rounds`, default `1000`) | Factory-owned guardrail | None | `runOrchestratorLoop({ maxRounds })` remains a test/fixture injection seam for bounds-breach coverage, not an adopter config override. |
| `DEFAULT_RUNTIME_TIMEOUT_MS` (default `10 * 60 * 1000`) | Factory-owned guardrail | None | Default runtime command timeout; callers may inject a process timeout for harnessing, but adopters do not tune it through config. |
| `REPAIR_RETRY_TIMEOUT_MS` (default `2 * 60 * 1000`) | Factory-owned guardrail | None | Short timeout for the deterministic repair retry. |
| `DEFAULT_MAX_RUNTIME_OUTPUT_BYTES` (default `1024 * 1024`) | Factory-owned guardrail | None | Runtime stdout/stderr cap. |
| Repair retry count (`1`) | Factory-owned guardrail | None | The loop allows one deterministic repair retry for malformed subagent turns and one for malformed orchestrator turns, then fails closed. |
