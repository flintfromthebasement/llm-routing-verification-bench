import { performance } from "node:perf_hooks";

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function normalizeUsage(usage, messages, responseText) {
  if (usage?.prompt_tokens !== undefined || usage?.input_tokens !== undefined) {
    return {
      inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      totalTokens: usage.total_tokens ?? ((usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0)),
      cost: usage.cost ?? null,
      estimated: false,
    };
  }
  const input = estimateTokens(messages.map((message) => message.content).join("\n"));
  const output = estimateTokens(responseText);
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, cost: null, estimated: true };
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
  const usage = normalizeUsage(rawUsage, messages, text);
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
  const usage = normalizeUsage(body.usage, messages, text);
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
    return stream
      ? await streamingResponse(response, started, messages, prices)
      : await regularResponse(response, started, messages, prices);
  } finally {
    clearTimeout(timeout);
  }
}
