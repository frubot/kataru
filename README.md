# Kataru

Kataruは、キャラクターとの会話や複数キャラクターによるシチュエーションを楽しめるロールプレイチャットアプリです。

OpenRouter、OpenAI互換API、Anthropic APIを利用できます。

## 主な機能

- キャラクターごとにフォルダ分けされたUI、モデル、パラメータ設定
- 表情差分、衣装差分の登録・生成
- ベーシック、メッセージ、ゲームの3種類の表示モード
- 複数キャラクターと会話を楽しめるシチュエーション
- 指揮モデルによる会話の自動進行
- 長い会話を扱うための要約と、関連情報を参照する長期メモリ
- トークン数・コストの使用統計
- 会話、要約、メモリ、使用量を保存しないシークレットモード
- ライト／ダークモードとカラーパレット

## 必要なもの

- Node.js 20.19以降
- npm
- Rustのstable toolchain（Cargoを含む）
- OpenRouter/OpenAI/AnthropicのAPIキー、または起動済みの互換APIサーバー

## セットアップ

依存関係をインストールします。

```bash
npm install
```

### OpenRouterを使う場合

接続先の初期値はOpenRouterです。「設定」→「モデル」でAPIキーを保存できます。APIキーはOSの資格情報ストアへ保存されます。

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

「設定」→「モデル」で「OpenAI / 互換API」を選び、APIキーやエンドポイントを設定できます。

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

- 互換エンドポイントでキーを省略した場合は互換性のため`local`が送信されます。
- embeddingsと画像生成は設定画面から有効化できますが、利用するサービス側が対応していない場合があります。

### Anthropicまたは互換APIを使う場合

「設定」→「モデル」で「Anthropic / 互換API」を選び、APIキーとエンドポイントを設定できます。Kataru内部の会話リクエストと応答はサーバー側でMessages API形式へ変換されます。

CLIから設定する場合:

```bash
kataru config set anthropic.api-key
kataru config set anthropic.base-url https://api.anthropic.com/v1
```

環境変数には`ANTHROPIC_API_KEY`と`ANTHROPIC_BASE_URL`を利用できます。モデル設定には`claude-...`形式など、接続先で有効なモデルIDを指定してください。Anthropicプロバイダーではテキスト生成と構造化出力を利用でき、embeddingsと画像生成は無効になります。

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

バイナリのスモークテストは次のコマンドで実行できます。

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

アプリの「設定」→「一般」→「アップデートを確認」を押すと、最新バージョンを確認します。新しいバージョンがある場合は、SHA-256を検証して自動インストールし、Kataruを再起動します。

コマンドラインから確認・更新する場合:

```bash
kataru update
```

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

- 待受先は`--host`で指定できます。
- Hostヘッダーと、状態を変更するリクエストのOriginを検証します。
- APIキーは環境変数またはOSの資格情報ストアから取得します。
- エンドポイントはサーバー専用の`server-config.json`へ保存し、ブラウザからAIリクエストに指定されたURLは使用しません。
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
src/ai/              OpenRouter／OpenAI互換／Anthropic APIとの通信
src/conversation/    会話生成、要約、指揮役、メモリ処理
src/db/              SQLiteとストレージコマンド
migrations/          SQLiteマイグレーション
scripts/             開発、起動、スモークテスト用スクリプト
```

## ライセンス

[MIT License](LICENSE)
