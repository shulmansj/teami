import { formatCommand } from "./operator-output.mjs";

// Doctor's rendering + verdict + exit code, as pure(ish) functions exported for unit tests so the
// warn/fail paths can be exercised without faking Linear / runtime / Phoenix / GitHub. Renders via
// output.style + output.symbols + output.raw (NOT the generic warn()/error()), so the 3-state
// layout, inline fixes, and verdict are fully controlled and degrade cleanly on a non-TTY /
// no-color / no-Unicode stream (style + symbols carry the fallbacks).

// Tolerate both normalized (S3) and legacy ({ ok }) checks.
function effectiveState(check) {
  if (check.state) return check.state;
  return check.ok === false ? "fail" : "ok";
}

// `fail` -> 1, `warn`-only (or all ok) -> 0. A warning never fails the command.
export function doctorExitCode(checks) {
  return checks.some((check) => effectiveState(check) === "fail") ? 1 : 0;
}

function compactDoctorDetail(message) {
  return String(message || "")
    .replace(/[A-Za-z]:\\[^\s;,)]+/g, "[path]")
    .replace(/(?:^|\s)\/[^\s;,)]+/g, " [path]")
    .replace(/https?:\/\/[^\s;,)]+/g, "[url]")
    .replace(/\b[0-9a-f]{12,}\b/gi, "[id]")
    .trim();
}

function headlineMessage(check) {
  if (check.showMessage) return String(check.message || "");
  if (effectiveState(check) === "ok") return "";
  return compactDoctorDetail(check.message);
}

function doctorMark(check, output) {
  const { symbols, style } = output;
  const state = effectiveState(check);
  if (state === "fail") return style.red(symbols.error);
  if (state === "warn") return style.yellow("!");
  return style.green(symbols.success);
}

// Plain-English glosses for external (non-`factory`) repair commands, appended after the command so
// the adopter understands what it does. `factory` next-steps render in the platform launcher form.
const EXTERNAL_FIX_GLOSS = new Map([
  ["gh auth refresh -s repo", "re-grants GitHub the 'repo' scope"],
]);

function renderFixText(fix) {
  // npm-run repair copy is the wrong mental model for an adopter; show the platform launcher form.
  const text = String(fix).replace(/npm run (\S+)/g, (_match, sub) => formatCommand(sub));
  const gloss = EXTERNAL_FIX_GLOSS.get(String(fix)) || EXTERNAL_FIX_GLOSS.get(text);
  return gloss ? `${text}   (${gloss})` : text;
}

// Render a single check: the state mark + name (+ message for warn/fail or showMessage), an inline
// Fix line when there's a repair, and a verbose-only echo of the full message.
export function renderDoctorCheckLine(check, output) {
  const message = headlineMessage(check);
  const label = message ? `${check.name}: ${message}` : check.name;
  output.raw(`  ${doctorMark(check, output)} ${label}\n`);
  if (check.fix && effectiveState(check) !== "ok") {
    output.raw(`      ${output.style.cyan("Fix:")}  ${renderFixText(check.fix)}\n`);
  }
  if (check.message && !check.showMessage) {
    output.detail(`${check.name}: ${check.message}`);
  }
}

function renderDoctorVerdict(checks, output) {
  const fails = checks.filter((check) => effectiveState(check) === "fail").length;
  const warns = checks.filter((check) => effectiveState(check) === "warn").length;
  const { style, symbols } = output;
  output.raw("\n");
  if (fails > 0) {
    const parts = [`${fails} problem${fails === 1 ? "" : "s"}`];
    if (warns > 0) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
    output.raw(
      `  ${style.red(`${parts.join(", ")}. Start with the ${symbols.error} above, then re-run ${formatCommand("doctor")}.`)}\n`,
    );
  } else if (warns > 0) {
    output.raw(
      `  ${style.yellow(`${warns} warning${warns === 1 ? "" : "s"}, nothing blocking — re-run ${formatCommand("doctor")} after addressing them.`)}\n`,
    );
  } else {
    output.raw(`  ${style.green("Everything looks healthy.")}\n`);
  }
}

export function renderDoctorReport(checks, output) {
  for (const check of checks) renderDoctorCheckLine(check, output);
  renderDoctorVerdict(checks, output);
}
