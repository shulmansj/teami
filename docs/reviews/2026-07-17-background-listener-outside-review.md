# Background Listener Outside Review

Date: 2026-07-17

## Review Run

- Reviewer: Claude Fable 5 (`fable` alias), Extra effort (`xhigh`)
- Command contract: helper equivalent of `claude -p --model fable --effort xhigh --no-session-persistence --system-prompt <text-only reviewer prompt> --safe-mode --strict-mcp-config --disable-slash-commands --tools=`
- Ambient Claude configuration: disabled
- Packet size: 80,822 bytes
- Review size: 11,385 bytes
- User permission: covered by the standing authorization in the outside-review skill
- Scope: persistent listener lifecycle, CLI and MCP controls, init closeout, tests, and adopter/agent contracts

The reviewer found two high-severity implementation blockers, two verification blockers, six medium findings, and several low-risk edge cases. Codex agreed with the blockers and reconciled the review before release.

## Findings And Dispositions

| Finding | Disposition | Resolution |
| --- | --- | --- |
| Parent wrote the only background ownership record, so a parent crash could strand an unmanageable detached child | Objective fix | The listener child now writes its own PID/acquisition/control metadata before announcing readiness. The parent verifies that managed background state instead of creating it. |
| Tests bypassed the production CLI dispatch and flag path | Objective fix | Added a real Windows CLI test using the no-checkout GraphQL harness. It launches the real `cli.mjs`, verifies the detached process remains alive, and stops it later. This test exposed and led to fixing a missing process-lifetime anchor. |
| Windows lifecycle and atomic replacement were not explicitly verified | Objective fix | Ran the real detached lifecycle repeatedly on Windows, wait for actual process exit after lock release, and added bounded retry for Windows file replacement and test-cleanup sharing failures. |
| Full-suite result was inconclusive | Objective fix | Split all 221 tracked test files into four isolated-home chunks with bounded concurrency. Final result: 2,193 passing tests and 2 expected skips. |
| Stop could time out while the gateway slept or finished active work | Objective fix | Gateway sleep is now abort-aware. A long in-flight operation returns truthful `stopping` state and finishes safely before exit. |
| Failed-start cleanup killed a raw PID | Objective fix | Cleanup uses the spawned child handle and skips children already exited or signal-terminated. |
| Control token appeared in child argv | Objective fix | The correlation token now travels through the child environment, never CLI arguments or user-facing results. A regression test pins this. It is treated as an ownership/correlation guard, not a cross-user authentication boundary. |
| `--background --team` silently widened scope | Objective fix | Background mode rejects Team selectors and max-iteration combinations with a product-readable error; it always watches all active Teams. |
| Init inferred start success from absence of an exception | Objective fix | Init now inspects the returned lifecycle result and reports a failed background start accurately. |
| Concurrent starts were not idempotent | Objective fix | A short-lived exclusive start lock makes simultaneous callers converge on one listener; a real concurrent-start test pins this. |
| Orphan control files and Windows replace windows | Objective fix | Start and successful/already-complete stop sweep stale request files; atomic replacement retries bounded Windows sharing failures. |
| Old/terminal-owned lock guidance was too narrow | Objective fix | Stop never kills an unowned process and now explains both terminal Ctrl-C and the one-time sign-out/restart recovery for an older incomplete background launch. |
| MCP payload and annotation inconsistencies | Objective fix | Status derives from the combined lock view, mutating idempotent start no longer claims read-only, and stop annotations now describe a local state-changing action consistently. |
| Copy promised survival until only stop/reboot | Objective fix | Public copy now truthfully includes sign-out and process failure while still denying OS-startup registration. |
| No detached-child log | Deferred | The listener lock and status remain truthful, while always-on stdout logging would create noisy, potentially sensitive unbounded local logs. Add bounded diagnostic logging only with an explicit retention/redaction contract. |
| PID reuse can make a stale lock look live | Deferred, pre-existing | Stop remains fail-closed and never signals a lock PID. A stronger cross-platform process birth identity can replace the existing PID-liveness contract later. |
| Default-yes init prompt | Retained product decision | The adopter explicitly asked init to turn the listener on or offer to do so. The visible `[Y/n]` prompt preserves a human choice while favoring a working first run. |
| Listener start failure makes interactive init exit nonzero | Retained technical/product tension | The setup data is preserved and the output says setup completed, but a user-approved requested action failed. A nonzero exit keeps scripts and users from mistaking that request for success. |
| Init printed stopped guidance before asking to start | Objective fix | The offer now runs before final first-run rendering; accepted starts render `Teami is listening`, while declined/non-interactive paths render stopped guidance. Manual start/status/stop controls remain visible. |
| Agents may offer listener start every session | Retained product decision | This is the adopter's explicit requested interactive-session behavior. Agents read status first and ask before mutation; planning guidance only offers when stopped. |
| `already_running` hid foreground/background mode | Objective fix | CLI start now names the existing mode and gives Ctrl-C guidance for terminal-owned foreground mode. |

## Verification

- `npm run quality:static`: pass
- Focused listener/onboarding/docs suite: 73 pass, 0 fail
- Real Windows detached lifecycle: start through production CLI, survive starter, report background mode, stop later: pass
- Repeated real Windows lifecycle cleanup run (3 consecutive runs): pass
- Concurrent start convergence and foreground stop refusal: pass
- All 221 tracked test files in four isolated-home chunks: 2,193 pass, 2 expected skips, 0 fail
- `git diff --check`: pass

## Remaining Decisions

No unresolved product decision blocks this change. Deferred diagnostic logging and stronger process-birth identity are hardening work, not gaps in the shipped start/status/stop promise.
