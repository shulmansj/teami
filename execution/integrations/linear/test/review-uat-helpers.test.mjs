import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_REVIEW_UAT_PREFIX,
  DEFAULT_REVIEW_UAT_REQUIRED_PRS,
  buildReviewUatUsage,
  parseReviewUatArgs,
} from "../uat/review-uat.mjs";

test("parseReviewUatArgs mirrors the live UAT env/flag shape", () => {
  const options = parseReviewUatArgs([
    "--repo-root",
    "C:/Users/example/bound-checkout",
    "--domain",
    "domain-1",
    "--resource-id",
    "repo-resource-1",
    "--prefix",
    "AF-EXEC-UAT",
    "--issue-id",
    "issue-1",
    "--issue-id",
    "issue-2",
    "--required-prs",
    "2",
    "--poll-interval-ms",
    "250",
    "--timeout-ms",
    "5000",
    "--expected-repo-name",
    "custom-repo",
    "--keep-artifacts",
  ], {});

  assert.equal(options.repoRoot, path.resolve("C:/Users/example/bound-checkout"));
  assert.equal(options.domainId, "domain-1");
  assert.equal(options.resourceId, "repo-resource-1");
  assert.equal(options.prefix, "AF-EXEC-UAT");
  assert.deepEqual(options.issueIds, ["issue-1", "issue-2"]);
  assert.equal(options.requiredPrs, 2);
  assert.equal(options.pollIntervalMs, 250);
  assert.equal(options.timeoutMs, 5000);
  assert.equal(options.expectedRepoName, "custom-repo");
  assert.equal(options.keepArtifacts, true);
});

test("parseReviewUatArgs supports shared env defaults and comma-separated issue ids", () => {
  const options = parseReviewUatArgs([], {
    TEAMI_UAT_REPO_ROOT: "C:/Users/example/shared-root",
    TEAMI_REVIEW_UAT_DOMAIN: "domain-env",
    TEAMI_REVIEW_UAT_ISSUE_IDS: "issue-a, issue-b",
    TEAMI_REVIEW_UAT_KEEP_ARTIFACTS: "yes",
  });

  assert.equal(options.repoRoot, path.resolve("C:/Users/example/shared-root"));
  assert.equal(options.domainId, "domain-env");
  assert.deepEqual(options.issueIds, ["issue-a", "issue-b"]);
  assert.equal(options.keepArtifacts, true);
  assert.equal(options.prefix, DEFAULT_REVIEW_UAT_PREFIX);
  assert.equal(options.requiredPrs, DEFAULT_REVIEW_UAT_REQUIRED_PRS);
});

test("parseReviewUatArgs validates child crash mode", () => {
  assert.throws(
    () => parseReviewUatArgs(["--child-crash", "after_review_comment_before_status"], {}),
    /--issue-id is required exactly once/,
  );

  assert.throws(
    () => parseReviewUatArgs([
      "--child-crash",
      "unknown",
      "--issue-id",
      "issue-1",
    ], {}),
    /unknown review crash scenario/,
  );

  const options = parseReviewUatArgs([
    "--child-crash",
    "after_review_comment_before_status",
    "--issue-id",
    "issue-1",
    "--disposition",
    "request-changes",
  ], {});
  assert.equal(options.childCrash, "after_review_comment_before_status");
  assert.deepEqual(options.issueIds, ["issue-1"]);
  assert.equal(options.childDisposition, "request-changes");
});

test("review UAT usage documents live prerequisites and the scripted-disposition choice", () => {
  const usage = buildReviewUatUsage();
  assert.match(usage, /uat:execution/);
  assert.match(usage, /path-to-your-bound-checkout/);
  assert.match(usage, /bound to your domain's git_repo resource/);
  assert.match(usage, /scripted by the harness/);
});
