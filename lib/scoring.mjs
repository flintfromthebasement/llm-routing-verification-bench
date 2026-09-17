export function parseJsonObject(raw) {
  const text = String(raw || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Keep narrowing in case the model added text after valid JSON.
    }
  }
  return null;
}

function includesAll(text, terms) {
  return terms.every((term) => text.includes(String(term).toLowerCase()));
}

export function scoreRoute(testCase, raw) {
  const parsed = parseJsonObject(raw);
  const match = parsed?.tier === testCase.expected.tier && parsed?.verify === testCase.expected.verify;
  return {
    match,
    parsed,
    expected: testCase.expected,
    detailScore: match ? 1 : 0,
    detailTotal: 1,
  };
}

export function scoreVerifier(testCase, raw) {
  const parsed = parseJsonObject(raw);
  const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
  const derivedNeedsRegen = issues.some((issue) => issue?.severity === "block");
  const match = Boolean(parsed) && derivedNeedsRegen === testCase.expected.needs_regen;
  const issueText = JSON.stringify(issues).toLowerCase();
  const required = testCase.requiredFindings || [];
  const hits = required.filter((terms) => includesAll(issueText, terms)).length;
  const falsePositiveFree = testCase.expected.needs_regen || issues.length === 0;
  return {
    match,
    parsed,
    expected: testCase.expected,
    needsRegen: derivedNeedsRegen,
    issueCount: issues.length,
    findingHits: hits,
    findingTotal: required.length,
    detailScore: required.length ? hits : (falsePositiveFree ? 1 : 0),
    detailTotal: required.length || 1,
  };
}

export function countSentences(text) {
  return String(text || "").split(/[.!?]+(?:\s+|$)/).filter((part) => part.trim()).length;
}

export function scoreInterim(testCase, raw) {
  const text = String(raw || "").trim();
  const lower = text.toLowerCase();
  const sentences = countSentences(text);
  const required = testCase.expected.requiredAny || [];
  const forbidden = testCase.expected.forbidden || [];
  const requiredHits = required.filter((terms) => terms.some((term) => lower.includes(String(term).toLowerCase()))).length;
  const forbiddenHits = forbidden.filter((term) => lower.includes(String(term).toLowerCase()));
  const lengthOk = sentences >= 1 && sentences <= 2;
  const match = Boolean(text) && lengthOk && requiredHits === required.length && forbiddenHits.length === 0;
  return {
    match,
    sentences,
    lengthOk,
    requiredHits,
    requiredTotal: required.length,
    forbiddenHits,
    detailScore: requiredHits + (lengthOk ? 1 : 0) + (forbiddenHits.length === 0 ? 1 : 0),
    detailTotal: required.length + 2,
  };
}

export function scoreCase(testCase, raw) {
  if (testCase.family === "route") return scoreRoute(testCase, raw);
  if (testCase.family === "verify") return scoreVerifier(testCase, raw);
  if (testCase.family === "interim") return scoreInterim(testCase, raw);
  throw new Error(`Unknown case family: ${testCase.family}`);
}
