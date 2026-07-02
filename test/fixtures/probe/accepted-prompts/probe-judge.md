# Accepted Probe Judge Prompt

```yaml
prompt_version: probe-accepted-v1
phoenix_prompt_role: probe_judge
target_key: prompt/probe/probe_judge
rubric_version: probe-rubric-v1
failure_taxonomy_version: probe-taxonomy-v1
```

Assess a completed synthetic probe run. Judge whether the run produced the
declared probe artifact, preserved the probe resource identity, and returned a
settled outcome observation.

Return JSON with `label`, `score`, `explanation`, and `failure_modes`.
