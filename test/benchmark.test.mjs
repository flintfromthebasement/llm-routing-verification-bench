import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMessages } from "../lib/prompts.mjs";
import { scoreCase } from "../lib/scoring.mjs";

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
