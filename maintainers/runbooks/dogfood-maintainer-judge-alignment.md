# Dogfood Maintainer Judge Alignment Runbook

This runbook is for the maintainer-owned Judge calibration loop. It proves the
fixture contribution path works end to end; it does not, by itself, prove that
the Judge improved.

Default honesty bar:

- `evidence_quality: low` for plumbing-only dogfood runs.
- A `judge_improved` claim requires at least 5 frozen GOLD labeled fixtures and
  at least 1 frozen GOLD holdout fixture in the same function/`label_source`
  stratum.
- Metrics must be reported by `label_source`.
- Any `judge_improved` claim is scoped only to strata that pass the bar:
  function plus `label_source`.

The reusable code gate is
[`judge-alignment-evidence.mjs`](../../execution/integrations/linear/src/promotion/judge-alignment-evidence.mjs).
It computes agreement, precision, recall, F1, disagreement rows, and the
`judge_improved` evidence floor.

## Inputs

Use only rows with a frozen human label:

- `expected_label` in the namespace label vocabulary.
- `provenance.label_source`.
- `provenance.label_status: GOLD`.
- `metadata.workflow_type`.
- `metadata.eval_namespace`.
- `metadata.dataset_split`.
- complete grade-time `input`.

Rows with `label_source: ambiguous` or `label_status: excluded` may appear in
audit output, but they do not count toward Judge tuning or the improvement
claim floor.

## Procedure

1. Produce dogfood runs for the target function.

   For decomposition, run the normal local workflow on disposable work and keep
   the resulting local run ids.

2. Save frozen GOLD fixture labels.

   Add a HUMAN `quality` annotation in Phoenix, then promote the run with the
   annotation id:

   ```powershell
   npm run phoenix:promote-decomposition -- <run_id> [dataset_name] --annotation-ids <annotation_id> [--split calibration|regression]
   ```

   The save step freezes `expected_label`, optional `expected_score`,
   `provenance`, and target ids. The exporter must read these fields as saved;
   it must not recompute them.

3. Export fixture rows.

   The current export job is the supervisor path. For a manual dogfood run, use
   the exporter module from a short local script or Node REPL and write the
   JSONL under `.teami/fixture-exports/`.

   Required output:

   - `fixture_dataset.jsonl`.
   - `manifest.json`.
   - one envelope per row.
   - no adopter Judge evals or settings.
   - `aggregate_signal_report.emitted: false`.

4. Review the export before upload.

   Confirm no raw credentials or private payloads are present, raw roadmap/code
   fields are digested unless explicitly opted in, and every row has
   `expected_label` plus `provenance.label_source`.

5. **LIVE PHOENIX UAT:** upload the exported fixtures to the maintainer
   Phoenix.

   Convert the JSONL rows into a Phoenix `/v1/datasets/upload` payload:

   ```json
   {
     "name": "maintainer-judge-alignment-fixtures",
     "action": "append",
     "inputs": ["<row.input>"],
     "outputs": [{ "expected_label": "<row.expected_label>" }],
     "metadata": ["<row.metadata plus provenance>"],
     "span_ids": [null]
   }
   ```

   POST it to local Phoenix:

   ```powershell
   Invoke-RestMethod -Method Post `
     -Uri "http://127.0.0.1:6006/v1/datasets/upload?sync=true" `
     -ContentType "application/json" `
     -Body (Get-Content .\payload.json -Raw)
   ```

6. Re-grade the fixture `input` with the candidate Judge.

   For each uploaded example, run the candidate Judge on the row's `input` and
   record the resulting `judge_label` as a `quality` LLM annotation tagged with
   the function metadata. Preserve annotation ids and experiment ids in the
   evidence packet.

7. Compute alignment metrics.

   Compare `judge_label == expected_label`. Also run the same disagreement
   logic used by the worklist/gate through `detectAnnotationDisagreements`
   where HUMAN/LLM/CODE annotation records are available.

   Required report fields:

   - `evidence_quality`.
   - metrics grouped by `label_source`.
   - agreement count/rate.
   - precision, recall, and F1 by expected label.
   - macro F1.
   - disagreement list with example id, expected label, and Judge label.
   - covered strata eligible for any `judge_improved` claim.
   - out-of-scope strata and missing requirements.

8. Apply the honesty gate.

   Use `evaluateJudgeImprovementClaimGate({ claim: "judge_improved", rows })`.

   If no stratum has both the frozen holdout and the minimum frozen labeled
   fixture count, the PR or report language must say:

   ```text
   evidence_quality: low
   ```

   and must not say "Judge improved." The correct claim is:

   ```text
   plumbing validated; Judge improvement not proven
   ```

   If one or more strata pass, scope the claim exactly to those strata, for
   example:

   ```text
   Judge improved claim is scoped only to decomposition/explicit_human.
   ```

## Acceptance Record

Save the run output as a maintainer review artifact with:

- export id and manifest path.
- Phoenix dataset id/version id.
- candidate Judge prompt/version id.
- experiment id or annotation ids.
- metrics by `label_source`.
- disagreement list.
- evidence gate result.
- final language classification.

For this D-runbook dogfood UAT, the expected final classification is:

```text
evidence_quality: low
plumbing validated; Judge improvement not proven
```
