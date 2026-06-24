const ANSI_CODES = Object.freeze({
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
});

// Glyphs that render cleanly on capable terminals (macOS, Windows Terminal,
// VS Code, iTerm, modern Linux) vs an ASCII-safe set for legacy Windows
// consoles (conhost / older PowerShell with fonts like Consolas) where the
// fancy glyphs would show as boxes or tofu. Same layout in both modes.
const UNICODE_SYMBOLS = Object.freeze({
  step: "▸",
  success: "✓",
  error: "✗",
  warn: "⚠",
  arrow: "→",
  separator: "·",
  ellipsis: "…",
});
// Strictly ASCII (no code-page or font dependency) so it renders on any console,
// including the oldest Windows conhost. Color (green/red/yellow) still carries the
// semantics on a TTY; these markers are the no-color/legacy cue.
const ASCII_SYMBOLS = Object.freeze({
  step: ">",
  success: "+",
  error: "x",
  warn: "!",
  arrow: "->",
  separator: "-",
  ellipsis: "...",
});

// Mirror of the well-worn `is-unicode-supported` heuristic (kept dependency-free):
// the fancy glyphs are only assumed safe on Windows when a known-good terminal is
// detected; every other Windows console falls back to ASCII so a non-technical
// adopter never sees boxes. macOS/Linux render the glyphs (except the bare Linux
// kernel console, TERM=linux).
function isUnicodeSupported() {
  if (process.platform !== "win32") {
    return process.env.TERM !== "linux";
  }
  return Boolean(process.env.WT_SESSION) // Windows Terminal
    || Boolean(process.env.TERMINUS_SUBLIME) // Terminus
    || process.env.ConEmuTask === "{cmd::Cmder}" // ConEmu / cmder
    || process.env.TERM_PROGRAM === "vscode" // VS Code integrated terminal
    || process.env.TERM === "xterm-256color" // e.g. Git Bash / MSYS2
    || process.env.TERM === "alacritty"
    || process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}

function unicodeEnabled({ unicode }) {
  if (unicode !== undefined) return unicode === true;
  return isUnicodeSupported();
}

// Tri-state, decided per stream: color === false force-disables (--no-color / NO_COLOR),
// color === true is an explicit force-ON escape hatch (FORCE_COLOR-style — the caller has
// opted in even for a non-TTY target), and undefined auto-detects from that stream's TTY.
// Because it is evaluated per stream, ANSI never lands on a non-TTY stream unless color was
// explicitly forced.
function colorEnabled({ color, stream }) {
  if (color !== undefined) return color === true;
  return stream?.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

function createStyler(enabled, ...codes) {
  return (text) => {
    const value = String(text);
    if (!enabled) return value;
    return `${codes.join("")}${value}${ANSI_CODES.reset}`;
  };
}

function splitLines(text) {
  return String(text).split(/\r?\n/);
}

function createCliOutput({
  verbose = false,
  color,
  unicode,
  stream = process.stdout,
  errStream = process.stderr,
} = {}) {
  // Color is decided per target stream: stdout may be a TTY while stderr is
  // redirected (or vice versa), and ANSI must never leak onto a non-TTY stream.
  const useColor = colorEnabled({ color, stream });
  const useErrColor = colorEnabled({ color, stream: errStream });
  const useUnicode = unicodeEnabled({ unicode });
  const symbols = useUnicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS;

  const green = createStyler(useColor, ANSI_CODES.green);
  const red = createStyler(useColor, ANSI_CODES.red);
  const yellow = createStyler(useColor, ANSI_CODES.yellow);
  const cyan = createStyler(useColor, ANSI_CODES.cyan);
  const bold = createStyler(useColor, ANSI_CODES.bold);
  const dim = createStyler(useColor, ANSI_CODES.dim);
  const boldCyan = createStyler(useColor, ANSI_CODES.bold, ANSI_CODES.cyan);
  const errRed = createStyler(useErrColor, ANSI_CODES.red);
  const errCyan = createStyler(useErrColor, ANSI_CODES.cyan);

  const writeLine = (target, line = "") => {
    target.write(`${line}\n`);
  };
  const writeBody = (target, text, decorate = (value) => value) => {
    for (const line of splitLines(text)) writeLine(target, `  ${decorate(line)}`);
  };

  const output = {
    color: useColor,
    unicode: useUnicode,
    verbose: Boolean(verbose),
    symbols,
    style: Object.freeze({
      green,
      red,
      yellow,
      cyan,
      bold,
      dim,
    }),
    step(current, total, title) {
      writeLine(stream);
      writeLine(stream, boldCyan(`${symbols.step} Step ${current}/${total}  ${title}`));
    },
    success(text) {
      writeBody(stream, text, (line) => green(`${symbols.success} ${line}`));
    },
    info(text) {
      writeBody(stream, text);
    },
    detail(text) {
      if (!verbose) return;
      writeBody(stream, text, dim);
    },
    warn(text) {
      writeBody(stream, text, (line) => yellow(`${symbols.warn} ${line}`));
    },
    error({ what, why = null, fix = null } = {}) {
      writeLine(errStream, errRed(`${symbols.error} ${what || "Error"}`));
      if (why) writeBody(errStream, why);
      if (fix) writeBody(errStream, `${errCyan(`${symbols.arrow} Fix: `)}${fix}`);
    },
    heading(text) {
      writeLine(stream);
      writeLine(stream, bold(text));
    },
    section(title) {
      writeLine(stream);
      writeLine(stream, `  ${bold(title)}`);
    },
    keyValues(pairs = [], { heading = null } = {}) {
      const normalized = pairs
        .filter((pair) => Array.isArray(pair))
        .map(([label, value]) => ({
          label: String(label),
          value: value == null ? "" : String(value),
        }))
        .filter((pair) => pair.label.length > 0);
      if (normalized.length === 0) return;
      if (heading) {
        writeLine(stream);
        writeLine(stream, `  ${bold(heading)}`);
      }
      const labelWidth = normalized.reduce((width, item) => Math.max(width, item.label.length), 0);
      for (const item of normalized) {
        const label = `${item.label}:`.padEnd(labelWidth + 1);
        writeLine(stream, `  ${dim(label)}  ${item.value}`);
      }
    },
    nextSteps(items = []) {
      output.heading("Next steps");
      const normalized = items.map(normalizeNextStep);
      const labelWidth = normalized.reduce((width, item) =>
        item.hint ? Math.max(width, item.text.length) : width, 0);
      for (const item of normalized) {
        const text = item.hint
          ? `${item.text.padEnd(labelWidth)}  ${item.hint}`
          : item.text;
        writeLine(stream, `  ${cyan(symbols.arrow)} ${text}`);
      }
    },
    done(text) {
      writeLine(stream);
      writeLine(stream, green(`${symbols.success} ${text}`));
    },
    raw(text) {
      stream.write(String(text));
    },
  };

  return output;
}

function normalizeNextStep(item) {
  if (Array.isArray(item)) {
    const [text, hint] = item;
    return { text: String(text), hint: hint == null ? null : String(hint) };
  }
  if (item && typeof item === "object") {
    return {
      text: String(item.text ?? item.label ?? ""),
      hint: item.hint == null ? null : String(item.hint),
    };
  }
  return { text: String(item), hint: null };
}

export {
  createCliOutput,
  isUnicodeSupported,
};
