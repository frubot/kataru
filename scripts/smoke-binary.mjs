import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";

const executable = resolve(
  "target",
  "release",
  process.platform === "win32" ? "kataru.exe" : "kataru",
);
assert.ok(existsSync(executable), "リリースバイナリがありません。");

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise(server.address().port);
    });
  });
}

async function reservePort() {
  const server = createNetServer();
  const port = await listen(server);
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

const accessToken = "smoke-token-0123456789abcdef0123456789abcdef";
const authorization = { Authorization: `Bearer ${accessToken}` };

async function waitForHealth(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Kataru が終了しました: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${url}/api/health`, { headers: authorization });
      if (response.ok) return response.json();
    } catch {
      // 起動完了まで再試行します。
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Kataru の起動を確認できませんでした。");
}

async function postJson(url, value, origin) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(value),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

let lastUpstreamRequest;
const mockUpstreamApi = createServer(async (request, response) => {
  let requestBody = "";
  for await (const chunk of request) requestBody += chunk;
  lastUpstreamRequest = JSON.parse(requestBody);
  const schema = lastUpstreamRequest.response_format?.json_schema?.schema;
  // ベーシック（平文）は構造化出力を送らないので、応答も素の本文で返す。
  const content = schema?.properties?.messages
    ? JSON.stringify({ messages: ["Rust response"] })
    : schema
      ? JSON.stringify({ message: "Rust response" })
      : "Rust response";
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{
      message: {
        content,
      },
    }],
    usage: {
      prompt_tokens: 9,
      completion_tokens: 5,
      total_tokens: 14,
      cost: 0,
    },
  }));
});

const dataDirectory = await mkdtemp(join(process.cwd(), ".kataru-smoke-"));
const apiPort = await listen(mockUpstreamApi);
const applicationPort = await reservePort();
const applicationUrl = `http://127.0.0.1:${applicationPort}`;
let output = "";
const child = spawn(
  executable,
  [
    "--port",
    String(applicationPort),
    "--data-dir",
    dataDirectory,
    "--dev-origin",
    "http://127.0.0.1:3000",
    "--token",
    accessToken,
    "--no-open",
  ],
  {
    windowsHide: true,
    env: {
      ...process.env,
      OPENAI_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
      OPENAI_API_KEY: "smoke-test",
    },
  },
);
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

try {
  const health = await waitForHealth(applicationUrl, child);
  assert.equal(health.status, "ok");

  assert.ok(output.includes(`Kataru: ${applicationUrl}/?token=${accessToken}`), output);

  const unauthenticatedApi = await fetch(`${applicationUrl}/api/health`);
  assert.equal(unauthenticatedApi.status, 401);
  const unauthenticatedPage = await fetch(applicationUrl);
  assert.equal(unauthenticatedPage.status, 401);
  const wrongToken = await fetch(`${applicationUrl}/?token=wrong`, { redirect: "manual" });
  assert.equal(wrongToken.status, 401);

  const exchange = await fetch(`${applicationUrl}/?token=${accessToken}`, { redirect: "manual" });
  assert.equal(exchange.status, 303);
  const sessionCookie = exchange.headers.get("set-cookie")?.split(";")[0];
  assert.ok(sessionCookie?.startsWith(`kataru_session_${applicationPort}=`));
  assert.ok(!sessionCookie.includes(accessToken));

  const page = await fetch(applicationUrl, { headers: { Cookie: sessionCookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Kataru/);

  const rejectedOrigin = await fetch(`${applicationUrl}/api/storage`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:1",
    },
    body: JSON.stringify({ op: "get_all_characters" }),
  });
  assert.equal(rejectedOrigin.status, 403);

  const developmentOrigin = await postJson(`${applicationUrl}/api/storage`, {
    op: "get_all_characters",
  }, "http://127.0.0.1:3000");
  assert.deepEqual(developmentOrigin.result, []);

  await postJson(`${applicationUrl}/api/storage`, {
    op: "put_character",
    value: {
      id: "smoke-character",
      name: "Smoke",
      updatedAt: Date.now(),
    },
  }, applicationUrl);
  await postJson(`${applicationUrl}/api/storage`, {
    op: "put_room",
    value: {
      id: "smoke-room",
      characterId: "smoke-character",
      name: "Smoke room",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  }, applicationUrl);
  await postJson(`${applicationUrl}/api/storage`, {
    op: "put_message",
    room_id: "smoke-room",
    value: {
      id: "smoke-user-message",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    },
  }, applicationUrl);
  const storedMessages = await postJson(`${applicationUrl}/api/storage`, {
    op: "get_messages_by_room",
    room_id: "smoke-room",
  }, applicationUrl);
  assert.equal(storedMessages.result[0].content, "Hello");

  const turn = await postJson(`${applicationUrl}/api/conversation/turn`, {
    room: {
      id: "smoke-room",
      name: "Smoke room",
      viewMode: "chat",
      messages: [],
    },
    character: {
      id: "smoke-character",
      name: "Smoke",
      systemPrompt: "You are a test character.",
      protagonistPrompt: "",
      maxCharacters: 256,
      maxHistory: 7,
      enableMemory: false,
    },
    chatModel: "mock-model",
    conversationCompressionEnabled: false,
    messages: [{
      id: "smoke-user-message",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
      archived: false,
    }],
    aiApiConfig: {
      aiApiType: "openai-compatible",
    },
  }, applicationUrl);
  assert.equal(turn.messages[0].content, "Rust response");
  assert.equal(turn.usages[0].totalTokens, 14);
  // ベーシックは平文生成なので、構造化出力を送らず本文をそのまま返す。
  assert.equal(turn.fullJsonLogs[0].source, "assistant-text");
  assert.equal(lastUpstreamRequest.max_tokens, 2048);
  assert.equal(lastUpstreamRequest.response_format, undefined);
  const sentPrompt = JSON.parse(turn.fullJsonLogs[0].prompt);
  assert.equal(sentPrompt[0].role, "system");
  assert.equal(sentPrompt.at(-1).content, "Hello");
  // プロンプトは英語に統一されたため、平文モードの見出しとJSON指示の不在で判定する。
  assert.match(sentPrompt[0].content, /## Response format/);
  assert.doesNotMatch(sentPrompt[0].content, /Please generate the output in JSON format/);
  assert.doesNotMatch(sentPrompt[0].content, /## Format within the message field/);

  // メッセージモードは今までどおり構造化出力（messages配列）を使う。
  const messageTurn = await postJson(`${applicationUrl}/api/conversation/turn`, {
    room: {
      id: "smoke-room",
      name: "Smoke room",
      viewMode: "message",
      messages: [],
    },
    character: {
      id: "smoke-character",
      name: "Smoke",
      systemPrompt: "You are a test character.",
      protagonistPrompt: "",
      maxCharacters: 256,
      maxHistory: 7,
      enableMemory: false,
    },
    chatModel: "mock-model",
    conversationCompressionEnabled: false,
    messages: [{
      id: "smoke-user-message",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
      archived: false,
    }],
    aiApiConfig: {
      aiApiType: "openai-compatible",
    },
  }, applicationUrl);
  assert.equal(messageTurn.messages[0].content, "Rust response");
  assert.equal(messageTurn.fullJsonLogs[0].source, "assistant-json");
  assert.equal(
    lastUpstreamRequest.response_format.json_schema.schema.properties.messages.items.maxLength,
    256,
  );

  const database = await stat(join(dataDirectory, "kataru.db"));
  assert.ok(database.size > 0);
  console.log(`Smoke test passed (${health.version}, ${database.size} byte SQLite).`);
} catch (error) {
  if (output.trim()) console.error(output.trim());
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
    child.kill();
    await exited;
  }
  mockUpstreamApi.closeAllConnections();
  await new Promise((resolvePromise) => mockUpstreamApi.close(resolvePromise));
  await rm(dataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
