---
name: kataru-release
description: Kataruのリリースを安全に準備・公開する。Cargo.tomlとCargo.lockのバージョン更新、SemVer判定、リリース前検証、コミット、vX.Y.Zタグ、originへのpush、GitHub ActionsとGitHub Releaseの確認が必要なときに使用する。
---

# Kataru Release

Kataruのバージョンを一度だけ更新し、ローカル検証を通してからGitHub Releaseを公開する。`Cargo.toml`の`package.version`を唯一の正とする。

## 安全規則

- 最初にリポジトリの`AGENTS.md`を読む。
- ユーザーの未コミット変更をリリースへ混入させない。開始時にworktreeがdirtyなら停止し、対象ファイルを報告する。stash、reset、checkoutで変更を退避・破棄しない。
- 通常は`master`からリリースする。別ブランチからの公開はユーザーが明示した場合だけ行う。
- 既存タグを上書き、移動、削除しない。`--force`を使わない。
- 検証が1つでも失敗したらコミット、タグ、pushへ進まない。
- ユーザーがリリースを依頼した場合、必要なcommit、tag、push、CI確認は依頼範囲内として実行する。バージョンの意図が曖昧で安全に決められない場合だけ確認する。

## 1. 状態を確認する

次を確認する。

```powershell
git status --short
git branch --show-current
git remote -v
git fetch origin master --tags
git tag --sort=-v:refname
git log --oneline --decorate -20
```

`origin`がGitHubの`frubot/kataru`リポジトリを指すことを確認する。HTTPSとSSHのどちらのURLも許可する。`master`と`origin/master`の差分を確認し、remoteだけにある未取得コミットや履歴の分岐があれば停止する。ローカルが先行している場合は、そのコミット群が今回のリリース対象であることを履歴から確認する。

## 2. リリースバージョンを決める

`Cargo.toml`の`[package].version`と最新の安定版タグを比較する。バージョンとタグは3要素の`X.Y.Z` / `vX.Y.Z`に限定する。

- ユーザーが具体的なバージョンを指定した場合は、その値を使う。
- ユーザーがmajor、minor、patchを指定した場合は、最新リリース済みバージョンを基準にSemVer更新する。
- 指定がない場合はpatch更新を既定とする。
- `Cargo.toml`のバージョンに対応するタグがまだなく、かつ最新タグより新しい場合は、その値をリリース待ちのバージョンとして使う。さらに1段階上げない。
- 指定値が最新タグ以下、既存タグと重複、または`Cargo.toml`より低い場合は停止する。
- prereleaseやbuild metadataは、このプロジェクトの更新処理が想定していないため使わない。

対象コミットを`git log <latest-tag>..HEAD --oneline`で確認し、変更内容に対して明らかに不適切なmajor/minor/patch指定なら、編集前に懸念を伝える。

## 3. バージョンを更新する

`Cargo.toml`の`[package].version`と、`Cargo.lock`内のroot package `kataru`の`version`だけを同じ値へ編集する。すでに対象バージョンなら編集しない。依存packageのバージョンを変更しない。

次を確認する。

- `Cargo.toml`と`Cargo.lock`の`kataru`バージョンが一致する。
- バージョン更新による差分は原則としてこの2ファイルだけである。
- `npm run check:release-version -- vX.Y.Z`が成功する。

予期しないlockfile変更が出た場合は公開せず、原因を調べる。

## 4. CI相当の検証を通す

依存関係が未導入なら`npm ci`を実行する。`out/`はRustEmbedに必要なため、frontend buildをRust検査より先に置く。

```powershell
npm run lint
npx tsc --noEmit
npm run build
cargo test --locked
cargo clippy --all-targets --locked -- -D warnings
npm run build:binary
npm run smoke:binary
npm run check:release-version -- vX.Y.Z
```

WindowsのサンドボックスでViteまたはRust release buildが権限エラーになった場合は、同じコマンドを承認付きでサンドボックス外から再実行する。検証内容を省略して成功扱いにしない。

## 5. リリースコミットとタグを作る

公開直前に`git status --short`と`git diff --check`を再確認する。

バージョン差分が未コミットなら、対象ファイルだけをstageしてコミットする。

```powershell
git add Cargo.toml Cargo.lock
git commit -m "Release vX.Y.Z"
```

対象バージョンがすでにコミット済みなら空コミットを作らない。いずれの場合も、HEADの`Cargo.toml`が対象バージョンであり、worktreeがcleanであることを確認する。

このリポジトリの既存形式に合わせ、HEADへlightweight tagを作る。

```powershell
git tag vX.Y.Z
git show --no-patch --decorate vX.Y.Z
```

タグがHEADを指すことと、同名タグがremoteに存在しないことを確認する。

## 6. 公開する

ブランチとタグをatomic pushし、片方だけが公開される状態を避ける。

```powershell
git push --atomic origin master vX.Y.Z
```

push後、タグで起動した`.github/workflows/build.yml`をrelease commitのSHAからGitHub CLIで特定し、`headBranch`が`vX.Y.Z`のrunを完了まで監視する。

```powershell
gh run list --workflow build.yml --commit <release-commit-sha> --event push --limit 5 --json databaseId,headBranch,headSha,status,conclusion,url
gh run watch <run-id> --exit-status
gh release view vX.Y.Z --json url,isDraft,isPrerelease,assets
```

Releaseが公開済みでdraftでもprereleaseでもなく、Windows x64、Linux x64、macOS arm64のarchiveと自動更新用binaryが揃っていることを確認する。

## 7. 結果を報告する

次を簡潔に報告する。

- 旧バージョンから新バージョンへの変更
- リリースコミットとタグ
- 実行した検証と結果
- GitHub Actionsの結果
- GitHub ReleaseのURLと成果物

push後にCIが失敗した場合は、失敗したjobと原因を報告して停止する。既存タグを移動・削除して修正を公開し直さない。transient failureのrerunまたは新バージョンでの修正が必要かをユーザーに確認する。
