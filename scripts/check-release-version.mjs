import { readFile } from 'node:fs/promises';

const manifest = await readFile(new URL('../Cargo.toml', import.meta.url), 'utf8');
const lines = manifest.split(/\r?\n/);
const packageSectionStart = lines.findIndex((line) => line.trim() === '[package]');

if (packageSectionStart === -1) {
  throw new Error('Cargo.toml に [package] セクションがありません。');
}

let packageVersion;
for (const line of lines.slice(packageSectionStart + 1)) {
  if (line.trimStart().startsWith('[')) break;

  const match = line.match(/^\s*version\s*=\s*"([^"]+)"\s*$/);
  if (match) {
    packageVersion = match[1];
    break;
  }
}

if (!packageVersion) {
  throw new Error('Cargo.toml の package.version を取得できませんでした。');
}

const releaseTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!releaseTag) {
  console.log(`Kataru version: ${packageVersion}`);
  process.exit(0);
}

const expectedTag = `v${packageVersion}`;
if (releaseTag !== expectedTag) {
  throw new Error(
    `リリースタグ ${releaseTag} と Cargo.toml のバージョン ${packageVersion} が一致しません。`
    + ` 期待するタグは ${expectedTag} です。`,
  );
}

console.log(`Release version verified: ${releaseTag}`);
