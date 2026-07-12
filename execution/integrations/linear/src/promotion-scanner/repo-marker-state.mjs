import {
  createGitHubPromotionClient,
} from "../github-promotion-client.mjs";
import { createProductionGitHubPromotionTransport } from "../github-production-transport.mjs";
import { resolveBehaviorRepoIdentity } from "../github-setup.mjs";
import { resolveTeamiHome } from "../app-home.mjs";
import { readPromotionMarker } from "../promote-candidate.mjs";
import { controllerNamespacePr } from "../promotion-workspace.mjs";

export async function deriveScannerRepoMarkerState({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  policy,
  githubTransport = null,
  now = () => new Date(),
} = {}) {
  if (policy.disabled) {
    return {
      ok: true,
      controller_calls_allowed: false,
      reason: "promotion_disabled_by_policy",
      detail: "promotion-policy.json disabled=true",
      counts: null,
      source: "promotion_policy",
    };
  }
  if (policy.scanner_routing?.enabled === false) {
    return {
      ok: true,
      controller_calls_allowed: false,
      reason: "scanner_routing_disabled_by_policy",
      detail: "promotion-policy.json scanner_routing.enabled=false",
      counts: null,
      source: "promotion_policy",
    };
  }

  const identity = resolveBehaviorRepoIdentity({ repoRoot, home });
  if (!identity.ok) {
    return {
      ok: false,
      controller_calls_allowed: false,
      reason: identity.reason,
      detail: "scanner budget/cap truth requires a verified behavior repo identity from resolveBehaviorRepoIdentity(); placeholder repos are not used by the scanner.",
      counts: null,
      source: "github_connection_state",
    };
  }

  let transport;
  try {
    transport = githubTransport
      || createProductionGitHubPromotionTransport({ repoRoot, repoIdentity: identity, now }).transport;
  } catch (error) {
    return {
      ok: false,
      controller_calls_allowed: false,
      reason: "github_transport_unavailable",
      detail: error.message,
      counts: null,
      repo: identity.repo,
      source: "repo_visible_pr_markers",
    };
  }
  const github = createGitHubPromotionClient({ transport, repo: identity.repo });
  let openPrs;
  let closedPrs;
  try {
    openPrs = (await github.listOpenPullRequests())?.data || [];
    closedPrs = (await github.listClosedPullRequests())?.data || [];
  } catch (error) {
    const normalizedGitHubError = String(error.message || "").toLowerCase().replace(/\s+/g, "_");
    return {
      ok: false,
      controller_calls_allowed: false,
      reason: /github_pr_listing_truncated|pr_listing_truncated/.test(normalizedGitHubError)
        ? "github_pr_listing_truncated"
        : "github_pr_listing_failed",
      detail: error.message,
      counts: null,
      repo: identity.repo,
      source: "repo_visible_pr_markers",
    };
  }
  const markerStates = (prs) => prs.map((pr) => ({ pr, read: readPromotionMarker(pr?.body) }));
  const openStates = markerStates(openPrs);
  const closedStates = markerStates(closedPrs);
  const unreadable = [...openStates, ...closedStates].filter(
    ({ pr, read }) => read.status !== "ok" && controllerNamespacePr(pr),
  );
  if (unreadable.length > 0) {
    return {
      ok: false,
      controller_calls_allowed: false,
      reason: "promotion_marker_unreadable",
      detail: unreadable.map(({ pr, read }) => `#${pr.number}:${read.status}${read.reason ? `:${read.reason}` : ""}`).join(","),
      counts: null,
      repo: identity.repo,
      source: "repo_visible_pr_markers",
    };
  }
  const withMarkers = (states) =>
    states
      .filter(({ pr, read }) => read.status === "ok" && controllerNamespacePr(pr))
      .map(({ pr, read }) => ({ pr, marker: read.marker }));
  const openMarkers = withMarkers(openStates);
  const closedMarkers = withMarkers(closedStates);
  const activeOpen = openMarkers.filter((entry) => entry.marker.proposal_state !== "superseded");
  const closedUnmerged = closedMarkers.filter((entry) =>
    !entry.pr.merged_at
    && !["superseded", "blocked"].includes(entry.marker.proposal_state));
  const nowMs = now().getTime();
  const periodMs = policy.proposal_budget.period_days * 24 * 60 * 60 * 1000;
  const recentProposals = [...openMarkers, ...closedMarkers].filter(
    (entry) => entry.pr.created_at && nowMs - new Date(entry.pr.created_at).getTime() <= periodMs,
  );
  const counts = {
    open_prs_seen: openPrs.length,
    closed_prs_seen: closedPrs.length,
    readable_open_markers: openMarkers.length,
    readable_closed_markers: closedMarkers.length,
    closed_unmerged_proposals: closedUnmerged.length,
    active_open_proposals: activeOpen.length,
    recent_proposals_in_budget_window: recentProposals.length,
    max_open_proposals: policy.max_open_proposals,
    proposal_budget_max: policy.proposal_budget.max_proposals,
    proposal_budget_period_days: policy.proposal_budget.period_days,
  };
  if (activeOpen.length >= policy.max_open_proposals) {
    return {
      ok: true,
      controller_calls_allowed: false,
      reason: "max_open_proposals_reached",
      detail: `${activeOpen.length} active open proposal marker(s) >= max_open_proposals ${policy.max_open_proposals}`,
      counts,
      repo: identity.repo,
      connection_mode: identity.connection_mode,
      source: "repo_visible_pr_markers",
    };
  }
  if (recentProposals.length >= policy.proposal_budget.max_proposals) {
    return {
      ok: true,
      controller_calls_allowed: false,
      reason: "proposal_budget_exhausted",
      detail: `${recentProposals.length} proposal marker(s) inside ${policy.proposal_budget.period_days} day(s) >= budget ${policy.proposal_budget.max_proposals}`,
      counts,
      repo: identity.repo,
      connection_mode: identity.connection_mode,
      source: "repo_visible_pr_markers",
    };
  }
  return {
    ok: true,
    controller_calls_allowed: true,
    reason: null,
    detail: null,
    counts,
    repo: identity.repo,
    connection_mode: identity.connection_mode,
    source: "repo_visible_pr_markers",
  };
}
