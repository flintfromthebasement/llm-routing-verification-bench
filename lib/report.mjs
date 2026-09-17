import fs from "node:fs";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarize(model, runs, cases) {
  const valid = runs.filter((run) => run.model === model && !run.error);
  const first = valid.filter((run) => run.repeat === 1);
  const families = Object.fromEntries(["route", "verify", "interim"].map((family) => {
    const rows = first.filter((run) => run.family === family);
    return [family, { matches: rows.filter((run) => run.score.match).length, total: rows.length }];
  }));
  const costs = first.map((run) => run.cost).filter(Number.isFinite);
  return {
    model,
    matches: first.filter((run) => run.score.match).length,
    total: cases.length,
    detailScore: first.reduce((sum, run) => sum + run.score.detailScore, 0),
    detailTotal: first.reduce((sum, run) => sum + run.score.detailTotal, 0),
    families,
    repeatMatches: [...new Set(valid.map((run) => run.repeat))].sort().map((repeat) => ({
      repeat,
      matches: valid.filter((run) => run.repeat === repeat && run.score.match).length,
      total: valid.filter((run) => run.repeat === repeat).length,
    })),
    inputTokens: first.reduce((sum, run) => sum + (run.inputTokens || 0), 0),
    outputTokens: first.reduce((sum, run) => sum + (run.outputTokens || 0), 0),
    cost: costs.length === first.length ? costs.reduce((sum, value) => sum + value, 0) : null,
    sequentialEquivalentSeconds: first.reduce((sum, run) => sum + run.elapsedMs, 0) / 1000,
    medianLatencyMs: median(valid.map((run) => run.elapsedMs)),
    p95LatencyMs: percentile(valid.map((run) => run.elapsedMs), 0.95),
    medianFirstTokenMs: median(valid.map((run) => run.firstTokenMs)),
    p95FirstTokenMs: percentile(valid.map((run) => run.firstTokenMs), 0.95),
    medianOutputTokensPerSecond: median(valid.map((run) => run.outputTokensPerSecond)),
    providers: [...new Set(valid.map((run) => run.provider).filter(Boolean))],
    failures: runs.filter((run) => run.model === model && run.error).length,
  };
}

function metric(value, suffix = "", digits = 0) {
  return Number.isFinite(value) ? `${Number(value).toFixed(digits)}${suffix}` : "—";
}

export function renderHtml(result) {
  const cards = result.summaries.map((summary) => `<section class="card">
    <h2>${esc(summary.model)}</h2>
    <div class="score">${summary.matches}/${summary.total}</div>
    <div class="sub">detail rubric ${summary.detailScore}/${summary.detailTotal}</div>
    <dl>
      <dt>Routing</dt><dd>${summary.families.route.matches}/${summary.families.route.total}</dd>
      <dt>Verification</dt><dd>${summary.families.verify.matches}/${summary.families.verify.total}</dd>
      <dt>Interim</dt><dd>${summary.families.interim.matches}/${summary.families.interim.total}</dd>
      <dt>Median latency</dt><dd>${metric(summary.medianLatencyMs, "ms")}</dd>
      <dt>Median TTFT</dt><dd>${metric(summary.medianFirstTokenMs, "ms")}</dd>
      <dt>Median throughput</dt><dd>${metric(summary.medianOutputTokensPerSecond, " tok/s")}</dd>
      <dt>23-call sequential equivalent</dt><dd>${metric(summary.sequentialEquivalentSeconds, "s", 1)}</dd>
      <dt>Cost</dt><dd>${summary.cost === null ? "—" : `$${summary.cost.toFixed(6)}`}</dd>
    </dl>
    <div class="sub">Repeats: ${summary.repeatMatches.map((row) => `${row.matches}/${row.total}`).join(" · ")}</div>
  </section>`).join("\n");

  const rows = result.cases.map((testCase) => {
    const cells = result.models.map((model) => {
      const run = result.runs.find((candidate) => candidate.repeat === 1 && candidate.model === model && candidate.caseId === testCase.id);
      if (!run || run.error) return `<td class="miss">error</td>`;
      const detail = testCase.family === "route"
        ? `${run.score.parsed?.tier ?? "?"}/${String(run.score.parsed?.verify ?? "?")}`
        : testCase.family === "verify"
          ? `${run.score.findingHits ?? 0}/${run.score.findingTotal ?? 0} findings`
          : run.score.forbiddenHits?.length ? `forbidden: ${run.score.forbiddenHits.join(", ")}` : "rubric clean";
      return `<td class="${run.score.match ? "pass" : "miss"}"><strong>${run.score.match ? "match" : "miss"}</strong><div class="sub">${esc(detail)}</div><details><summary>response</summary><pre>${esc(run.response)}</pre></details></td>`;
    }).join("");
    return `<tr><td><code>${esc(testCase.id)}</code><div class="sub">${esc(testCase.note)}</div></td><td>${esc(testCase.family)}</td>${cells}</tr>`;
  }).join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(result.benchmark.name)}</title><style>
:root{--bg:#f4f1ea;--card:#fffefa;--ink:#26231e;--muted:#746d62;--line:#d9d1c5;--good:#176b45;--bad:#a33a31}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}.wrap{max-width:1200px;margin:auto;padding:32px 18px 64px}h1{font-size:clamp(28px,4vw,46px);line-height:1.05;margin-bottom:8px}.sub{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px;margin:24px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.card h2{font-size:17px;margin:0}.score{font-size:36px;font-weight:750;margin-top:8px}dl{display:grid;grid-template-columns:1fr auto;margin:16px 0}dt,dd{border-top:1px solid var(--line);padding:7px 0;margin:0}dd{font-weight:650}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;background:var(--card)}th,td{text-align:left;vertical-align:top;padding:10px;border:1px solid var(--line)}th{background:#eae4d9}.pass{color:var(--good)}.miss{color:var(--bad)}pre{white-space:pre-wrap;max-width:560px;color:var(--ink);font:12px/1.4 ui-monospace,monospace}code{font-size:12px}summary{cursor:pointer;color:var(--muted)}
</style></head><body><main class="wrap"><h1>${esc(result.benchmark.name)}</h1><p class="sub">${esc(result.generatedAt)} · ${result.cases.length} cases · ${result.repeats} repeat(s) · OpenAI-compatible chat completions</p><div class="grid">${cards}</div><h2>Case matrix — first repeat</h2><div class="scroll"><table><thead><tr><th>Case</th><th>Family</th>${result.models.map((model) => `<th>${esc(model)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></main></body></html>`;
}

export function writeReports({ result, jsonPath, htmlPath }) {
  fs.mkdirSync(new URL(".", `file://${jsonPath}`).pathname, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(htmlPath, renderHtml(result));
}
