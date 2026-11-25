import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ビルドしたリリースバイナリを、プロジェクト外の固定の場所へ配置する。
//
// プロジェクト内のビルド成果物は、作業フォルダに設定された整合性ラベル（Codexのサンドボックスが
// 付与するLow）を継承することがある。Lowのラベルが付いた実行ファイルはLow整合性のプロセスとして
// 起動され、データ保存先へ書き込めずにSQLiteが「unable to open database file」で失敗する。
// コピーしたファイルはコピー先のフォルダの設定を継承するため、この問題を避けられる。
const isWindows = process.platform === "win32";
const fileName = isWindows ? "kataru.exe" : "kataru";
const source = resolve("target", "release", fileName);
const installDirectory = isWindows
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Kataru")
  : join(homedir(), ".local", "bin");
const destination = join(installDirectory, fileName);
const temporary = `${destination}.${process.pid}.tmp`;

if (!existsSync(source)) {
  console.error("リリースバイナリがありません。先に npm run build:binary を実行してください。");
  process.exit(1);
}

mkdirSync(installDirectory, { recursive: true });
try {
  // 一時ファイルへ書き出してから置き換え、途中で失敗しても既存のバイナリを壊さない。
  copyFileSync(source, temporary);
  renameSync(temporary, destination);
} catch (error) {
  rmSync(temporary, { force: true });
  if (error.code === "EBUSY" || error.code === "EPERM") {
    console.error(`${destination} を置き換えられませんでした。Kataruを終了してから再実行してください。`);
  } else {
    console.error(error);
  }
  process.exit(1);
}
console.log(`${destination} を更新しました。`);
