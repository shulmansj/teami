import assert from "node:assert/strict";
import test from "node:test";

import {
  signBrokerCredential,
  verifyBrokerCredential,
} from "../src/broker-credential.mjs";

test("broker credential signs and verifies the installation-bound payload", () => {
  const key = "shared-broker-credential-key";
  const payload = {
    v: 1,
    workspaceId: "workspace-1",
    teamId: "team-1",
    installationId: "installation-1",
    owner: "acme",
    repo: "behavior",
    exp: 2_000,
  };

  const token = signBrokerCredential({ key, payload });
  const parts = token.split(".");

  assert.equal(parts.length, 3);
  assert.equal(parts[0], "af_broker_v1");
  assert.equal(base64UrlDecode(parts[1]).toString("utf8"), JSON.stringify(payload));
  assert.deepEqual(verifyBrokerCredential({ key, token, nowSeconds: 1_000 }), payload);
});

test("broker credential verification rejects tampering, expiry, and wrong keys", () => {
  const key = "shared-broker-credential-key";
  const payload = {
    v: 1,
    workspaceId: "workspace-1",
    teamId: "team-1",
    installationId: "installation-1",
    owner: "acme",
    repo: "behavior",
    exp: 2_000,
  };
  const token = signBrokerCredential({ key, payload });
  const parts = token.split(".");
  const tamperedSegment = replaceLastBase64UrlChar(parts[1]);
  const tamperedSig = replaceLastBase64UrlChar(parts[2]);
  const expired = signBrokerCredential({ key, payload: { ...payload, exp: 999 } });

  assert.equal(
    verifyBrokerCredential({ key, token: `${parts[0]}.${tamperedSegment}.${parts[2]}`, nowSeconds: 1_000 }),
    null,
  );
  assert.equal(
    verifyBrokerCredential({ key, token: `${parts[0]}.${parts[1]}.${tamperedSig}`, nowSeconds: 1_000 }),
    null,
  );
  assert.equal(verifyBrokerCredential({ key, token: expired, nowSeconds: 1_000 }), null);
  assert.equal(verifyBrokerCredential({ key: "wrong-key", token, nowSeconds: 1_000 }), null);
});

test("broker credential verification rejects legacy payloads without installationId", () => {
  const key = "shared-broker-credential-key";
  const legacyToken = signBrokerCredential({
    key,
    payload: {
      v: 1,
      workspaceId: "workspace-1",
      teamId: "team-1",
      owner: "acme",
      repo: "behavior",
      exp: 2_000,
    },
  });

  assert.equal(verifyBrokerCredential({ key, token: legacyToken, nowSeconds: 1_000 }), null);
});

function replaceLastBase64UrlChar(value) {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}
