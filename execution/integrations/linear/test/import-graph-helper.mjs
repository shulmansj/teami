import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function extractImportSpecifiers(source) {
  const specifiers = [];
  for (let index = 0; index < source.length;) {
    if (startsLineComment(source, index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (startsBlockComment(source, index)) {
      index = skipBlockComment(source, index);
      continue;
    }
    if (isStringDelimiter(source[index])) {
      index = skipString(source, index);
      continue;
    }
    if (isKeywordAt(source, index, "import")) {
      index = readImportSpecifier(source, index, specifiers);
      continue;
    }
    if (isKeywordAt(source, index, "export")) {
      index = readExportSpecifier(source, index, specifiers);
      continue;
    }
    index += 1;
  }
  return specifiers;
}

export function readImportSpecifier(source, index, specifiers) {
  let cursor = skipWhitespace(source, index + "import".length);
  if (source[cursor] === ".") return cursor + 1;

  if (source[cursor] === "(") {
    cursor = skipWhitespace(source, cursor + 1);
    const parsed = readQuotedString(source, cursor);
    if (parsed) {
      specifiers.push(importSpecifier("dynamic", parsed.value, source, parsed.valueIndex));
      return parsed.endIndex;
    }
    return cursor;
  }

  const sideEffect = readQuotedString(source, cursor);
  if (sideEffect) {
    specifiers.push(importSpecifier("static", sideEffect.value, source, sideEffect.valueIndex));
    return sideEffect.endIndex;
  }

  const from = readFromSpecifier(source, cursor);
  if (from) {
    specifiers.push(importSpecifier("static", from.value, source, from.valueIndex));
    return from.endIndex;
  }

  return cursor;
}

export function readExportSpecifier(source, index, specifiers) {
  const cursor = skipWhitespace(source, index + "export".length);
  if (source[cursor] !== "{" && source[cursor] !== "*") return cursor;

  const from = readFromSpecifier(source, cursor);
  if (from) {
    specifiers.push(importSpecifier("static", from.value, source, from.valueIndex));
    return from.endIndex;
  }

  return cursor;
}

export function readFromSpecifier(source, index) {
  let depth = 0;
  for (let cursor = index; cursor < source.length;) {
    if (startsLineComment(source, cursor)) {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (startsBlockComment(source, cursor)) {
      cursor = skipBlockComment(source, cursor);
      continue;
    }
    if (isStringDelimiter(source[cursor])) {
      cursor = skipString(source, cursor);
      continue;
    }
    if (source[cursor] === ";" && depth === 0) return null;
    if ("{[(".includes(source[cursor])) depth += 1;
    if ("}])".includes(source[cursor])) depth = Math.max(0, depth - 1);
    if (isKeywordAt(source, cursor, "from")) {
      const valueStart = skipWhitespace(source, cursor + "from".length);
      const parsed = readQuotedString(source, valueStart);
      if (parsed) return parsed;
    }
    cursor += 1;
  }
  return null;
}

export function importSpecifier(kind, specifier, source, valueIndex) {
  return {
    kind,
    specifier,
    line: lineNumberAt(source, valueIndex),
  };
}

export function resolveLocalSpecifier({ specifier, modulePath }) {
  if (specifier.startsWith("file:")) {
    try {
      const url = new URL(specifier);
      url.hash = "";
      url.search = "";
      return path.resolve(fileURLToPath(url));
    } catch {
      return null;
    }
  }
  if (!isRelativeOrAbsoluteSpecifier(specifier)) return null;
  return path.resolve(
    path.dirname(modulePath),
    stripSpecifierSuffix(specifier).replace(/[\\/]+/g, path.sep),
  );
}

export function isBareModuleSpecifier(specifier) {
  return (
    !isRelativeOrAbsoluteSpecifier(specifier) &&
    !specifier.startsWith("node:") &&
    !specifier.startsWith("file:") &&
    !/^[a-z][a-z\d+.-]*:/i.test(specifier)
  );
}

export function isRelativeOrAbsoluteSpecifier(specifier) {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\")
  );
}

export function stripSpecifierSuffix(specifier) {
  const suffixIndexes = ["?", "#"]
    .map((marker) => specifier.indexOf(marker))
    .filter((index) => index >= 0);
  if (suffixIndexes.length === 0) return specifier;
  return specifier.slice(0, Math.min(...suffixIndexes));
}

export function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isBuiltinSpecifier(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return builtinModules.includes(bare) || builtinModules.includes(bare.split("/")[0]);
}

export function readQuotedString(source, index) {
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;

  let value = "";
  for (let cursor = index + 1; cursor < source.length;) {
    if (source[cursor] === "\\") {
      value += source.slice(cursor, cursor + 2);
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) {
      return { value, valueIndex: index + 1, endIndex: cursor + 1 };
    }
    value += source[cursor];
    cursor += 1;
  }
  return null;
}

export function skipWhitespace(source, index) {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  return cursor;
}

export function startsLineComment(source, index) {
  return source[index] === "/" && source[index + 1] === "/";
}

export function skipLineComment(source, index) {
  let cursor = index + 2;
  while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") {
    cursor += 1;
  }
  return cursor;
}

export function startsBlockComment(source, index) {
  return source[index] === "/" && source[index + 1] === "*";
}

export function skipBlockComment(source, index) {
  let cursor = index + 2;
  while (cursor < source.length && !(source[cursor] === "*" && source[cursor + 1] === "/")) {
    cursor += 1;
  }
  return Math.min(cursor + 2, source.length);
}

export function isStringDelimiter(value) {
  return value === '"' || value === "'" || value === "`";
}

export function skipString(source, index) {
  const quote = source[index];
  for (let cursor = index + 1; cursor < source.length;) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

export function isKeywordAt(source, index, keyword) {
  return (
    source.startsWith(keyword, index) &&
    !isIdentifierCharacter(source[index - 1]) &&
    !isIdentifierCharacter(source[index + keyword.length])
  );
}

export function isIdentifierCharacter(value) {
  return typeof value === "string" && /^[A-Za-z0-9_$]$/.test(value);
}

export function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r\n|\r|\n/).length;
}
