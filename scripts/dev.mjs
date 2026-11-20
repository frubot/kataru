import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";

// `node scripts/dev.mjs desktop` ではブラウザの代わりに開発用のデスクトップ版を起動する。
const serverScript = process.argv[2] === "desktop" ? "dev:server:desktop" : "dev:server";
const UI_HOST = "127.0.0.1";
const UI_PORT = 3000;
const UI_WAIT_TIMEOUT_MS = 30_000;

function runNpm(script, { stdin = "inherit" } = {}) {
  const stdio = [stdin, "inherit", "inherit"];
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", `npm.cmd run ${script}`], { stdio });
  }

  return spawn("npm", ["run", script], { stdio });
}

// Windowsでは`child.kill()`がcmd.exeのみを終了させ、npmやVite等の子孫プロセスが残るため、プロセスツリーごと終了させる。
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill();
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
    killTree(child);
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
// stdinを渡すとViteがキー操作の受付のために端末を占有し、取り残された場合に端末の入力を奪うため渡さない。
track(runNpm("dev:ui", { stdin: "ignore" }));
if (await waitForPort(UI_HOST, UI_PORT, UI_WAIT_TIMEOUT_MS)) {
  track(runNpm(serverScript));
} else if (!stopping) {
  console.error(`Vite開発サーバー（http://${UI_HOST}:${UI_PORT}）が起動しませんでした。`);
  stop(1);
}
