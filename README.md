# Kataru

Kataruは、キャラクターとの会話や複数キャラクターによるシチュエーションを楽しむための、ローカルファーストなロールプレイチャットアプリです。

ReactとViteで構築したUIをRust/Axumサーバーから配信し、キャラクター、会話履歴、メモリ、使用量などをローカルのSQLiteデータベースへ保存します。AI接続先にはOpenRouterまたはOpenAI互換APIを利用できます。

## 主な機能

- キャラクターごとのプロンプト、モデル、生成パラメータ設定
- アバター、表情差分、衣装差分の登録・生成
- ベーシック、メッセージ、ゲームの3種類の表示モード
- 複数キャラクターと一時キャラクターを組み合わせたシチュエーション
- 指揮役モデルによる発言者選択と会話の自動進行
- 長い会話を扱うための要約と、関連情報を参照する長期メモリ
- トークン数・コストの使用統計とデバッグログ
- JSON形式のバックアップ、マージ、復元
- 会話、要約、メモリ、使用量を保存しないシークレットモード
- ライト／ダーク表示とカラーパレット

## 必要なもの

- Node.js 20.19以降
- npm
- Rustのstable toolchain（Cargoを含む）
- OpenRouterのAPIキー、または起動済みのOpenAI互換APIサーバー

## セットアップ

依存関係をインストールします。

```bash
npm install
```

### OpenRouterを使う場合

接続先の初期値はOpenRouterです。起動後に「設定」→「モデル」でAPIキーを保存できます。APIキーはブラウザやSQLiteには保存されず、OSの資格情報ストアへ保存されます。

CLIから設定する場合:

```bash
kataru config set openrouter.api-key
```

開発中にCargoから実行する場合は`kataru`を`cargo run --`に置き換えます。従来どおり環境変数も利用できます。

PowerShell:

```powershell
$env:OPENROUTER_API_KEY = "your-api-key"
npm run dev
```

bash:

```bash
export OPENROUTER_API_KEY="your-api-key"
npm run dev
```

ブラウザで <http://127.0.0.1:3000> を開いてください。

### OpenAIまたは互換APIを使う場合

OpenAIの既定base URLは`https://api.openai.com/v1`です。起動後に「設定」→「モデル」で「OpenAI / 互換API」を選び、APIキーやbase URLを設定できます。

CLIから設定する場合:

```bash
kataru config set openai.api-key
kataru config set openai.base-url http://127.0.0.1:1234/v1
```

環境変数を使う場合:

PowerShell:

```powershell
$env:OPENAI_BASE_URL = "http://127.0.0.1:1234/v1"
$env:OPENAI_API_KEY = "your-api-key"
npm run dev
```

bash:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:1234/v1"
export OPENAI_API_KEY="your-api-key"
npm run dev
```

- `OPENAI_COMPAT_BASE_URL`と`OPENAI_COMPAT_API_KEY`も移行用の非推奨エイリアスとして利用できます。
- OpenAI公式base URLではAPIキーが必須です。カスタムbase URLでキーを省略した場合は互換性のため`local`が送信されます。
- embeddingsと画像生成は設定画面から個別に有効化できます。利用するAPIサーバーが対応するエンドポイントを実装している必要があります。
- 保存済みAPIキーはbase URLに紐づきます。接続先を変更すると以前のキーは解除され、新しい接続先へ流用されません。

Rustサーバーは`.env`ファイルを自動では読み込みません。環境変数はシェルまたはプロセスマネージャーで設定してください。環境変数はCLI／Web UIで保存した値より優先され、Web UIからは変更できません。

## 開発

```bash
npm run dev
```

このコマンドは次の2プロセスを起動します。

- Vite開発サーバー: <http://127.0.0.1:3000>
- Rust APIサーバー: <http://127.0.0.1:37371>

Vite開発サーバーは`/api/*`をRust APIサーバーへ転送します。

### 確認コマンド

```bash
npm run lint
npx tsc --noEmit
cargo test
cargo clippy --all-targets -- -D warnings
```

静的UIだけをビルドする場合:

```bash
npm run build
```

生成物は`out/`へ出力されます。

## 単体バイナリのビルド

Viteの静的出力を埋め込んだリリースバイナリを作成します。

```bash
npm run build:binary
```

生成先:

- Windows: `target/release/kataru.exe`
- macOS / Linux: `target/release/kataru`

ビルド済みバイナリは次のコマンドでも起動できます。

```bash
npm start
```

起動してもブラウザは自動では開きません。ブラウザで <http://127.0.0.1:37371> を開いて使用してください。バイナリのスモークテストは次のコマンドで実行できます。

```bash
npm run smoke:binary
```

### 起動オプション

```text
version, --version, -V 現在のバージョンを表示
update                最新版を確認し、利用可能なら自動インストール
config                AI接続設定を表示・変更
--host <HOST>         待受ホスト（既定: 127.0.0.1）
--port <PORT>         待受ポート（既定: 37371）
--data-dir <PATH>     データ保存先
--portable            実行ファイル横の kataru-data/ を使用
--open                ブラウザを自動で開く
--dev-origin <ORIGIN> 開発UI用のloopbackオリジンを許可
```

AI接続設定の確認と削除:

```bash
kataru config show
kataru config get openai.base-url
kataru config unset openai.api-key
```

CLIで変更した設定は次回起動時に読み込まれます。Kataruがすでに起動している場合は再起動してください。Web UIからの変更は直ちに反映されます。

例:

```bash
npm start -- --portable
```

### アップデート

アプリの「設定」→「一般」→「アップデートを確認」を押すと、GitHub Releasesの最新安定版を確認します。新しいバージョンがある場合は、SHA-256を検証して自動インストールし、Kataruを再起動します。

コマンドラインから確認・更新する場合:

```powershell
.\kataru.exe update
```

自動更新には、実行ファイルが置かれているフォルダーへの書き込み権限が必要です。

### リリースバージョン

アプリのバージョンは`Cargo.toml`の`package.version`を正とします。設定画面、`version`コマンド、更新確認APIはいずれもこの値を使用します。バージョンを変更した後は`cargo test`を実行し、更新された`Cargo.lock`もコミットしてください。

リリースタグは`v<package.version>`の形式で作成します。タグ付きビルドではCIがタグと`Cargo.toml`の一致を検証します。ローカルでも次のコマンドで確認できます。

```bash
npm run check:release-version -- vX.Y.Z
```

## データとバックアップ

通常はOSのユーザーデータディレクトリ内に`kataru.db`を作成します。保存先を明示したい場合は`--data-dir`、実行ファイルと一緒に持ち運びたい場合は`--portable`を使用してください。

アプリの「設定」→「一般」→「バックアップ」から、キャラクター、シチュエーション、ルーム、メッセージ、メモリ、使用記録をJSONとして書き出せます。インポート時は、現在のデータへの追加または全置換を選択できます。

シークレットモードのルームとその会話、要約、メモリ、使用量はSQLiteやバックアップへ保存されません。ページを閉じると復元できないためご注意ください。

## セキュリティ

- サーバーの待受先は`--host`で指定できます。
- Hostヘッダーと、状態を変更するリクエストのOriginを検証します。
- APIキーはサーバー環境変数またはOSの資格情報ストアから取得し、SQLiteやブラウザの設定には保存しません。
- base URLはサーバー専用の`server-config.json`へ保存し、ブラウザからAIリクエストに指定されたURLは使用しません。
- Web UIからのAI接続設定変更はloopback接続と許可済みOriginに限定します。

注意: Kataruは外部公開を想定していません。 `--host 0.0.0.0`や`--host ::`でネットワークからアクセス可能にする場合はアクセス元を制限し、インターネットへ直接公開しないでください。

## プロジェクト構成

```text
App.tsx              Reactアプリのルートコンポーネント
main.tsx             Reactアプリのエントリーポイント
index.html           Viteが使用するHTML
vite.config.ts       Viteビルドと開発用APIプロキシの設定
styles/              グローバルスタイル
components/          チャット、設定、キャラクター編集などのUI
lib/                 状態管理、APIクライアント、バックアップ処理
src/main.rs          Axumサーバー、ルーティング、アクセス保護
src/ai_config.rs     CLI／Web UI向けのサーバーAI接続設定
src/ai/              OpenRouter／OpenAI互換APIとの通信
src/conversation/    会話生成、要約、指揮役、メモリ処理
src/db/              SQLiteとストレージコマンド
migrations/          SQLiteマイグレーション
scripts/             開発、起動、スモークテスト用スクリプト
```

## ライセンス

[MIT License](LICENSE)
