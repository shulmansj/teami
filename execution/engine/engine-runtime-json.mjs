export function extractRuntimeJsonCandidates(output) {
  return runtimePacketCandidates(output)
    .map((candidate) => unwrapRuntimePacketCandidate(candidate))
    .filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
}

function runtimePacketCandidates(output) {
  if (typeof output !== "string") return [output];
  try {
    return [JSON.parse(output)];
  } catch {
    return extractJsonObjects(output);
  }
}

function unwrapRuntimePacketCandidate(candidate) {
  if (candidate?.structured_output) return candidate.structured_output;
  if (typeof candidate?.result === "string") return parseRuntimeResultText(candidate.result);
  return candidate;
}

function parseRuntimeResultText(result) {
  const trimmed = result.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function extractJsonObjects(text) {
  const objects = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = findJsonObjectEnd(text, start);
    if (end < 0) continue;
    try {
      objects.push(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // Keep scanning; runtime logs may include brace-like text before the packet.
    }
  }
  return objects;
}

function findJsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
