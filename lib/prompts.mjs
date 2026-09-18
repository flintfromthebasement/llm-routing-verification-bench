export function buildRouteMessages(testCase) {
  const prompt = [
    "Pick the best response tier for the next assistant turn, and whether the reply should get a claims-verification pass.",
    'Return JSON only: {"tier":"base|mid|top","verify":true|false,"reason":"short reason"}',
    "",
    "Pick the LOWEST tier that can do the job well. Only escalate when the task genuinely needs it. When torn between two tiers, choose the lower one.",
    "",
    "base: simple chat, acknowledgements, and lightweight Q&A.",
    "mid: writing, editing, normal technical help, and single-step factual lookups, including a tool call that fetches and reports one value or document. Using a tool does not by itself mean top.",
    "top: multi-step reasoning, debugging, architecture, risk analysis, or synthesizing across several sources into one coherent answer.",
    "",
    "An explicit request for a tier overrides the guidelines above.",
    "",
    "verify=true when the reply will likely assert checkable factual claims: product or API behavior, code or configuration guidance, versions, links, documentation, or error troubleshooting.",
    "verify=false for chitchat, acknowledgements, opinions, scheduling, copy-editing, and purely creative writing.",
    "",
    "Recent conversation:",
    "(none)",
    "",
    "Latest user message:",
    testCase.message,
  ].join("\n");
  return {
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    maxTokens: 120,
  };
}

export function buildVerifierMessages(testCase, now = new Date()) {
  const system = `You are a strict reviewer checking a draft chat reply before it is sent. Your only job is to catch unsupported factual claims. Do not rewrite the draft. Do not grade style, tone, or completeness. Only flag concrete problems that match the rules below.

Current date/time: ${now.toISOString()}. Judge date arithmetic against this date, not against training data.

Evidence sources — what counts as grounded:
  1. The conversation history provided below.
  2. Tool results from this turn, provided below.
  3. What the user stated in their message.

Flag the draft when it:
- states a specific technical behavior, configuration, version, price, date, quote, or identifier as fact without evidence;
- includes a URL, file path, command, or reference absent from the evidence;
- contradicts the evidence;
- presents a guess with confident wording instead of clearly hedging it.

Do not flag:
- claims clearly hedged as uncertain;
- common knowledge or general programming facts;
- opinions, recommendations, and plans clearly framed as such;
- restatements of what the user said.

Severity:
- "block": concretely wrong, fabricated, or risky to send as-is;
- "warn": defensible but worth double-checking.

Return strict JSON only:
{
  "claims_checked": <number>,
  "issues": [
    {
      "type": "unverified_claim" | "fabricated_reference" | "contradicts_evidence",
      "severity": "block" | "warn",
      "claim": "the offending claim",
      "description": "why it fails",
      "fix_hint": "how to fix it"
    }
  ],
  "needs_regen": true | false
}
needs_regen is true if and only if at least one issue has severity "block".
If nothing is wrong, return an empty issues array and needs_regen=false.
Do not invent issues. Err on the side of clean when the draft is fine.`;

  const user = `--- User message ---
${testCase.userText}

--- Conversation history ---
${testCase.conversation || "(none)"}

--- Tool results ---
${testCase.toolSummary || "(none)"}

--- Draft reply to review ---
${testCase.draft}

Review the draft against the rules and return strict JSON.`;

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    maxTokens: 800,
  };
}

export function buildInterimMessages(testCase) {
  const corrections = testCase.issues
    .filter((issue) => issue.severity === "block")
    .map((issue) => `- ${issue.description}${issue.fix_hint ? ` (${issue.fix_hint})` : ""}`)
    .join("\n");

  const system = `Write a short interim chat message for an assistant that is reworking its full answer. Write one or two short sentences in a direct, casual voice that:
- share any immediately useful correction stated in the findings, only if the findings state it;
- say you are double-checking or pulling up the right approach before the full answer.

Hard rules:
- Reply in English unless the user's own message is clearly written in another language.
- State only facts that appear in the findings. No new claims, links, or code.
- Never mention a reviewer, validator, draft, previous response, or internal process.
- No greetings, emoji, or Markdown headers. Plain sentences only.`;

  const user = `User's question:
${testCase.userText}

Blocking findings:
${corrections}

Write the interim message now.`;

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    maxTokens: 150,
  };
}

export function buildMessages(testCase, now) {
  if (testCase.family === "route") return buildRouteMessages(testCase);
  if (testCase.family === "verify") return buildVerifierMessages(testCase, now);
  if (testCase.family === "interim") return buildInterimMessages(testCase);
  throw new Error(`Unknown case family: ${testCase.family}`);
}

function compactRouteExample(testCase) {
  return {
    input: testCase.message,
    label: { tier: testCase.expected.tier, verify: testCase.expected.verify },
  };
}

function compactVerifierExample(testCase) {
  return {
    user: testCase.userText,
    evidence: testCase.toolSummary,
    draft: testCase.draft,
    label: {
      needs_regen: testCase.expected.needs_regen,
      findings: (testCase.requiredFindings || []).map((terms) => terms.join(" + ")),
    },
  };
}

export function extractClaimCandidates(draft) {
  return [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(String(draft || ""))]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
}

export function buildDecisionRequest(testCase, cases) {
  if (testCase.family === "interim") return null;
  if (testCase.family === "route") {
    const candidates = cases.filter((item) => item.family === "route" && item.id !== testCase.id);
    const examples = ["base", "mid", "top"]
      .flatMap((tier) => candidates.filter((item) => item.expected.tier === tier).slice(0, 2))
      .map(compactRouteExample);
    return {
      state: {
        task: "Classify the next assistant turn. Pick the lowest tier that can do the job well; an explicit tier request overrides. Decide separately whether factual claims need verification.",
        tier_definitions: {
          base: "Simple chat, acknowledgements, lightweight questions.",
          mid: "Writing, editing, normal technical help, or a single factual lookup/tool result.",
          top: "Multi-step reasoning, debugging, architecture, risk analysis, or synthesis across sources.",
        },
        verify_rule: "True for likely checkable claims such as product/API behavior, code/configuration guidance, versions, links, documentation, or troubleshooting. False for chat, opinions, scheduling, copy-editing, and creative writing.",
        labeled_examples: examples,
        input: { recent_conversation: null, latest_user_message: testCase.message },
      },
      questions: {
        tier: {
          type: "choice",
          instructions: "Which response tier should handle the latest user message?",
          criteria: {
            base: "The base tier definition is the lowest sufficient tier.",
            mid: "The mid tier definition is the lowest sufficient tier.",
            top: "The task requires the top tier definition or explicitly requests it.",
          },
        },
        verify: {
          type: "noul",
          instructions: "Should the eventual reply receive a factual-claims verification pass?",
          criteria: { true: "The verify rule applies.", false: "The verify rule does not apply." },
        },
      },
    };
  }

  const claimCandidates = extractClaimCandidates(testCase.draft);
  const claimQuestions = Object.fromEntries(claimCandidates.map((claim, index) => [
    `claim_${index + 1}`,
    {
      type: "noul",
      instructions: `Does this candidate claim require blocking regeneration under the strict evidence rules: ${claim}`,
      criteria: {
        true: "The candidate is unsupported, fabricated, contradictory, or an unhedged guess that is risky to send.",
        false: "The candidate is grounded, common knowledge, an opinion or plan, a user restatement, or clearly hedged.",
      },
    },
  ]));
  return {
    state: {
      task: "Strictly review a draft for unsupported factual claims. Do not grade writing quality or completeness.",
      strict_evidence_rules: {
        grounded_sources: ["user message", "conversation", "tool evidence"],
        flag: ["unsupported specific technical behavior, configuration, version, price, date, quote, identifier, URL, path, command, or reference", "claims that contradict evidence", "guesses stated confidently"],
        do_not_flag: ["clearly hedged uncertainty", "common knowledge", "opinions and plans", "restatements of the user"],
        blocking: "needs_regen is true only when at least one concrete issue is wrong, fabricated, or risky to send as-is.",
      },
      labeled_examples: cases.filter((item) => item.family === "verify" && item.id !== testCase.id).map(compactVerifierExample),
      user: testCase.userText,
      conversation: testCase.conversation || null,
      tool_evidence: testCase.toolSummary || null,
      draft: testCase.draft,
    },
    questions: {
      needs_regen: {
        type: "noul",
        instructions: "Under the strict evidence rules, does this draft contain at least one blocking issue and therefore need regeneration?",
        criteria: { true: "At least one concrete blocking issue exists.", false: "No blocking issue exists; do not invent one." },
      },
      ...claimQuestions,
    },
    claimCandidates,
  };
}
