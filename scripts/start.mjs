import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const executable = resolve(
  "target",
  "release",
  process.platform === "win32" ? "kataru.exe" : "kataru",
);
if (!existsSync(executable)) {
  console.error("リリースバイナリがありません。先に npm run build:binary を実行してください。");
  process.exit(1);
}
const child = spawn(executable, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
