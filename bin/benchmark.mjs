#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildDecisionRequest, buildMessages } from "../lib/prompts.mjs";
import { scoreCase } from "../lib/scoring.mjs";
import { callDecisions, callModel, isDecisionsModel } from "../lib/client.mjs";
import { summarize, writeReports } from "../lib/report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function help() {
  console.log(`Portable LLM routing and verification benchmark

Usage:
  BENCH_API_KEY=... node bin/benchmark.mjs --model provider/model-id

Options:
  --model ID             Model ID. Repeat to compare multiple models.
  --base-url URL         OpenAI-compatible API root (default: OpenRouter).
  --api-key-env NAME     Environment variable containing the key (default: BENCH_API_KEY).
  --cases FILE           Benchmark JSON (default: cases/benchmark.json).
  --repeats N            Repetitions per case/model (default: 1).
  --concurrency N        Concurrent requests (default: 4).
  --timeout-ms N         Per-request timeout (default: 60000).
  --input-price N        Optional input price per million tokens.
  --output-price N       Optional output price per million tokens.
  --out PATH             Output JSON path (HTML uses the same basename).
  --no-stream            Disable chat streaming; TTFT will be unavailable. Decisions never stream.
  --validate-only        Validate the dataset without API calls.
  --help                 Show this help.

Environment shortcuts:
  BENCH_MODEL, BENCH_BASE_URL, BENCH_API_KEY, OPENROUTER_API_KEY
`);
}

function parseArgs(argv) {
  const args = {
    models: [],
    baseUrl: process.env.BENCH_BASE_URL || "https://openrouter.ai/api/v1",
    apiKeyEnv: "BENCH_API_KEY",
    casesPath: path.join(ROOT, "cases/benchmark.json"),
    repeats: 1,
    concurrency: 4,
    timeoutMs: 60_000,
    stream: true,
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--model") args.models.push(argv[++index]);
    else if (arg === "--base-url") args.baseUrl = argv[++index];
    else if (arg === "--api-key-env") args.apiKeyEnv = argv[++index];
    else if (arg === "--cases") args.casesPath = path.resolve(argv[++index]);
    else if (arg === "--repeats") args.repeats = Number(argv[++index]);
    else if (arg === "--concurrency") args.concurrency = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--input-price") args.inputPrice = Number(argv[++index]);
    else if (arg === "--output-price") args.outputPrice = Number(argv[++index]);
    else if (arg === "--out") args.out = path.resolve(argv[++index]);
    else if (arg === "--no-stream") args.stream = false;
    else if (arg === "--validate-only") args.validateOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.models.length && process.env.BENCH_MODEL) args.models.push(...process.env.BENCH_MODEL.split(",").map((value) => value.trim()).filter(Boolean));
  return args;
}

function validateDataset(benchmark) {
  if (!benchmark || !Array.isArray(benchmark.cases)) throw new Error("Dataset must contain a cases array.");
  const ids = new Set();
  const families = { route: 0, verify: 0, interim: 0 };
  for (const testCase of benchmark.cases) {
    if (!testCase.id || ids.has(testCase.id)) throw new Error(`Missing or duplicate case id: ${testCase.id}`);
    ids.add(testCase.id);
    if (!(testCase.family in families)) throw new Error(`Unknown family for ${testCase.id}: ${testCase.family}`);
    families[testCase.family]++;
    buildMessages(testCase, new Date("2026-01-01T00:00:00.000Z"));
  }
  return families;
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index]); }
      catch (error) { results[index] = { ...items[index], error: String(error?.message || error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  const benchmark = JSON.parse(fs.readFileSync(args.casesPath, "utf8"));
  const families = validateDataset(benchmark);
  if (args.validateOnly) {
    console.log(`Valid: ${benchmark.cases.length} cases (${families.route} route, ${families.verify} verify, ${families.interim} interim).`);
    return;
  }
  if (!args.models.length) throw new Error("At least one --model or BENCH_MODEL is required.");
  if (!Number.isInteger(args.repeats) || args.repeats < 1) throw new Error("--repeats must be a positive integer.");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be a positive integer.");
  const apiKey = process.env[args.apiKeyEnv] || (args.apiKeyEnv === "BENCH_API_KEY" ? process.env.OPENROUTER_API_KEY : "");
  if (!apiKey) throw new Error(`Set ${args.apiKeyEnv} before running the benchmark.`);

  const runs = [];
  for (let repeat = 1; repeat <= args.repeats; repeat++) {
    const jobs = benchmark.cases.flatMap((testCase, caseIndex) => args.models.map((model, modelIndex) => ({
      model, testCase, caseId: testCase.id, family: testCase.family, caseIndex, modelIndex, repeat,
    }))).sort((left, right) => ((left.caseIndex * 7 + left.modelIndex + repeat) % 13) - ((right.caseIndex * 7 + right.modelIndex + repeat) % 13));
    const started = performance.now();
    const rows = await pool(jobs, args.concurrency, async (job) => {
      if (isDecisionsModel(job.model) && job.family === "interim") {
        return { ...job, testCase: undefined, skipped: true, skipReason: "Typed Decisions models do not generate interim prose.", adapter: "decisions" };
      }
      const common = { apiKey, model: job.model, inputPrice: args.inputPrice, outputPrice: args.outputPrice, timeoutMs: args.timeoutMs };
      const response = isDecisionsModel(job.model)
        ? await callDecisions({ ...common, decisionRequest: buildDecisionRequest(job.testCase, benchmark.cases) })
        : await callModel({ ...common, baseUrl: args.baseUrl, ...buildMessages(job.testCase), stream: args.stream });
      return { ...job, testCase: undefined, ...response, score: scoreCase(job.testCase, response.response) };
    });
    runs.push(...rows);
    console.error(`repeat ${repeat}/${args.repeats}: ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }

  const summaries = args.models.map((model) => summarize(model, runs, benchmark.cases));
  const generatedAt = new Date().toISOString();
  const result = {
    benchmark: { name: benchmark.name, version: benchmark.version },
    generatedAt,
    baseUrl: args.baseUrl,
    models: args.models,
    repeats: args.repeats,
    concurrency: args.concurrency,
    stream: args.stream,
    transports: Object.fromEntries(args.models.map((model) => [model, isDecisionsModel(model) ? "decisions" : "chat-completions"])),
    cases: benchmark.cases,
    summaries,
    runs,
  };
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = args.out || path.join(ROOT, "results", `benchmark-${stamp}.json`);
  const extension = path.extname(jsonPath);
  const htmlPath = `${jsonPath.slice(0, extension ? -extension.length : undefined)}.html`;
  writeReports({ result, jsonPath, htmlPath });
  console.log(JSON.stringify({ summaries, jsonPath, htmlPath }, null, 2));
  if (runs.some((run) => run.error)) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
