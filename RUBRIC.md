# Rubric

## Headline match

Each case contributes one binary match.

### Routing

The response must parse as JSON and exactly match both expected fields:

```json
{"tier":"base|mid|top","verify":true|false}
```

The suite intentionally includes several cases near the `mid`/`top` boundary. Treat disagreements there as calibration evidence, not universal truth. If your system defines tiers differently, edit the prompt and expectations together.

### Verification

The runner derives `needs_regen` from the returned block-severity issues instead of trusting the model's own boolean. This catches internally contradictory verdicts.

A headline match means the model made the correct regenerate/no-regenerate decision. The separate finding-recall score shows whether it found every seeded defect. A verifier can therefore pass the headline while still leaving a fabricated claim in the draft.

### Interim message

The message must:

- contain one or two sentences;
- include required grounded information;
- avoid case-specific forbidden terms, invented references, and internal-review language.

Typed Decisions models such as Jev do not generate prose. Interim cases are ineligible for those models, are recorded as skipped, and do not count as failures or enter their eligible denominator.

## Detail score

The detail score is diagnostic and should not replace the headline score:

- Routing: one point for an exact tier-plus-verify match.
- Verification: one point per seeded defect found; clean cases get one point for avoiding false positives.
- Interim: points for required content, correct length, and avoiding forbidden content.

## Performance metrics

- **Latency:** request start through final response event.
- **TTFT:** request start through first non-empty output token.
- **Output throughput:** output tokens divided by time from first token through completion.
- **Sequential equivalent:** sum of individual call latencies for the first repeat. This is useful for comparing with a serial production path even when the benchmark itself runs concurrently.

Short structured outputs make tokens/second noisy. Prefer median latency and TTFT when evaluating classifier responsiveness.

OpenRouter Decisions is non-streaming, so TTFT and output throughput are unavailable for Jev. Use end-to-end latency for that adapter. Summary denominators are eligible calls per model and family; configured and skipped counts remain visible.

## Comparison discipline

For defensible comparisons:

1. Run models in the same invocation so requests are interleaved.
2. Use at least three repeats.
3. Keep provider routing and quantization settings consistent.
4. Report both accuracy and the per-family breakdown.
5. Do not hide malformed responses or provider failures.
6. Preserve raw JSON with the report.
