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

async function waitForHealth(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Kataru が終了しました: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${url}/api/health`);
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
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(value),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

const mockProvider = createServer(async (request, response) => {
  let requestBody = "";
  for await (const chunk of request) requestBody += chunk;
  JSON.parse(requestBody);
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({ message: "Rust response" }),
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
const providerPort = await listen(mockProvider);
const applicationPort = await reservePort();
const applicationUrl = `http://127.0.0.1:${applicationPort}`;
let output = "";
const child = spawn(
  executable,
  [
    "--no-open",
    "--port",
    String(applicationPort),
    "--data-dir",
    dataDirectory,
    "--dev-origin",
    "http://127.0.0.1:3000",
  ],
  {
    windowsHide: true,
    env: {
      ...process.env,
      OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      OPENAI_COMPAT_API_KEY: "smoke-test",
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

  const page = await fetch(applicationUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Kataru/);

  const rejectedOrigin = await fetch(`${applicationUrl}/api/storage`, {
    method: "POST",
    headers: {
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
      model: "mock-model",
      maxTokens: 256,
      maxHistory: 7,
      enableSummary: false,
      enableMemory: false,
      thinkModeEnabled: false,
    },
    messages: [{
      id: "smoke-user-message",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
      archived: false,
    }],
    aiProviderConfig: {
      aiProvider: "openai-compatible",
    },
  }, applicationUrl);
  assert.equal(turn.messages[0].content, "Rust response");
  assert.equal(turn.usages[0].totalTokens, 14);
  assert.equal(turn.fullJsonLogs[0].source, "assistant-json");
  const sentPrompt = JSON.parse(turn.fullJsonLogs[0].prompt);
  assert.equal(sentPrompt[0].role, "system");
  assert.equal(sentPrompt.at(-1).content, "Hello");

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
  mockProvider.closeAllConnections();
  await new Promise((resolvePromise) => mockProvider.close(resolvePromise));
  await rm(dataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
