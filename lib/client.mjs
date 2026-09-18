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

export function isDecisionsModel(model) {
  return /^~?typesafe\/jev-(?:latest|.+)$/.test(String(model || ""));
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
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (process.env.BENCH_HTTP_REFERER) headers["HTTP-Referer"] = process.env.BENCH_HTTP_REFERER;
  if (process.env.BENCH_APP_TITLE) headers["X-Title"] = process.env.BENCH_APP_TITLE;
  try {
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, state: decisionRequest.state, questions: decisionRequest.questions }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json();
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
