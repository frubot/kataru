import { spawn } from "node:child_process";
import { connect } from "node:net";

// `node scripts/dev.mjs desktop` ではブラウザの代わりに開発用のデスクトップ版を起動する。
const serverScript = process.argv[2] === "desktop" ? "dev:server:desktop" : "dev:server";
const UI_HOST = "127.0.0.1";
const UI_PORT = 3000;
const UI_WAIT_TIMEOUT_MS = 30_000;

function runNpm(script) {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", `npm.cmd run ${script}`], {
      stdio: "inherit",
    });
  }

  return spawn("npm", ["run", script], { stdio: "inherit" });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopping) return false;
    if (await canConnect(host, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const children = [];
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

function track(child) {
  children.push(child);
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

// サーバーは起動直後に画面を開くため、Viteが応答するようになってから起動する。
track(runNpm("dev:ui"));
if (await waitForPort(UI_HOST, UI_PORT, UI_WAIT_TIMEOUT_MS)) {
  track(runNpm(serverScript));
} else if (!stopping) {
  console.error(`Vite開発サーバー（http://${UI_HOST}:${UI_PORT}）が起動しませんでした。`);
  stop(1);
}
