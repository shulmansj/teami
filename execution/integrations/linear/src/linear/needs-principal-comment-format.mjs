export function needsPrincipalThesisLine(subject = "issue") {
  const normalizedSubject = nonEmptyString(subject) || "issue";
  return `Teami blocked this ${normalizedSubject} because it needs a human decision before automated work continues.`;
}

export function needsPrincipalCodeMarker(value) {
  const normalizedValue = nonEmptyString(value);
  if (!normalizedValue) throw new Error("needs-principal marker value is required.");
  return `(code: \`${normalizedValue}\`)`;
}

function nonEmptyString(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}
