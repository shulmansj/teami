import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRemediationMarker,
  remediationFailureSignature,
  renderRemediationMarker,
} from "../src/remediation-marker.mjs";

test("remediation marker round-trips and ignores absent or garbled blocks", () => {
  const marker = {
    v: 1,
    kind: "readiness_repair",
    resource_id: "repo-1",
    failure_signature: "sha256:abc123",
  };

  assert.deepEqual(parseRemediationMarker(renderRemediationMarker(marker)), marker);
  assert.equal(parseRemediationMarker("plain issue body"), null);
  assert.equal(parseRemediationMarker("```af-remediation\nnot-json\n```\n"), null);
  assert.equal(parseRemediationMarker("```af-remediation\n{\"v\":2}\n```\n"), null);
});

test("remediation failure signature is normalized to reason codes and missing tools", () => {
  const first = remediationFailureSignature({
    reason_codes: ["no_runnable_test_command", "deps_install_failed"],
    missing: ["package.json:scripts.test", "npm install"],
    stderr: "first raw stderr order",
  });
  const second = remediationFailureSignature({
    reason_codes: ["deps_install_failed", "no_runnable_test_command"],
    missing: ["npm install", "package.json:scripts.test"],
    stderr: "different raw stderr order",
  });

  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});
