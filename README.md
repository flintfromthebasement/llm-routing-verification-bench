# LLM Routing & Verification Bench

A small, portable benchmark for three jobs commonly assigned to inexpensive models in agent systems:

1. **Tier routing** — choose `base`, `mid`, or `top`, plus whether factual verification is needed.
2. **Draft verification** — detect unsupported claims, fabricated references, and contradictions.
3. **Interim messages** — write a safe one- or two-sentence hold-on message while a blocked answer is regenerated.

The suite contains 23 fictional, domain-neutral cases: 15 routing cases, 5 verification cases, and 3 interim-message cases. It has no external runtime dependencies, retrieval system, memory service, agent framework, or private fixtures.

## Requirements

- Node.js 20 or newer
- An OpenAI-compatible `/chat/completions` endpoint, or OpenRouter Decisions for Jev
- An API key for that endpoint

No `npm install` is required.

## Quick start

OpenRouter:

```bash
export BENCH_API_KEY="your-key"
node bin/benchmark.mjs \
  --model provider/model-id \
  --repeats 3 \
  --concurrency 8
```

Any OpenAI-compatible provider:

```bash
export BENCH_API_KEY="your-key"
node bin/benchmark.mjs \
  --base-url https://api.example.test/v1 \
  --model provider/model-id
```

The command writes both raw JSON and a standalone HTML report under `results/`.

OpenRouter Jev automatically uses the non-streaming Decisions endpoint:

```bash
export OPENROUTER_API_KEY="your-key"
node bin/benchmark.mjs \
  --model typesafe/jev-1.13 \
  --repeats 3 \
  --concurrency 8
```

`~typesafe/jev-latest` is also recognized automatically. Jev receives structured state plus typed `Choice` and `Noul` questions, and its answers are converted to the same routing/verifier JSON consumed by the existing scorer. Verifier drafts are split into neutral sentence-level claim candidates; expected findings are used only by the scorer, never in Jev's request. The three interim-message cases require prose generation, so they are explicitly reported as skipped and excluded from Jev's eligible totals.

## Comparing models

Repeat `--model` to run models through the same interleaved batches:

```bash
node bin/benchmark.mjs \
  --model provider/model-a \
  --model provider/model-b \
  --repeats 3 \
  --concurrency 8
```

Interleaving reduces, but does not eliminate, provider-load and network-time bias.

## Cost measurement

If the API returns `usage.cost`, the report uses it. Otherwise you can supply list prices per million tokens:

```bash
node bin/benchmark.mjs \
  --model provider/model-id \
  --input-price 0.10 \
  --output-price 0.40
```

When an endpoint omits token usage, the runner estimates tokens from character count and marks the measurement as estimated in raw JSON.

## Useful commands

```bash
# Validate the dataset without making API calls
npm test
node bin/benchmark.mjs --validate-only

# Use a differently named key variable
MY_PROVIDER_KEY=... node bin/benchmark.mjs \
  --api-key-env MY_PROVIDER_KEY \
  --model provider/model-id

# Disable streaming for providers that do not support SSE
node bin/benchmark.mjs --model provider/model-id --no-stream

# Choose an output path
node bin/benchmark.mjs --model provider/model-id --out results/jev.json
```

Run `node bin/benchmark.mjs --help` for every option.

## What gets measured

- Exact structured agreement for routing tier and verification flag
- Exact regenerate/no-regenerate decision for draft verification
- Finding-level recall for known defects in verifier cases
- Constraint adherence for interim messages
- End-to-end latency, plus time to first token and output tokens/second where streaming prose is available
- Input/output tokens and cost when the provider exposes them
- Repeat-to-repeat consistency

Decisions calls are always non-streaming. Their latency, usage, cost, provider, and request ID are retained; TTFT and throughput are unavailable and appear as `—`. Reports show configured, eligible, and skipped totals per model, including per-family eligible totals.

See [RUBRIC.md](RUBRIC.md) for interpretation and known judgment calls.

## Dataset customization

The benchmark file is plain JSON at [`cases/benchmark.json`](cases/benchmark.json). Pass a modified suite with `--cases path/to/cases.json`. Keep private or customer-derived text out of public benchmark forks.

## License

MIT
