# CLI Style Guide

This is the review checklist the Teami CLI diff is held to — not a parallel
rulebook. The single implementation owner is
[`cli-output.mjs`](execution/integrations/linear/src/cli/cli-output.mjs): all adopter
output goes through `createCliOutput()`. Do not add raw ANSI escapes or glyph logic
anywhere else — use or extend `cli-output`. The shared launcher-form helper is
`formatCommand()` in
[`operator-output.mjs`](execution/integrations/linear/src/cli/operator-output.mjs).

The target aesthetic is **a quiet dashboard, not a light show.** Restraint is competence:
one accent color, disciplined whitespace, no emoji confetti, no boxes around everything.

## Audience

- **Adopter tier** — onboarding / turn-on / troubleshooting (`init`, `gateway`, `doctor`,
  `uninstall`, `phoenix`, the `teami` home screen). High UX bar; polished hard.
- **Operator tier** — everything else (eval/self-improvement/supervisor machinery). Kept
  clean and out of the way; hidden from default help, shown under `teami help --all`.
  Don't gold-plate it.

## Status vocabulary

Four glyphs, each with an ASCII fallback. **Meaning is carried by a text label, not by
color or glyph alone** — every line must read correctly with color OFF and Unicode OFF.

| Meaning  | Glyph | ASCII | Used by |
|----------|:-----:|:-----:|---------|
| ok / pass    | `✓` | `+`            | success, doctor ok |
| warning      | `!` | `!`            | doctor warn (non-blocking) |
| failure      | `✗` | `x`            | error, doctor fail |
| running      | `●` | `[on]`/`[off]` | gateway/home status line |

The glyph set lives in `cli-output.mjs` (`UNICODE_SYMBOLS` / `ASCII_SYMBOLS`), selected by
`isUnicodeSupported()` (Windows-aware) and overridable with `--ascii`. Never hard-code a
glyph; read it from `output.symbols`.

## Color, glyphs, ASCII, non-TTY

- Color is **per-stream and TTY-gated**: ANSI only when that stream is a TTY and color is
  enabled. Honor `NO_COLOR`, `--no-color`, `--ascii`, and `TERM=dumb`. One accent (cyan)
  for next-step pointers; green/yellow/red carry ok/warn/fail.
- **Non-TTY (`| cat`, CI) output is animation- and color-free**: no spinner frames, no `\r`
  carriage-return redraws, no escape codes. Long waits emit **durable** status lines instead.
- Every new glyph ships an ASCII form and must stay legible on Windows PowerShell 5.1 /
  legacy conhost.

## Headings

One format, via `output.heading()` / the shared `agenticFactoryHeading()` helper:
`Teami · <command>`. Sub-sections use `output.section()`. No ad-hoc heading styles.

## Errors

Every error uses the `{what, why, fix}` template (`output.error({what, why, fix})`):

- **what** — one line, what went wrong.
- **why** — the cause, in plain English.
- **fix** — the exact next command. When the fix is an external (non-`teami`) command,
  gloss it in plain English, e.g. `gh auth refresh -s repo   (re-grants GitHub the 'repo' scope)`.

## Next steps

Every successful command ends by naming the next command, in the **platform-correct
launcher form** — always via `formatCommand()` (`./teami <sub>` on posix,
`.\teami.cmd <sub>` on Windows). Never hard-code `npm run …` in adopter-facing copy.

## Durations & live feedback

- **Humanize durations.** Never print machine values like `10000ms`; render the actual
  configured interval as `10s` / `every 10 seconds`. No literal hard-coded intervals.
- **Never go silent during a long wait.** Use `output.progress()`: an animated one-line
  spinner on a TTY, durable periodic status lines when piped/CI. It is interrupt-safe — it
  clears only its own line/timer/listener and never changes process exit behavior.

## `status` verbs are read-only

**Every `status` verb is side-effect-free** (a hard invariant). The adopter "is it working
right now?" surfaces — the `teami` home screen and `teami gateway status` — inspect
state only (config, domain registry, gateway-lock liveness, latest local run). They never
poll Linear, drain replay, start a decomposition, or write. Active one-pass behavior lives
behind a distinct operator path (`trigger-status`), never behind `status`.

## Plumbing conventions (rigorously conventional)

- **stdout vs stderr:** normal output and results go to stdout; errors and diagnostics go to
  stderr (`output.error(...)` writes to `errStream`). Color is decided independently per stream.
- **Exit codes:** `0` success; `2` unknown command / usage error. **`doctor`: a `✗` (fail)
  exits `1`; a `!`-only (warn) run exits `0`** — a warning never turns a passing run into a
  failing one, and setup never calls a warn-only run "green" falsely.

## Severe-action confirmation tiers

Match friction to blast radius:

- **Read-only** (`status`, `doctor`, home, help) — no prompt, ever.
- **Reversible local change** (`init`, `gateway start`) — proceed; narrate what changed.
- **Destructive / hard-to-reverse** (`uninstall`, `reset`) — explicit confirmation before
  acting; state exactly what will be removed.
- Deprecation nudges are off or once-per-process, and never emitted to a non-TTY stream.
