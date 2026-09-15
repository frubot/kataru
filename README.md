# Kataru

Kataruは、AIキャラクターとの1対1の会話や、複数キャラクターが織りなすシチュエーションを楽しめる、ローカルファーストなロールプレイチャットアプリです。

OpenRouter、OpenAI互換API、Anthropic APIに対応しています。

## 主な機能

- **柔軟なキャラクター管理**: フォルダ分けによる整理、モデルやプロンプト、生成パラメータの個別設定
- **表情・衣装の差分管理**: 立ち絵の登録やAIによる画像生成
- **3Dアバター（VRM）対応**: VRM 0.x / 1.0 の3Dアバターを衣装として登録し、ゲームモードで表示・操作
- **3種類の表示モード**: ベーシック、メッセージ（チャット風）、ゲーム（ビジュアルノベル風）
- **シチュエーション会話**: 複数キャラクターが参加するグループ会話
- **指揮役（オーケストレーター）モデル**: 発言順や会話の展開をAIが自律的に制御
- **長期記憶と自動要約**: 長期記憶（メモリ）の参照と会話履歴の自動要約により、長期的な文脈を維持
- **使用統計**: トークン消費量や利用コストの可視化
- **シークレットモード**: 会話履歴、要約、メモリ、使用量を一切保存しない一時利用モード
- **テーマ設定**: ライト / ダークモードの切り替えとカラーパレットのカスタマイズ

## 動作要件

- Node.js 20.19 以降
- npm
- Rust stable ツールチェーン（Cargo を含む）
- OpenRouter / OpenAI / Anthropic いずれかのAPIキー、またはローカル等で稼働中の互換APIサーバー

## セットアップ

まずは依存関係をインストールします。

```bash
npm install
```

### AI接続先の設定

#### 1. OpenRouter を使う場合

デフォルトの接続先です。「設定」→「モデル」からAPIキーを登録できます（キーはOSの資格情報ストアに安全に保管されます）。また、「使用しないプロバイダー」一覧から特定のプロバイダーをルーティング対象外に指定することも可能です。

CLIから設定する場合:

```bash
kataru config set openrouter.api-key
```

※開発中にCargoから実行する場合は `kataru` を `cargo run --` に置き換えてください。

環境変数で指定する場合:

- **PowerShell**:
  ```powershell
  $env:OPENROUTER_API_KEY = "your-api-key"
  npm run dev
  ```
- **bash**:
  ```bash
  export OPENROUTER_API_KEY="your-api-key"
  npm run dev
  ```

起動後、ブラウザで <http://127.0.0.1:3000> を開きます。

#### 2. OpenAI または互換API を使う場合

OpenAI や LM Studio、Ollama、vLLM などを利用する場合は、「設定」→「モデル」で「OpenAI / 互換API」を選択し、APIキーとエンドポイントを設定します。

CLIから設定する場合:

```bash
kataru config set openai.api-key
kataru config set openai.base-url http://127.0.0.1:1234/v1
```

環境変数で指定する場合:

- **PowerShell**:
  ```powershell
  $env:OPENAI_BASE_URL = "http://127.0.0.1:1234/v1"
  $env:OPENAI_API_KEY = "your-api-key"
  npm run dev
  ```
- **bash**:
  ```bash
  export OPENAI_BASE_URL="http://127.0.0.1:1234/v1"
  export OPENAI_API_KEY="your-api-key"
  npm run dev
  ```

- ローカル等の互換エンドポイントでAPIキーを省略した場合、互換性維持のためダミーキー `local` が自動送信されます。
- Embeddingsや画像生成は設定画面から有効化できます。利用するには接続先サーバー側の対応が必要です。

#### 3. Anthropic または互換API を使う場合

「設定」→「モデル」で「Anthropic / 互換API」を選択し、APIキーとエンドポイントを設定します。Kataru内部のリクエストおよびレスポンスは、サーバー側で自動的に Messages API 形式に相互変換されます。

CLIから設定する場合:

```bash
kataru config set anthropic.api-key
kataru config set anthropic.base-url https://api.anthropic.com/v1
```

環境変数で指定する場合:
`ANTHROPIC_API_KEY` と `ANTHROPIC_BASE_URL` が利用可能です。

- モデルIDには `claude-...` など、接続先で有効な識別子を指定してください。
- Anthropic API ではテキスト生成と構造化出力に対応しています。Embeddingsおよび画像生成には非対応です。

## 開発

```bash
npm run dev
```

このコマンドを実行すると、以下の2つのプロセスが同時に立ち上がります。

- **Vite開発サーバー**: <http://127.0.0.1:3000>
- **Rust APIサーバー**: <http://127.0.0.1:37371>

Vite開発サーバーへの `/api/*` リクエストは、Rust APIサーバーへ自動的にリバースプロキシされます。

### テスト・静的チェック

```bash
npm run lint
npx tsc --noEmit
cargo test
cargo clippy --all-targets -- -D warnings
```

フロントエンドの静的ファイルのみをビルドする場合は以下を実行します。成果物は `out/` に出力されます。

```bash
npm run build
```

## 単一バイナリのビルド

フロントエンドの静的アセットを内包した、配布・実行用のリリースバイナリをビルドします。

```bash
npm run build:binary
```

ビルド成果物の出力先:

- **Windows**: `target/release/kataru.exe`
- **macOS / Linux**: `target/release/kataru`

ビルド済みバイナリの起動:

```bash
npm start
```

バイナリのスモークテスト:

```bash
npm run smoke:binary
```

### 起動オプション・CLIコマンド

```text
version, --version, -V 現在のバージョンを表示
update                最新バージョンを確認し、利用可能なら自動更新
config                AI接続設定の確認・変更
models                モデル一覧キャッシュの更新
--host <HOST>         リッスンホスト（デフォルト: 127.0.0.1）
--port <PORT>         リッスンポート（デフォルト: 37371）
--data-dir <PATH>     データ保存先ディレクトリ
--portable            実行ファイルと同じ階層の kataru-data/ を使用
--open                起動時にブラウザを自動で開く
--dev-origin <ORIGIN> 開発用UIのloopbackオリジンを許可
```

#### AI接続設定の確認・削除

```bash
kataru config show
kataru config get openai.base-url
kataru config unset openai.api-key
```

#### モデル一覧キャッシュの更新

取得したモデル一覧は、データディレクトリ内の `model-cache.json` にキャッシュされます。Web UIの各モデル選択欄にある「モデル一覧を再取得」ボタン、またはCLIから手動更新できます。

```bash
kataru models refresh              # 設定済みの全プロバイダーを更新
kataru models refresh openrouter   # OpenRouter のみ更新
```

> **Note**: CLIによる設定変更は次回起動時に反映されます（すでに起動中の場合はアプリを再起動してください）。Web UIからの設定変更は即座に反映されます。

ポータブルモードでの起動例:

```bash
npm start -- --portable
```

### アプリのアップデート

- **Web UI**: 「設定」→「一般」→「アップデートを確認」をクリックすると最新版の有無をチェックします。更新がある場合は SHA-256 チェックサムを検証した上で自動インストールし、Kataruを再起動します。
- **CLI**: コマンドラインからも同様にアップデートできます。
  ```bash
  kataru update
  ```

### リリースバージョン管理

アプリのバージョンは `Cargo.toml` の `package.version` が正本となります。設定画面、`version` コマンド、更新確認APIはすべてこの値を参照します。バージョンを変更した際は `cargo test` を実行し、同期更新された `Cargo.lock` もあわせてコミットしてください。

Gitのリリースタグは `v<package.version>` 形式（例: `v0.8.4`）で付与します。CI環境でタグと `Cargo.toml` の整合性が自動検証されるほか、ローカルでも以下のコマンドで検証できます。

```bash
npm run check:release-version -- vX.Y.Z
```

## データ管理とバックアップ

### 3Dアバター（VRM）の利用

キャラクター設定の「衣装・アバター」→「3D（VRM）」からVRMファイルを登録できます。

- **対応形式**: VRM 0.x / 1.0（テクスチャ内包、1ファイルあたり最大50MBまで）
- **機能・表現**: 待機モーション、自動まばたき、揺れもの物理、会話内容に応じた表情の自動切り替えに対応。「調整」パネルから表情の割り当てや初期プレビューを細かくカスタマイズできます。
- **ゲームモードでの操作**:
  - アバターのドラッグ: 表示位置の移動
  - マウスホイール: 拡大・縮小
  - ダブルクリック（またはダブルタップ）: 表示位置・サイズの初期化（移動・拡縮後は右上にリセットボタンも表示されます）
  - これらの操作は画面上の表示一時調整であり、キャラクター設定に保存されている基準位置や向きには影響しません。
- **制限事項**: VRMファイル1つを1つの衣装として扱います。モデル内の衣装着脱、リップシンク（口パク）、外部モーションファイル（VMD等）の読み込みには対応していません。
- **データの保持と通信**: VRMファイルはローカルのSQLiteに安全に保存されます。会話APIにはモデルファイルそのものは送信されず、利用可能な表情名のみがプロンプトとして渡されます。
- **共有とバックアップ**: キャラクターをエクスポートする際、VRMモデルを同梱するか選択できます（同梱しない場合はサムネイル画像のみの2D衣装として書き出されます）。全体バックアップにはモデルファイルも含まれます。

### データの保存先と復元手順

通常はOS標準のユーザーデータディレクトリ内に `kataru.db` が作成されます。保存先を変更したい場合は `--data-dir`、USBメモリ等に入れて持ち運びたい場合は `--portable` を指定してください。

#### 手動バックアップ・復元（JSON）

「設定」→「一般」→「バックアップ」から、キャラクター、シチュエーション、ルーム、メッセージ、メモリ、トークン使用履歴を一括でJSONエクスポートできます。インポート時は、既存データへの「追加」または「全置換」を選択可能です。

> **Warning**: シークレットモードで作成したルーム、会話、要約、メモリ、使用量は、データベースやバックアップに一切記録されません。タブやブラウザを閉じると復元できませんのでご注意ください。

#### 自動バックアップ（SQLiteスナップショット）からの復元

Kataruは起動時に、SQLiteのオンラインバックアップ機能を利用してデータベースのスナップショットを自動取得します。データディレクトリ内の `kataru-backups/` に `kataru-auto-*.db` として最大5世代保持されます。

自動バックアップからデータを復元する手順:

1. Kataruを完全に終了します。
2. データディレクトリにある現在の `kataru.db`（および存在するなら `kataru.db-wal` と `kataru.db-shm`）を別の場所にバックアップ退避します。
3. `kataru-backups/` の中から復元したい日時の `kataru-auto-*.db` を選び、`kataru.db` という名前に変更してデータディレクトリ直下に配置します（バックアップファイル自体が完全なSQLiteデータベースです）。
4. Kataruを起動します。

## セキュリティに関する注意

- **外部非公開が前提**: Kataruはローカル環境での利用を想定して設計されています。`--host 0.0.0.0` や `--host ::` を指定してネットワーク越しにアクセス可能にする場合は、リバースプロキシやファイアウォールで厳格にアクセス制限を行い、インターネットへ直接公開しないでください。
- **オリジン検証**: Hostヘッダーおよび状態変更を伴うリクエストのOriginを厳格に検証します。
- **認証情報の保護**: APIキーは環境変数、またはOSネイティブの資格情報ストア（Keychain、Windows資格情報マネージャー等）にのみ保存・取得されます。
- **エンドポイントの固定**: AIの接続先URLはサーバーローカルの `server-config.json` で管理され、ブラウザ側からリクエストごとに自由なURLを指定させることはできません（SSRF防止）。
- **設定変更の保護**: Web UIからのAI接続設定の変更は、ループバック（127.0.0.1）接続かつ許可されたOriginからのアクセスのみに制限されています。

## プロジェクト構成

```text
App.tsx              Reactアプリケーションのルートコンポーネント
main.tsx             フロントエンドのエントリーポイント
index.html           Vite用HTMLテンプレート
vite.config.ts       Viteビルドおよび開発用APIプロキシ設定
styles/              グローバルスタイル定義
components/          チャット、設定、キャラクター編集などのUIコンポーネント
lib/                 状態管理、APIクライアント、データ処理
src/main.rs          Axumサーバー起動、ルーティング、アクセス保護
src/ai_config.rs     CLIおよびWeb UI向けのAI接続設定管理
src/ai/              OpenRouter / OpenAI互換 / Anthropic APIクライアント
src/conversation/    会話生成、自動要約、指揮役（オーケストレーター）、長期記憶
src/db/              SQLiteデータベース操作・ストレージコマンド
migrations/          SQLiteマイグレーションファイル
scripts/             開発支援、ビルド、スモークテスト用スクリプト
```

## ライセンス

[MIT License](LICENSE)

