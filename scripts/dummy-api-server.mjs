// OpenAI互換APIとAnthropic Messages APIを1ポートで模擬するダミーサーバー。
// APIキー不要・外部通信なしで、Kataruのチャット・ストリーミング・構造化出力を確認できる。
//
// ベースURL（OpenAI互換 / Anthropic のどちらにも同じ値を設定できる）:
//   http://127.0.0.1:4200/v1
//
// 対応エンドポイント:
//   GET  {base}/models                 → モデル一覧（anthropic-versionヘッダの有無で形式を切り替え）
//   POST {base}/chat/completions       → OpenAI形式。stream: true ならSSE
//   POST {base}/messages               → Anthropic形式。stream: true ならSSE
//   POST {base}/messages/count_tokens  → Anthropic形式のトークン数見積もり
//   POST {base}/embeddings             → OpenAI形式の埋め込み（入力から決まる擬似ベクトル）
//   GET  /health                       → 稼働確認
//
// 最後のuserメッセージに次のキーワードを含めると挙動が変わる:
//   slow      → SLOW_MS（既定10秒）待ってから応答（タイムアウト確認用）
//   fail      → 500エラー。fail:429 のように任意のステータスも指定できる
//
// response_format / output_config.format が json_schema のときは、
// スキーマから組み立てたダミーJSONを返す（構造化出力の確認用）。
//
// 使い方:
//   node scripts/dummy-api-server.mjs
//   PORT=4300 node scripts/dummy-api-server.mjs
//   npm run dummy:api

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4200);
const HOST = "127.0.0.1";
const SLOW_MS = Number(process.env.SLOW_MS ?? 10_000);
const CHUNK_DELAY_MS = Number(process.env.CHUNK_DELAY_MS ?? 15);
const CHUNK_SIZE = 24;
const MAX_ECHO_CHARS = 2_000;
const DEFAULT_EMBEDDING_DIMENSIONS = 256;
const MAX_EMBEDDING_DIMENSIONS = 3_072;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MODEL_CREATED_AT = "2026-01-01T00:00:00Z";

const MODELS = [
  { id: "dummy-chat", displayName: "Dummy Chat" },
  { id: "dummy-chat-mini", displayName: "Dummy Chat Mini" },
  { id: "dummy-embedding", displayName: "Dummy Embedding" },
];

let requestSeq = 0;

// --- 共通ヘルパー ---

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function anthropicErrorType(status) {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

function sendApiError(res, provider, status, message) {
  if (provider === "anthropic") {
    sendJson(res, status, {
      type: "error",
      error: { type: anthropicErrorType(status), message },
    });
    return;
  }
  sendJson(res, status, {
    error: { message, type: "dummy_error", code: `dummy_${status}` },
  });
}

function beginEventStream(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
}

function writeRaw(res, text) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(text);
  return true;
}

function writeEvent(res, type, data) {
  if (type) writeRaw(res, `event: ${type}\n`);
  writeRaw(res, `data: ${JSON.stringify(data)}\n\n`);
}

function splitText(text) {
  const chars = Array.from(text);
  const chunks = [];
  for (let index = 0; index < chars.length; index += CHUNK_SIZE) {
    chunks.push(chars.slice(index, index + CHUNK_SIZE).join(""));
  }
  return chunks.length > 0 ? chunks : [""];
}

async function streamText(res, text, writeChunk) {
  for (const chunk of splitText(text)) {
    if (!writeChunk(chunk)) return false;
    await sleep(CHUNK_DELAY_MS);
  }
  return true;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (part) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body is too large"));
        req.destroy();
        return;
      }
      parts.push(part);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = (await readRawBody(req)).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// --- メッセージからのテキスト抽出 ---

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return contentText(message.content);
  }
  return "";
}

function conversationText({ system, messages }) {
  const parts = [];
  if (system) parts.push(contentText(system));
  for (const message of Array.isArray(messages) ? messages : []) {
    parts.push(contentText(message?.content));
  }
  return parts.join("\n");
}

// 日本語は1文字≒1トークン、ASCIIは4文字≒1トークンとして概算する
function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    tokens += char.codePointAt(0) > 0x7f ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}

function behaviorFor(text) {
  const failMatch = /\bfail(?::(\d{3}))?\b/i.exec(text);
  return {
    slow: /\bslow\b/i.test(text),
    failStatus: failMatch ? Number(failMatch[1] ?? 500) : 0,
  };
}

// --- 構造化出力（JSONスキーマ）---

function requestedSchema(provider, body) {
  if (provider === "anthropic") {
    const format = body.output_config?.format ?? body.outputConfig?.format;
    return format?.type === "json_schema"
      ? { kind: "json_schema", schema: format.schema ?? null }
      : null;
  }
  const format = body.response_format ?? body.responseFormat;
  if (format?.type === "json_schema") {
    return {
      kind: "json_schema",
      schema: format.json_schema?.schema ?? format.schema ?? null,
    };
  }
  return format?.type === "json_object" ? { kind: "json_object" } : null;
}

function sampleString(schema) {
  switch (schema.format) {
    case "date-time":
      return new Date().toISOString();
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "time":
      return `${new Date().toISOString().slice(11, 19)}Z`;
    case "email":
      return "dummy@example.com";
    case "uri":
    case "url":
      return `http://${HOST}:${PORT}/`;
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    default:
      return "dummy";
  }
}

// スキーマの形だけを満たすダミー値を作る（内容の正しさは問わない）
function sampleFromSchema(schema, depth = 0) {
  if (depth > 8 || !schema || typeof schema !== "object") return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return sampleFromSchema(schema.allOf[0], depth + 1);
  }
  const branch = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (branch) return sampleFromSchema(branch, depth + 1);

  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null") ?? "null"
    : schema.type ?? (schema.properties ? "object" : undefined);

  switch (type) {
    case "object": {
      const result = {};
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        result[key] = sampleFromSchema(value, depth + 1);
      }
      return result;
    }
    case "array":
      return schema.items && !Array.isArray(schema.items)
        ? [sampleFromSchema(schema.items, depth + 1)]
        : [];
    case "string":
      return sampleString(schema);
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return null;
  }
}

function buildAnswer({ provider, body, prompt }) {
  const structured = requestedSchema(provider, body);
  if (structured?.kind === "json_schema") {
    return JSON.stringify(structured.schema ? sampleFromSchema(structured.schema) : {});
  }
  if (structured?.kind === "json_object") {
    return JSON.stringify({ response: `[dummy] ${prompt}` });
  }
  const echo =
    prompt.length > MAX_ECHO_CHARS ? `${prompt.slice(0, MAX_ECHO_CHARS)}…` : prompt;
  return `[dummy] ${echo}`;
}

// --- OpenAI互換: chat/completions ---

async function handleOpenAiChat(body, res) {
  const model = String(body.model ?? "dummy-chat");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = lastUserText(messages);
  const behavior = behaviorFor(prompt);
  const stream = body.stream === true;
  const id = `chatcmpl-dummy-${++requestSeq}`;

  console.log(
    `[dummy-api] openai model=${model} stream=${stream} messages=${messages.length} prompt=${JSON.stringify(prompt.slice(0, 120))}`,
  );

  if (behavior.failStatus) {
    sendApiError(res, "openai", behavior.failStatus, `dummy failure (${behavior.failStatus})`);
    return;
  }
  if (behavior.slow) await sleep(SLOW_MS);

  const answer = buildAnswer({ provider: "openai", body, prompt });
  const promptTokens = estimateTokens(conversationText({ messages }));
  const completionTokens = estimateTokens(answer);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
  const created = nowSeconds();

  if (!stream) {
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      system_fingerprint: "dummy",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: answer, refusal: null },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage,
    });
    return;
  }

  beginEventStream(res);
  const base = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: "dummy",
  };
  const writeChoice = (delta, finishReason = null) =>
    writeRaw(
      res,
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
      })}\n\n`,
    );

  writeChoice({ role: "assistant", content: "" });
  await streamText(res, answer, (chunk) => writeChoice({ content: chunk }));
  writeChoice({}, "stop");

  if (body.stream_options?.include_usage) {
    writeRaw(res, `data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
  }
  writeRaw(res, "data: [DONE]\n\n");
  res.end();
}

// --- Anthropic: messages ---

async function handleAnthropicMessages(body, res) {
  const model = String(body.model ?? "dummy-chat");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system;
  const prompt = lastUserText(messages);
  const behavior = behaviorFor(prompt);
  const stream = body.stream === true;
  const id = `msg_dummy_${++requestSeq}`;

  console.log(
    `[dummy-api] anthropic model=${model} stream=${stream} messages=${messages.length} prompt=${JSON.stringify(prompt.slice(0, 120))}`,
  );

  if (behavior.failStatus) {
    sendApiError(res, "anthropic", behavior.failStatus, `dummy failure (${behavior.failStatus})`);
    return;
  }
  if (behavior.slow) await sleep(SLOW_MS);

  const answer = buildAnswer({ provider: "anthropic", body, prompt });
  const inputTokens = estimateTokens(conversationText({ system, messages }));
  const outputTokens = estimateTokens(answer);

  if (!stream) {
    sendJson(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: answer }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    return;
  }

  beginEventStream(res);
  writeEvent(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  writeEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  writeEvent(res, "ping", { type: "ping" });

  await streamText(res, answer, (chunk) => {
    writeEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    });
    return true;
  });

  writeEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  writeEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  writeEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function handleCountTokens(body, res) {
  sendJson(res, 200, {
    input_tokens: estimateTokens(conversationText(body)),
  });
}

// --- OpenAI互換: embeddings ---

function hash32(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// 同じ入力からは常に同じ単位ベクトルを返す（コサイン類似度が意味を持つように正規化）
function pseudoEmbedding(text, dimensions) {
  let state = hash32(text) || 1;
  const values = new Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values[index] = (state / 0xffffffff) * 2 - 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

function embeddingBase64(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer.toString("base64");
}

function embeddingTexts(input) {
  if (typeof input === "string") return [input];
  if (!Array.isArray(input)) return [];
  return input.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
}

function handleEmbeddings(body, res) {
  const texts = embeddingTexts(body.input);
  if (texts.length === 0) {
    sendApiError(res, "openai", 400, "input must be a string or an array of strings");
    return;
  }
  const model = String(body.model ?? "dummy-embedding");
  const requested = Number(body.dimensions);
  const dimensions =
    Number.isInteger(requested) && requested > 0 && requested <= MAX_EMBEDDING_DIMENSIONS
      ? requested
      : DEFAULT_EMBEDDING_DIMENSIONS;
  const base64 = body.encoding_format === "base64";

  console.log(
    `[dummy-api] openai embeddings model=${model} inputs=${texts.length} dimensions=${dimensions}`,
  );

  const promptTokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  sendJson(res, 200, {
    object: "list",
    data: texts.map((text, index) => {
      const vector = pseudoEmbedding(text, dimensions);
      return {
        object: "embedding",
        index,
        embedding: base64 ? embeddingBase64(vector) : vector,
      };
    }),
    model,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  });
}

// --- モデル一覧 ---

function isAnthropicRequest(req) {
  return (
    typeof req.headers["anthropic-version"] === "string" ||
    (typeof req.headers["x-api-key"] === "string" && !req.headers.authorization)
  );
}

function handleModels(req, res, path) {
  const anthropic = isAnthropicRequest(req);
  const requestedId = /\/models\/([^/]+)$/.exec(path)?.[1];
  const models = requestedId
    ? MODELS.filter((model) => model.id === decodeURIComponent(requestedId))
    : MODELS;

  if (requestedId && models.length === 0) {
    sendApiError(res, anthropic ? "anthropic" : "openai", 404, `model not found: ${requestedId}`);
    return;
  }

  if (anthropic) {
    sendJson(res, 200, {
      data: models.map((model) => ({
        type: "model",
        id: model.id,
        display_name: model.displayName,
        created_at: MODEL_CREATED_AT,
      })),
      has_more: false,
      first_id: models[0]?.id ?? null,
      last_id: models.at(-1)?.id ?? null,
    });
    return;
  }

  sendJson(res, 200, {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "dummy",
    })),
  });
}

// --- ルーティング ---

function handleHealth(res) {
  sendJson(res, 200, {
    status: "ok",
    openaiBaseUrl: `http://${HOST}:${PORT}/v1`,
    anthropicBaseUrl: `http://${HOST}:${PORT}/v1`,
    models: MODELS.map((model) => model.id),
  });
}

function routesIndex() {
  return {
    name: "kataru dummy api server",
    openai: `http://${HOST}:${PORT}/v1`,
    anthropic: `http://${HOST}:${PORT}/v1`,
    endpoints: [
      "GET /v1/models",
      "POST /v1/chat/completions",
      "POST /v1/messages",
      "POST /v1/messages/count_tokens",
      "POST /v1/embeddings",
      "GET /health",
    ],
    keywords: ["slow", "fail", "fail:<status>"],
  };
}

async function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const provider = path.endsWith("/messages") || path.includes("/messages/")
    ? "anthropic"
    : isAnthropicRequest(req)
      ? "anthropic"
      : "openai";

  console.log(`[dummy-api] ${req.method} ${path}`);

  if (req.method === "GET" && path === "/") {
    sendJson(res, 200, routesIndex());
    return;
  }
  if (req.method === "GET" && path === "/health") {
    handleHealth(res);
    return;
  }
  if (req.method === "GET" && /\/models(\/[^/]+)?$/.test(path)) {
    handleModels(req, res, path);
    return;
  }
  if (req.method === "POST" && path.endsWith("/chat/completions")) {
    await handleOpenAiChat(await readJsonBody(req), res);
    return;
  }
  if (req.method === "POST" && path.endsWith("/messages/count_tokens")) {
    handleCountTokens(await readJsonBody(req), res);
    return;
  }
  if (req.method === "POST" && path.endsWith("/messages")) {
    await handleAnthropicMessages(await readJsonBody(req), res);
    return;
  }
  if (req.method === "POST" && path.endsWith("/embeddings")) {
    handleEmbeddings(await readJsonBody(req), res);
    return;
  }

  sendApiError(res, provider, 404, `dummy: no route for ${req.method} ${path}`);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("[dummy-api] request failed:", error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendApiError(
      res,
      isAnthropicRequest(req) ? "anthropic" : "openai",
      500,
      `dummy: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[dummy-api] listening on http://${HOST}:${PORT}`);
  console.log(`[dummy-api] OpenAI互換 base URL: http://${HOST}:${PORT}/v1 (APIキーは任意)`);
  console.log(`[dummy-api] Anthropic  base URL: http://${HOST}:${PORT}/v1 (APIキーは任意)`);
  console.log("[dummy-api] ヒント: 最後のuserメッセージに slow / fail(:429) を含めると挙動が変わります");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
