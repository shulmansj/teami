import { createHmac } from "node:crypto";

const BROKER_CREDENTIAL_PREFIX = "af_broker_v1";

export function signBrokerCredential({ key, payload }) {
  assertSigningKey(key);
  const segment = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = hmacBrokerCredentialSegment({ key, segment });
  return `${BROKER_CREDENTIAL_PREFIX}.${segment}.${sig}`;
}

export function verifyBrokerCredential({
  key,
  token,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  assertSigningKey(key);
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts[0] !== BROKER_CREDENTIAL_PREFIX) return null;
    const segment = parts[1];
    const sig = parts[2];
    const expectedSig = hmacBrokerCredentialSegment({ key, segment });
    if (!constantTimeEqual(sig, expectedSig)) return null;
    const payload = brokerCredentialPayloadFromUnknown(
      JSON.parse(base64UrlDecode(segment).toString("utf8")),
    );
    if (!payload) return null;
    if (payload.exp <= nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

function hmacBrokerCredentialSegment({ key, segment }) {
  return base64UrlEncode(
    createHmac("sha256", Buffer.from(key, "utf8"))
      .update(segment, "utf8")
      .digest(),
  );
}

function brokerCredentialPayloadFromUnknown(value) {
  if (!value || typeof value !== "object") return null;
  if (value.v !== 1) return null;
  if (!isNonEmptyString(value.workspaceId)) return null;
  if (!isNonEmptyString(value.teamId)) return null;
  if (!isNonEmptyString(value.installationId)) return null;
  if (!isNonEmptyString(value.owner)) return null;
  if (!isNonEmptyString(value.repo)) return null;
  if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) return null;
  return {
    v: 1,
    workspaceId: value.workspaceId,
    teamId: value.teamId,
    installationId: value.installationId,
    owner: value.owner,
    repo: value.repo,
    exp: value.exp,
  };
}

function assertSigningKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("broker_credential_signing_key_required");
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}
