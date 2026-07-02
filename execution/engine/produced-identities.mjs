export const PRODUCED_IDENTITIES_TRACE_ATTRIBUTE = "teami.produced_identities";

const MAX_PRODUCED_IDENTITY_EFFECTS = 50;
const MAX_TARGET_IDS_PER_EFFECT = 5_000;
const MAX_IDENTITY_ARRAY_VALUES = 5_000;
const MAX_IDENTITY_OBJECT_KEYS = 100;
const MAX_IDENTITY_DEPTH = 4;
const MAX_STRING_LENGTH = 512;
const MAX_ARTIFACT_SET_LINEAGE_TURN_IDS = 256;
const MAX_ARTIFACT_SET_LINEAGE_SOURCE_REFS = 256;
const FORBIDDEN_IDENTITY_KEYS = new Set(["result", "trace"]);
const LINEAGE_SOURCE_REF_ID_FIELDS = Object.freeze([
  "kind",
  "id",
  "object_id",
  "objectId",
  "target_key",
  "key",
  "accepted_baseline_id",
  "snapshot_sha256",
]);

export function projectProducedIdentities({ effects = [], applied = [] } = {}) {
  try {
    if (!Array.isArray(effects) || !Array.isArray(applied)) return [];
    const effectsById = new Map(
      effects
        .filter((effect) => typeof effect?.id === "string" && effect.id.trim() !== "")
        .map((effect) => [effect.id, effect]),
    );
    const projected = [];
    for (const appliedEffect of applied.slice(0, MAX_PRODUCED_IDENTITY_EFFECTS)) {
      const effect = effectsById.get(appliedEffect?.id);
      const entry = projectProducedIdentityForEffect({ effect, appliedEffect });
      if (entry) projected.push(entry);
    }
    return jsonSafeClone(projected) || [];
  } catch {
    return [];
  }
}

export function hasProducedIdentityProjector(effect) {
  if (typeof effect?.projectProducedIdentity === "function") return true;
  return hasProducedIdentityAdapter(effect?.producedIdentity);
}

export function projectAndAttachProducedIdentities({
  trace,
  effects = [],
  applied = [],
  artifactSetLineage = null,
} = {}) {
  const producedIdentities = withArtifactSetLineage({
    producedIdentities: projectProducedIdentities({ effects, applied }),
    artifactSetLineage,
  });
  attachProducedIdentitiesToTrace({ trace, producedIdentities });
  return producedIdentities;
}

export function withArtifactSetLineage({ producedIdentities = [], artifactSetLineage = null } = {}) {
  try {
    if (!Array.isArray(producedIdentities) || producedIdentities.length === 0) return producedIdentities;
    const normalizedLineage = normalizeArtifactSetLineage(artifactSetLineage);
    if (!normalizedLineage) return producedIdentities;
    return jsonSafeClone(
      producedIdentities.map((entry) => ({
        ...entry,
        artifact_set_lineage: normalizedLineage,
      })),
    ) || producedIdentities;
  } catch {
    return Array.isArray(producedIdentities) ? producedIdentities : [];
  }
}

export function normalizeArtifactSetLineage(value) {
  try {
    if (!isPlainRecord(value)) return null;
    if (value.lineage_scope !== "artifact_set") return null;
    const producedByTurnId = normalizeLineageId(value.produced_by_turn_id);
    const commitDecisionTurnId = normalizeLineageId(value.commit_decision_turn_id);
    if (producedByTurnId === null || commitDecisionTurnId === null) return null;
    return jsonSafeClone({
      lineage_scope: "artifact_set",
      produced_by_turn_id: producedByTurnId,
      commit_decision_turn_id: commitDecisionTurnId,
      informed_by_turn_ids: normalizeLineageIdArray(
        value.informed_by_turn_ids,
        MAX_ARTIFACT_SET_LINEAGE_TURN_IDS,
      ),
      source_refs: normalizeLineageSourceRefs(
        value.source_refs,
        MAX_ARTIFACT_SET_LINEAGE_SOURCE_REFS,
      ),
    });
  } catch {
    return null;
  }
}

export function attachProducedIdentitiesToTrace({ trace, producedIdentities = [] } = {}) {
  try {
    if (!trace || typeof trace !== "object" || !Array.isArray(producedIdentities)) return [];
    const safeProjection = jsonSafeClone(producedIdentities);
    if (!Array.isArray(safeProjection) || safeProjection.length === 0) return [];
    if (!trace.attributes || typeof trace.attributes !== "object" || Array.isArray(trace.attributes)) {
      trace.attributes = {};
    }
    trace.attributes[PRODUCED_IDENTITIES_TRACE_ATTRIBUTE] = safeProjection;
    return safeProjection;
  } catch {
    return [];
  }
}

function projectProducedIdentityForEffect({ effect, appliedEffect }) {
  try {
    if (!effect || !appliedEffect) return null;
    const adapterProjection = rawAdapterProjection({ effect, appliedEffect });
    if (!adapterProjection) return null;
    return normalizeProjection({
      effect,
      resourceKind: adapterProjection.resource_kind,
      targetIds: adapterProjection.target_ids,
      identity: adapterProjection.identity,
    });
  } catch {
    return null;
  }
}

function rawAdapterProjection({ effect, appliedEffect }) {
  const identity = appliedEffect.identity;
  if (typeof effect.projectProducedIdentity === "function") {
    return effect.projectProducedIdentity(identity, { effect, appliedEffect });
  }
  const adapter = effect.producedIdentity;
  if (!hasProducedIdentityAdapter(adapter)) return null;
  const resourceKind =
    typeof adapter.resource_kind === "function"
      ? adapter.resource_kind(identity, { effect, appliedEffect })
      : adapter.resource_kind;
  return {
    resource_kind: resourceKind,
    target_ids: adapter.target_ids(identity, { effect, appliedEffect }),
    identity: adapter.identity(identity, { effect, appliedEffect }),
  };
}

function hasProducedIdentityAdapter(adapter) {
  return (
    !!adapter &&
    typeof adapter === "object" &&
    typeof adapter.target_ids === "function" &&
    typeof adapter.identity === "function"
  );
}

function normalizeProjection({ effect, resourceKind, targetIds, identity }) {
  const effectId = boundedString(effect?.id);
  const provider = boundedString(effect?.provider);
  const normalizedResourceKind = boundedString(resourceKind);
  if (!effectId || !provider || !normalizedResourceKind) return null;
  if (hasForbiddenIdentityKeys(identity)) return null;
  const normalizedIdentity = normalizeIdentityObject(identity);
  if (!normalizedIdentity) return null;
  const projection = {
    effect_id: effectId,
    provider,
    resource_kind: normalizedResourceKind,
    target_ids: normalizeStringArray(targetIds, MAX_TARGET_IDS_PER_EFFECT),
    identity: normalizedIdentity,
  };
  return jsonSafeClone(projection);
}

function normalizeIdentityObject(value) {
  if (!isPlainRecord(value)) return null;
  const normalized = normalizeMetadataValue(value, 0);
  return isPlainRecord(normalized) ? normalized : null;
}

function normalizeMetadataValue(value, depth) {
  if (value === null) return null;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_IDENTITY_ARRAY_VALUES)
      .map((entry) => normalizeMetadataValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!isPlainRecord(value) || depth >= MAX_IDENTITY_DEPTH) return undefined;
  const normalized = {};
  for (const [key, nested] of Object.entries(value).slice(0, MAX_IDENTITY_OBJECT_KEYS)) {
    if (FORBIDDEN_IDENTITY_KEYS.has(key)) return undefined;
    const normalizedNested = normalizeMetadataValue(nested, depth + 1);
    if (normalizedNested !== undefined) normalized[boundedString(key)] = normalizedNested;
  }
  return normalized;
}

function normalizeStringArray(values, limit) {
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, limit)
    .map((value) => boundedString(value))
    .filter(Boolean);
}

function normalizeLineageIdArray(values, limit) {
  if (!Array.isArray(values)) return [];
  const normalized = [];
  const seen = new Set();
  for (const value of values.slice(0, limit)) {
    const id = normalizeLineageId(value);
    if (id === null) continue;
    const key = `${typeof id}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(id);
  }
  return normalized;
}

function normalizeLineageSourceRefs(values, limit) {
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, limit)
    .map((value) => normalizeLineageSourceRef(value))
    .filter((value) => value !== null);
}

function normalizeLineageSourceRef(value) {
  const scalar = normalizeLineageId(value);
  if (scalar !== null) return scalar;
  if (!isPlainRecord(value)) return null;
  const normalized = {};
  for (const field of LINEAGE_SOURCE_REF_ID_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const id = normalizeLineageId(value[field]);
    if (id !== null) normalized[field] = id;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeLineageId(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return boundedLineageString(value);
  return null;
}

function boundedLineageString(value) {
  if (value === null || value === undefined) return null;
  const stringValue = String(value).trim();
  if (stringValue === "") return null;
  return stringValue.length > MAX_STRING_LENGTH
    ? stringValue.slice(0, MAX_STRING_LENGTH)
    : stringValue;
}

function boundedString(value) {
  if (value === null || value === undefined) return null;
  const stringValue = String(value);
  return stringValue.length > MAX_STRING_LENGTH
    ? stringValue.slice(0, MAX_STRING_LENGTH)
    : stringValue;
}

function hasForbiddenIdentityKeys(value) {
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenIdentityKeys(entry));
  if (!isPlainRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_IDENTITY_KEYS.has(key)) return true;
    if (hasForbiddenIdentityKeys(nested)) return true;
  }
  return false;
}

function jsonSafeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
