import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDecisionRequest, buildMessages, extractClaimCandidates } from "../lib/prompts.mjs";
import { scoreCase } from "../lib/scoring.mjs";
import { callDecisions, isDecisionsModel } from "../lib/client.mjs";
import { renderHtml, summarize } from "../lib/report.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchmark = JSON.parse(fs.readFileSync(path.join(root, "cases/benchmark.json"), "utf8"));

test("dataset has the intended family balance and unique IDs", () => {
  assert.equal(benchmark.cases.length, 23);
  assert.deepEqual(
    Object.fromEntries(["route", "verify", "interim"].map((family) => [family, benchmark.cases.filter((item) => item.family === family).length])),
    { route: 15, verify: 5, interim: 3 },
  );
  assert.equal(new Set(benchmark.cases.map((item) => item.id)).size, 23);
});

test("every case builds a valid request", () => {
  for (const testCase of benchmark.cases) {
    const request = buildMessages(testCase, new Date("2026-01-01T00:00:00.000Z"));
    assert.ok(request.messages.length >= 1, testCase.id);
    assert.ok(request.maxTokens > 0, testCase.id);
  }
});

test("Jev model aliases select Decisions while normal models remain chat models", () => {
  assert.equal(isDecisionsModel("typesafe/jev-1.13"), true);
  assert.equal(isDecisionsModel("~typesafe/jev-latest"), true);
  assert.equal(isDecisionsModel("typesafe/not-jev"), false);
  assert.equal(isDecisionsModel("provider/model-id"), false);
});

test("route Decisions request uses structured state, Choice, Noul, and representative examples", () => {
  const testCase = benchmark.cases.find((item) => item.id === "route-inactive-price");
  const request = buildDecisionRequest(testCase, benchmark.cases);
  assert.equal(request.state.input.latest_user_message, testCase.message);
  assert.equal(request.questions.tier.type, "choice");
  assert.deepEqual(Object.keys(request.questions.tier.criteria), ["base", "mid", "top"]);
  assert.equal(request.questions.verify.type, "noul");
  assert.deepEqual(new Set(request.state.labeled_examples.map((item) => item.label.tier)), new Set(["base", "mid", "top"]));
  assert.equal(request.state.labeled_examples.some((item) => item.input === testCase.message), false);
});

test("verifier Decisions request has a headline and neutral claim-candidate Nouls", () => {
  const testCase = benchmark.cases.find((item) => item.id === "verify-fabricated-links");
  const request = buildDecisionRequest(testCase, benchmark.cases);
  assert.deepEqual(Object.keys(request.questions), ["needs_regen", "claim_1", "claim_2"]);
  assert.ok(Object.values(request.questions).every((question) => question.type === "noul"));
  assert.deepEqual(request.claimCandidates, extractClaimCandidates(testCase.draft));
  assert.doesNotMatch(JSON.stringify(request.questions), /seeded defect/i);
  const poisoned = buildDecisionRequest({ ...testCase, requiredFindings: [["label-only-marker"]] }, benchmark.cases);
  assert.doesNotMatch(JSON.stringify(poisoned), /label-only-marker/i);
  assert.equal(request.state.user, testCase.userText);
  assert.equal(request.state.draft, testCase.draft);
  assert.ok(request.state.strict_evidence_rules);
  assert.equal(request.state.labeled_examples.some((item) => item.draft === testCase.draft), false);
  assert.equal(buildDecisionRequest(benchmark.cases.find((item) => item.family === "interim"), benchmark.cases), null);
});

test("Decisions adapter posts the alpha request and synthesizes scorer-compatible JSON", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const testCase = benchmark.cases.find((item) => item.id === "verify-fabricated-links");
  const decisionRequest = buildDecisionRequest(testCase, benchmark.cases);
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      model: "typesafe/jev-1.13",
      answers: {
        needs_regen: { type: "noul", noul: 0.9 },
        claim_1: { type: "noul", noul: 0.8 },
        claim_2: { type: "noul", noul: 0.7 },
      },
      usage: { input_tokens: 100, output_tokens: 12, cost: 0.0000042 },
      id: "decision-1",
      provider: "TypeSafe",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const result = await callDecisions({ apiKey: "test", model: "typesafe/jev-1.13", decisionRequest });
  assert.equal(captured.url, "https://openrouter.ai/api/alpha/decisions");
  assert.deepEqual(Object.keys(captured.body).sort(), ["model", "questions", "state"]);
  assert.equal(captured.body.model, "typesafe/jev-1.13");
  assert.equal(result.adapter, "decisions");
  assert.equal(result.firstTokenMs, null);
  assert.equal(result.outputTokensPerSecond, null);
  assert.equal(result.cost, 0.0000042);
  assert.equal(result.provider, "TypeSafe");
  assert.equal(result.generationId, "decision-1");
  const score = scoreCase(testCase, result.response);
  assert.equal(score.match, true);
  assert.equal(score.findingHits, 3);
});

test("summaries use eligible totals and reports display skips", () => {
  const cases = benchmark.cases.slice(0, 2).concat(benchmark.cases.filter((item) => item.family === "interim").slice(0, 1));
  const runs = [
    { model: "typesafe/jev-1.13", repeat: 1, family: "route", caseId: cases[0].id, elapsedMs: 10, score: { match: true, detailScore: 1, detailTotal: 1 } },
    { model: "typesafe/jev-1.13", repeat: 1, family: "route", caseId: cases[1].id, elapsedMs: 20, score: { match: false, detailScore: 0, detailTotal: 1 } },
    { model: "typesafe/jev-1.13", repeat: 1, family: "interim", caseId: cases[2].id, skipped: true, skipReason: "Typed Decisions models do not generate interim prose." },
  ];
  const summary = summarize("typesafe/jev-1.13", runs, cases);
  assert.equal(summary.total, 2);
  assert.equal(summary.configuredTotal, 3);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.families.interim.total, 0);
  assert.equal(summary.families.interim.skipped, 1);
  const html = renderHtml({ benchmark: { name: "test" }, generatedAt: "now", cases, models: [summary.model], repeats: 1, summaries: [summary], runs });
  assert.match(html, /1\/2 eligible/);
  assert.match(html, /skipped/);
  assert.doesNotMatch(html, /OpenAI-compatible chat completions/);
});

test("provider errors remain in eligible score denominators", () => {
  const cases = benchmark.cases.slice(0, 2);
  const runs = [
    { model: "provider/model", repeat: 1, family: "route", caseId: cases[0].id, elapsedMs: 10, score: { match: true, detailScore: 1, detailTotal: 1 } },
    { model: "provider/model", repeat: 1, family: "route", caseId: cases[1].id, error: "503" },
  ];
  const summary = summarize("provider/model", runs, cases);
  assert.equal(summary.matches, 1);
  assert.equal(summary.total, 2);
  assert.equal(summary.families.route.total, 2);
  assert.equal(summary.failures, 1);
});

test("route scoring requires both fields", () => {
  const testCase = benchmark.cases.find((item) => item.id === "route-event-lookup");
  assert.equal(scoreCase(testCase, '{"tier":"mid","verify":true,"reason":"lookup"}').match, true);
  assert.equal(scoreCase(testCase, '{"tier":"mid","verify":false,"reason":"lookup"}').match, false);
});

test("verifier derives regeneration from block issues", () => {
  const testCase = benchmark.cases.find((item) => item.id === "verify-fabricated-links");
  const raw = JSON.stringify({
    claims_checked: 1,
    issues: [{ severity: "block", description: "coupon-codes-v2 is not in evidence" }],
    needs_regen: false,
  });
  const score = scoreCase(testCase, raw);
  assert.equal(score.match, true);
  assert.equal(score.needsRegen, true);
});

test("interim scoring rejects process-ID leakage", () => {
  const testCase = benchmark.cases.find((item) => item.id === "interim-process-id");
  assert.equal(scoreCase(testCase, "I'm checking the right approach before continuing.").match, true);
  assert.equal(scoreCase(testCase, "I'm double-checking the PID before continuing.").match, false);
});

test("public files contain no private fixture markers", () => {
  const forbidden = [
    new RegExp(["paid", "memberships", "pro"].join(" "), "i"),
    new RegExp(["pm", "pro"].join(""), "i"),
    new RegExp(["stranger", "studios"].join(" "), "i"),
    new RegExp(["auto", "mem"].join(""), "i"),
  ];
  const files = [
    "README.md", "RUBRIC.md", "cases/benchmark.json",
    "lib/prompts.mjs", "lib/scoring.mjs", "lib/client.mjs", "lib/report.mjs",
    "bin/benchmark.mjs",
  ];
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${file} contains ${pattern}`);
  }
});
