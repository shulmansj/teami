// The runtime role the orchestrator itself runs on.
export const ORCHESTRATOR_RUNTIME_ROLE = "orchestrator";

export const ORCHESTRATOR_GOVERNING_TARGET_KEY =
  "prompt/decomposition/orchestrator_governing";

// The invoke_library handler (Seam 1 join of the roster resolver + the run
// recorder). Given a VALIDATED invoke_library control action, the I-1 roster,
// and the run recorder, it:
//   1. resolves the target via roster.resolve(target_key),
//   2. loads the FULL snapshot ONCE via loadSnapshot(),
//   3. records the library load on the recorder (recordLibraryLoad) so the run
//      ledger captures the consumed accepted-version (capture-at-load),
//   4. records the resolved runtime_role as executed,
//   5. returns { ok, runtime_role, body, snapshot } for the loop (I-2b) to spawn
//      the subagent in the contained environment.
// A rejected resolution returns { ok: false, reason } and records nothing.
//
// The handler loads the snapshot EXACTLY ONCE and threads the same object to the
// recorder, so the body (snapshot.contentBytes) and the captured ref come from a
// single load (no double I/O, no version skew between body and ref).
export function handleInvokeLibrary({ controlAction, roster, recorder } = {}) {
  if (!controlAction || controlAction.action !== "invoke_library") {
    return { ok: false, reason: "invoke_library_handler_wrong_action" };
  }
  const targetKey = controlAction.target_key;
  const resolved = roster?.resolve?.(targetKey);
  if (!resolved || resolved.ok !== true) {
    return { ok: false, reason: resolved?.reason ?? "invoke_library_resolve_failed" };
  }

  const snapshot = resolved.loadSnapshot();
  recorder?.recordLibraryLoad?.({ target_key: targetKey, snapshot });
  recorder?.recordExecutedRuntimeRole?.(resolved.runtime_role);

  return {
    ok: true,
    target_key: targetKey,
    runtime_role: resolved.runtime_role,
    body: snapshot?.contentBytes ?? null,
    snapshot,
  };
}
