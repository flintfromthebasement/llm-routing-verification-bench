import { performance } from "node:perf_hooks";

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function normalizeUsage(usage, input, responseText) {
  if (usage?.prompt_tokens !== undefined || usage?.input_tokens !== undefined) {
    return {
      inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      totalTokens: usage.total_tokens ?? ((usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0)),
      cost: usage.cost ?? null,
      estimated: false,
    };
  }
  const inputTokens = estimateTokens(typeof input === "string" ? input : JSON.stringify(input));
  const output = estimateTokens(responseText);
  return { inputTokens, outputTokens: output, totalTokens: inputTokens + output, cost: null, estimated: true };
}

function calculatedCost(usage, inputPrice, outputPrice) {
  if (usage.cost !== null) return Number(usage.cost);
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return null;
  return (usage.inputTokens * inputPrice + usage.outputTokens * outputPrice) / 1_000_000;
}

async function streamingResponse(response, started, messages, prices) {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let firstTokenMs = null;
  let rawUsage = null;
  let provider = null;
  let generationId = null;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        generationId ||= parsed.id || null;
        provider ||= parsed.provider || null;
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          if (firstTokenMs === null) firstTokenMs = performance.now() - started;
          text += content;
        }
        if (parsed.usage) rawUsage = parsed.usage;
      }
    }
  }

  const elapsedMs = performance.now() - started;
  const usage = normalizeUsage(rawUsage, messages.map((message) => message.content).join("\n"), text);
  const generationMs = Math.max(1, elapsedMs - (firstTokenMs ?? elapsedMs));
  return {
    response: text.trim(),
    elapsedMs,
    firstTokenMs,
    outputTokensPerSecond: usage.outputTokens / (generationMs / 1000),
    ...usage,
    cost: calculatedCost(usage, prices.inputPrice, prices.outputPrice),
    provider,
    generationId,
  };
}

async function regularResponse(response, started, messages, prices) {
  const body = await response.json();
  const elapsedMs = performance.now() - started;
  const text = body.choices?.[0]?.message?.content || "";
  const usage = normalizeUsage(body.usage, messages.map((message) => message.content).join("\n"), text);
  return {
    response: text.trim(),
    elapsedMs,
    firstTokenMs: null,
    outputTokensPerSecond: usage.outputTokens / Math.max(0.001, elapsedMs / 1000),
    ...usage,
    cost: calculatedCost(usage, prices.inputPrice, prices.outputPrice),
    provider: body.provider || null,
    generationId: body.id || null,
  };
}

// Structured-state Decisions models (state + typed Choice/Noul questions). Dated
// snapshots and the ~ alias resolve to the same endpoint. Respan is separate: it
// needs string state and noul-only questions.
const STRUCTURED_DECISIONS_MODELS = [
  /^~?typesafe\/jev-(?:latest|.+)$/,
  /^~?openai\/gpt-6-luna-decisions(?:-\d+)?$/,
  /^~?microsoft\/microsoft-decision-\d+(?:-\d+)?$/,
  /^~?perplexity\/pplx-decider(?:-flash)?-v[\d.]+(?:-\d+)?$/,
];

export function isDecisionsModel(model) {
  const id = String(model || "");
  return STRUCTURED_DECISIONS_MODELS.some((pattern) => pattern.test(id)) || isRespanModel(id) || isClefModel(id);
}

// Cloudflare Clef speaks the same state + typed-questions body natively. It is not on
// OpenRouter: hosted calls go to Workers AI, local weights serve the same body at /v1/systemone.
export function isClefModel(model) {
  return /^(?:@cf\/)?cloudflare\/clef(?:-flash|-omni)?$/i.test(String(model || ""));
}

export function clefEndpoint(model, env = process.env) {
  if (env.CLEF_BASE_URL) return env.CLEF_BASE_URL;
  if (!env.CF_ACCOUNT_ID) throw new Error("Clef models need CLEF_BASE_URL (a local /v1/systemone server) or CF_ACCOUNT_ID plus a Workers AI key.");
  const name = String(model).replace(/^@cf\//i, "").toLowerCase();
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/${name}`;
}

function clefModelName(model) {
  return String(model).split("/").pop().toLowerCase();
}

export function isRespanModel(model) {
  return /^~?respan\/span-.+$/.test(String(model || ""));
}

// Respan takes string state and noul-only questions, so each choice becomes one noul per option.
export function toRespanRequest(decisionRequest) {
  const questions = {};
  for (const [key, question] of Object.entries(decisionRequest.questions)) {
    if (question.type !== "choice") {
      questions[key] = question;
      continue;
    }
    for (const [option, criterion] of Object.entries(question.criteria)) {
      questions[`${key}__${option}`] = {
        type: "noul",
        instructions: `${question.instructions} Answer yes only if the answer is "${option}".`,
        criteria: { true: criterion, false: `A different option fits better than "${option}".` },
      };
    }
  }
  return { state: JSON.stringify(decisionRequest.state, null, 2), questions };
}

export function fromRespanAnswers(decisionRequest, answers) {
  const out = {};
  for (const [key, question] of Object.entries(decisionRequest.questions)) {
    if (question.type !== "choice") {
      out[key] = answers[key];
      continue;
    }
    const probabilities = Object.fromEntries(Object.keys(question.criteria).map((option) => [option, Number(answers[`${key}__${option}`]?.noul) || 0]));
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    out[key] = { type: "choice", choice, probabilities, adapter: "noul-per-option" };
  }
  return out;
}

function isYes(answer) {
  return Number(answer?.noul) >= 0.5;
}

function synthesizeDecisionResponse(decisionRequest, body) {
  const answers = body.answers || {};
  if (answers.tier && answers.verify) {
    return JSON.stringify({ tier: answers.tier.choice, verify: isYes(answers.verify) });
  }
  const headlineNeedsRegen = isYes(answers.needs_regen);
  const issues = (decisionRequest.claimCandidates || []).flatMap((claim, index) => {
    if (!isYes(answers[`claim_${index + 1}`])) return [];
    return [{
      type: "unverified_claim",
      severity: "block",
      claim,
      description: `This candidate claim is not adequately grounded in the supplied evidence: ${claim}`,
      fix_hint: "Remove the claim or ground it in the supplied evidence.",
    }];
  });
  if (headlineNeedsRegen && !issues.length) {
    issues.push({ type: "unverified_claim", severity: "block", claim: "unspecified blocking claim", description: "The draft contains a blocking evidence defect.", fix_hint: "Regenerate using only supplied evidence." });
  }
  return JSON.stringify({ claims_checked: decisionRequest.claimCandidates?.length || 0, issues, needs_regen: issues.length > 0 });
}

export async function callDecisions({ apiKey, model, decisionRequest, inputPrice, outputPrice, timeoutMs = 60_000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  const clef = isClefModel(model);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (process.env.BENCH_HTTP_REFERER) headers["HTTP-Referer"] = process.env.BENCH_HTTP_REFERER;
  if (process.env.BENCH_APP_TITLE) headers["X-Title"] = process.env.BENCH_APP_TITLE;
  const url = clef ? clefEndpoint(model) : "https://openrouter.ai/api/alpha/decisions";
  const requestModel = clef ? clefModelName(model) : model;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(isRespanModel(model)
        ? { model, ...toRespanRequest(decisionRequest) }
        : { model: requestModel, state: decisionRequest.state, questions: decisionRequest.questions }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 500)}`);
    let body = await response.json();
    // Workers AI wraps the SystemOne body in { result, success, errors }.
    if (clef && body && typeof body.success === "boolean") {
      if (!body.success) throw new Error(`Workers AI: ${JSON.stringify(body.errors || body).slice(0, 500)}`);
      body = body.result || {};
    }
    if (clef && !body.provider) body.provider = process.env.CLEF_BASE_URL ? "local" : "Cloudflare Workers AI";
    if (isRespanModel(model)) body.answers = fromRespanAnswers(decisionRequest, body.answers || {});
    const elapsedMs = performance.now() - started;
    const synthesized = synthesizeDecisionResponse(decisionRequest, body);
    const usage = normalizeUsage(body.usage, decisionRequest.state, synthesized);
    return {
      response: synthesized,
      elapsedMs,
      firstTokenMs: null,
      outputTokensPerSecond: null,
      ...usage,
      cost: calculatedCost(usage, inputPrice, outputPrice),
      provider: body.provider || null,
      generationId: body.id || null,
      responseModel: body.model || null,
      adapter: "decisions",
      decisionAnswers: body.answers || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function callModel({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  stream = true,
  inputPrice,
  outputPrice,
  timeoutMs = 60_000,
}) {
  if (isDecisionsModel(model)) throw new Error("Jev Decisions models require callDecisions with structured state and questions.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true }, usage: { include: true } } : {}),
  };
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (process.env.BENCH_HTTP_REFERER) headers["HTTP-Referer"] = process.env.BENCH_HTTP_REFERER;
  if (process.env.BENCH_APP_TITLE) headers["X-Title"] = process.env.BENCH_APP_TITLE;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 500)}`);
    const prices = { inputPrice, outputPrice };
    const result = stream
      ? await streamingResponse(response, started, messages, prices)
      : await regularResponse(response, started, messages, prices);
    return { ...result, adapter: "chat-completions" };
  } finally {
    clearTimeout(timeout);
  }
}
