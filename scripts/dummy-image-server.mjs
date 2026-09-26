// OpenAI互換APIとして以下を模擬する:
//   GET  {base}/models              → モデル一覧（接続プローブ・カタログ用）
//   POST {base}/images/generations  → { data: [{ b64_json }] }
//   POST {base}/images/edits        → multipart/form-data を受け取り { data: [{ b64_json }] }
//   POST {base}/chat/completions    → 最後のuser発言をエコーするスタブ
//
// 使い方:
//   node scripts/dummy-image-server.mjs          # http://127.0.0.1:4100
//   PORT=4300 node scripts/dummy-image-server.mjs

// 次のキーワードをプロンプトに含めると挙動が変わる:
//   slow      → 10秒待ってから応答（タイムアウト・ローディング確認用）
//   fail      → 500エラー。fail:429 のように任意ステータスも可
//   url       → b64_jsonではなくurl形式で返す（GET /image.png で配信）

import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const PORT = Number(process.env.PORT ?? 4100);
const HOST = "127.0.0.1";
const SLOW_MS = 10_000;
const MAX_DIMENSION = 2048;

// --- CRC32 (PNG用) ---
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// プロンプト由来の色＋サイズ描画のPNGを生成する
function makePng(width, height, seedText) {
  let seed = 0;
  for (const ch of seedText) {
    seed = (seed * 31 + ch.codePointAt(0)) >>> 0;
  }
  const rBase = 64 + (seed % 160);
  const gBase = 64 + ((seed >>> 8) % 160);
  const bBase = 64 + ((seed >>> 16) % 160);

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    const shade = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3;
      const wave = x / Math.max(1, width - 1);
      const stripe = Math.floor(x / 32) % 2 === 0 ? 0 : -24;
      const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
      raw[i] = border ? 30 : Math.max(0, Math.min(255, rBase + wave * 48 + stripe));
      raw[i + 1] = border ? 30 : Math.max(0, Math.min(255, gBase + shade * 48 + stripe));
      raw[i + 2] = border ? 30 : Math.max(0, Math.min(255, bBase + (wave + shade) * 24));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size ?? ""));
  const clamp = (value) => Math.max(8, Math.min(MAX_DIMENSION, value));
  return match ? [clamp(Number(match[1])), clamp(Number(match[2]))] : [1024, 1024];
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on("data", (part) => parts.push(part));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });
}

async function readBody(req) {
  try {
    return JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

// images/edits が送る multipart/form-data を最小限パースする。
// テキストフィールドは fields、ファイルパートは files に入れる。
function parseMultipart(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^\s;]+))/.exec(contentType ?? "");
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};

  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    let segment = body.subarray(start + delimiter.length, next);
    if (segment.subarray(0, 2).toString("latin1") === "\r\n") {
      segment = segment.subarray(2);
    }
    if (segment.subarray(-2).toString("latin1") === "\r\n") {
      segment = segment.subarray(0, -2);
    }
    const headerEnd = segment.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headerText = segment.subarray(0, headerEnd).toString("utf8");
      const data = segment.subarray(headerEnd + 4);
      const name = /name="([^"]+)"/.exec(headerText)?.[1];
      if (name) {
        const filename = /filename="([^"]*)"/.exec(headerText)?.[1];
        if (filename !== undefined) {
          files[name] = { filename, data };
        } else {
          fields[name] = data.toString("utf8");
        }
      }
    }
    start = next;
  }
  return { fields, files };
}

const imageCache = new Map();

// プロンプト中のキーワード(slow/fail/url)を解釈しつつPNGを返す共通処理。
// seedExtra を変えると同じプロンプトでも別色の画像になる（編集元画像の区別用）。
function respondWithImage({ prompt, model, size, seedExtra = "" }, res) {
  const [width, height] = parseSize(size);

  const failMatch = /fail(?::(\d{3}))?/.exec(prompt);
  if (failMatch) {
    const status = Number(failMatch[1] ?? 500);
    sendJson(res, status, { error: { message: `dummy failure (${status})`, type: "dummy_error" } });
    return;
  }

  const respond = () => {
    const key = `${model}|${width}x${height}|${seedExtra}|${prompt}`;
    if (!imageCache.has(key)) {
      imageCache.set(key, makePng(width, height, key));
    }
    const png = imageCache.get(key);
    if (/url/.test(prompt)) {
      const id = encodeURIComponent(key);
      imageCache.set(id, png);
      sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ url: `http://${HOST}:${PORT}/image.png?seed=${id}`, revised_prompt: prompt }],
      });
    } else {
      sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: png.toString("base64"), revised_prompt: prompt }],
        usage: { total_tokens: 0 },
      });
    }
  };

  if (/slow/.test(prompt)) {
    setTimeout(respond, SLOW_MS);
  } else {
    respond();
  }
}

function handleImageGeneration(body, res) {
  const prompt = String(body.prompt ?? "");
  const model = String(body.model ?? "dummy");
  console.log(`[dummy-image] ${model} prompt=${JSON.stringify(prompt.slice(0, 120))}`);
  respondWithImage({ prompt, model, size: body.size }, res);
}

function handleImageEdit({ fields, files }, res) {
  const prompt = String(fields.prompt ?? "");
  const model = String(fields.model ?? "dummy");
  const source = files.image;
  if (!source) {
    sendJson(res, 400, { error: { message: "dummy: missing image part", type: "dummy_error" } });
    return;
  }
  // 編集元画像ごとに出力色が変わるよう、バイト列の簡易ハッシュをシードに混ぜる
  let hash = 0;
  for (const byte of source.data) {
    hash = (hash * 31 + byte) >>> 0;
  }
  console.log(
    `[dummy-image] edit ${model} image=${source.data.length}B prompt=${JSON.stringify(prompt.slice(0, 120))}`,
  );
  respondWithImage({ prompt, model, size: fields.size, seedExtra: `edit:${hash}` }, res);
}

function handleChatCompletions(body, res) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const text = typeof lastUser?.content === "string"
    ? lastUser.content
    : JSON.stringify(lastUser?.content ?? "");
  sendJson(res, 200, {
    id: "chatcmpl-dummy",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(body.model ?? "dummy"),
    choices: [{
      index: 0,
      message: { role: "assistant", content: `[dummy] ${text}` },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  console.log(`[dummy-image] ${req.method} ${url.pathname}`);

  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    sendJson(res, 200, {
      object: "list",
      data: [
        { id: "dummy-image-v1", object: "model", created: 0, owned_by: "dummy" },
        { id: "dummy-chat-v1", object: "model", created: 0, owned_by: "dummy" },
      ],
    });
    return;
  }

  if (req.method === "GET" && path === "/image.png") {
    const png = imageCache.get(url.searchParams.get("seed") ?? "");
    if (!png) {
      sendJson(res, 404, { error: { message: "unknown seed" } });
      return;
    }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    res.end(png);
    return;
  }

  if (req.method === "POST" && path.endsWith("/images/generations")) {
    handleImageGeneration(await readBody(req), res);
    return;
  }

  if (req.method === "POST" && path.endsWith("/images/edits")) {
    const parsed = parseMultipart(await readRawBody(req), req.headers["content-type"]);
    if (!parsed) {
      sendJson(res, 400, {
        error: { message: "dummy: expected multipart/form-data", type: "dummy_error" },
      });
      return;
    }
    handleImageEdit(parsed, res);
    return;
  }

  if (req.method === "POST" && path.endsWith("/chat/completions")) {
    handleChatCompletions(await readBody(req), res);
    return;
  }

  sendJson(res, 404, { error: { message: `dummy: no route for ${req.method} ${path}` } });
});

server.listen(PORT, HOST, () => {
  console.log(`[dummy-image] listening on http://${HOST}:${PORT}`);
  console.log(`[dummy-image] set the connection base URL to http://${HOST}:${PORT}/v1`);
});
