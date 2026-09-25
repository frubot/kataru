<p align="center">
  <img src="public/logo.png" alt="Kataru" width="240">
</p>

# Kataru

Kataruは、AIキャラクターとの1対1の会話や、複数キャラクターが織りなすシチュエーションを楽しめる、ローカルファーストなロールプレイチャットアプリです。

OpenRouter、OpenAI互換API、Anthropic APIに対応しています。TypeSafe AI (Jev)やVOICEVOX、Irodori TTS Serverも接続できます！

## 主な機能

- **見やすいキャラクター切り替え**: キャラクターやシチュエーションごとにフォルダ分けして、すぐに他の部屋に切り替えできる
- **複数のAI接続先**: OpenRouter / OpenAI互換 / Anthropic互換 / TypeSafe AI / VOICEVOX / Irodori TTS の接続先を複数登録し、キャラクターや用途別モデルごとに使い分け
- **表情・衣装の差分管理**: 立ち絵の登録やAIによる画像生成
- **3Dアバター（VRM）**: VRM 0.x / 1.0 の3Dアバターをゲームモードで表示・操作
- **3種類の表示モード**: ベーシック、メッセージ（チャット風）、ゲーム（ビジュアルノベル風）
- **シチュエーション会話**: 複数キャラクターが参加できるグループ会話
- **音声読み上げ（TTS）**: 音声合成でAIキャラクターの返答とナレーションを生成。
- **メモリ**: 重要そうな情報は「メモリ」として保存し、キャラクターが他の会話で参照できる
- **使用統計**: トークン消費量や利用コストの可視化

## 動作要件

- Node.js 20.19 以降
- npm
- Rust stable ツールチェーン（Cargo を含む）
- OpenRouter / OpenAI / Anthropic いずれかのAPIキー、またはローカル等で稼働中の互換APIサーバー
- （読み上げ機能を使う場合）ローカルで起動したVOICEVOXエンジンまたはIrodori TTS Server、あるいは音声合成に対応しているAPI

## セットアップ

まずは依存関係をインストールします。

```bash
npm install
```

### AI接続先の設定

接続先は「設定」→「モデル」→「接続先」で管理します。同じ種類の接続先を複数登録できるほか、キャラクター設定や用途別モデル（会話・要約・シチュエーションの指揮など）のモデル選択で接続先を個別に指定できます。

Kataruは実行時に、カレントディレクトリまたは実行ファイルと同じディレクトリの `.env` ファイルを探し、読み込みます。

#### 1. OpenRouter を使う場合

「設定」→「モデル」→「接続先」で接続を編集（または新規追加）し、APIキーを登録できます（キーはOSの資格情報ストアに安全に保管されます）。また、「使用しないプロバイダー」一覧から特定のプロバイダーをルーティング対象外に指定することも可能です。

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

OpenAI や LM Studio、Ollama、vLLM などを利用する場合は、「設定」→「モデル」→「接続先」で「OpenAI / 互換API」の接続を編集（または新規追加）し、APIキーとエンドポイントを設定します。

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

> **Note**: Embeddingsや画像生成、音声合成（TTS）は接続先ごとの設定画面から有効化できます。利用するには接続先サーバー側の対応が必要です。

#### 3. Anthropic または互換API を使う場合

「設定」→「モデル」→「接続先」で「Anthropic / 互換API」の接続を編集（または新規追加）し、APIキーとエンドポイントを設定します。Kataru内部のリクエストおよびレスポンスは、サーバー側で自動的に Messages API 形式に相互変換されます。

CLIから設定する場合:

```bash
kataru config set anthropic.api-key
kataru config set anthropic.base-url https://api.anthropic.com/v1
```

環境変数で指定する場合:
`ANTHROPIC_API_KEY` と `ANTHROPIC_BASE_URL` が利用可能です。

- モデルIDには `claude-...` など、接続先で有効な識別子を指定してください。
> **Warning**:　Embedding及び画像生成には非対応です。利用したい場合、対応しているAPIを併用してください。

#### 4. TypeSafe AI (Jev) を使う場合

Kataru内部で使用する処理を高速化できる、「System One (Jev)」専用の接続先です。OpenRouter経由でも利用できます。

「設定」→「モデル」→「接続先」で「接続先を追加」から種類「TypeSafe AI (Jev)」を選び、APIキーを設定します。

CLIから設定する場合:

```bash
kataru config connection set-key typesafe
```

環境変数で指定する場合:
`TYPESAFE_API_KEY` と `TYPESAFE_BASE_URL`（デフォルト: `https://api.typesafe.ai/v1`）が利用可能です。

#### 5. VOICEVOX を使う場合

音声読み上げ（TTS）専用の接続先です。ローカルで起動したVOICEVOXエンジンに接続します。APIキーは不要です。

「設定」→「モデル」→「接続先」で「接続先を追加」から種類「VOICEVOX」を選び、エンドポイントを設定します（デフォルト: `http://127.0.0.1:50021`）。

CLIから設定する場合:

```bash
kataru config connection add voicevox --name "VOICEVOX" --base-url http://127.0.0.1:50021
```

#### 6. Irodori TTS を使う場合

音声読み上げ（TTS）専用の接続先です。[Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)に接続します。APIキーは省略できます（サーバー側で `IRODORI_API_KEY` を設定している場合のみ必要です）。

「設定」→「モデル」→「接続先」で「接続先を追加」から種類「Irodori TTS」を選び、エンドポイントを設定します（デフォルト: `http://127.0.0.1:8088`）。

CLIから設定する場合:

```bash
kataru config connection add irodori --name "Irodori TTS" --base-url http://127.0.0.1:8088
```

環境変数で指定する場合:
`IRODORI_BASE_URL` と `IRODORI_API_KEY` が利用可能です。

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

#### 接続先の追加・削除（CLI）

```bash
kataru config connection add <openrouter|openai-compatible|anthropic|typesafe|voicevox|irodori> --name <NAME> [--base-url <URL>]
kataru config connection set-key <ID>            # APIキーを対話入力
kataru config connection set-key <ID> --stdin    # APIキーを標準入力から読み取り
kataru config connection remove <ID>
```

#### モデル一覧キャッシュの更新

取得したモデル一覧は、データディレクトリ内の `model-cache.json` にキャッシュされます。Web UIの各モデル選択欄にある「モデル一覧を再取得」ボタン、またはCLIから手動更新できます。

```bash
kataru models refresh              # 設定済みの全プロバイダーを更新
kataru models refresh openrouter   # OpenRouter のみ更新
```

> **Note**: CLIによる設定変更は次回起動時に反映されます（すでに起動中の場合はアプリを再起動してください）。Web UIからの設定変更は即座に反映されます。

## 音声合成（TTS / 読み上げ）

キャラクターの返答を、音声で楽しむことができます。

- **対応する接続先**: VOICEVOX、Irodori TTS、OpenAI互換API、OpenRouter
- **声の指定**: VOICEVOX接続では話者一覧からキャラクター・スタイルを、Irodori TTS接続ではサーバーに登録済みのvoiceを一覧から選択できます。その他の接続先ではモデル固有の声名（例: `alloy`）を入力します
- **再生する範囲**: キャラクターの返答だけを読み上げるか、ナレーションも読み上げるかを選択できます。
- **VRMリップシンク**: ゲームモードでVRMアバターを表示している場合、読み上げ時に口が動きます。
## データ管理とバックアップ

### 3Dアバター（VRM）の利用

キャラクター設定の「衣装・アバター」→「3D（VRM）」からVRMファイルを登録できます。

- **対応形式**: VRM 0.x / 1.0（テクスチャ内包、1ファイルあたり最大50MBまで）
- **機能・表現**: 待機モーション、自動まばたき、揺れもの物理、会話内容に応じた表情の自動切り替え、TTS読み上げに連動したリップシンクに対応。「調整」パネルから表情の割り当てや初期プレビューを細かくカスタマイズできます。

### データの保存先と復元手順

通常はOS標準のユーザーデータディレクトリ内に `kataru.db` が作成されます。保存先を変更したい場合は `--data-dir`、USBメモリ等に入れて持ち運びたい場合は `--portable` を指定してください。

#### 自動バックアップ（SQLiteスナップショット）からの復元

Kataruは起動時に、SQLiteのオンラインバックアップ機能を利用してデータベースのスナップショットを自動取得します。データディレクトリ内の `kataru-backups/` に `kataru-auto-*.db` として最大5世代保持されます。

自動バックアップからデータを復元する手順:

1. Kataruを完全に終了します。
2. データディレクトリにある現在の `kataru.db`（および存在するなら `kataru.db-wal` と `kataru.db-shm`）を別の場所に退避します。
3. `kataru-backups/` の中から復元したい日時の `kataru-auto-*.db` を選び、`kataru.db` という名前に変更してデータディレクトリ直下に配置します（バックアップファイル自体が完全なSQLiteデータベースです）。
4. Kataruを起動します。

## セキュリティ

- **外部非公開が前提**: Kataruはローカル環境での利用を想定して設計されています。`--host 0.0.0.0` や `--host ::` を指定してネットワーク越しにアクセス可能にする場合は、リバースプロキシやファイアウォールで厳格にアクセス制限を行い、インターネットへ直接公開しないでください。
- **認証情報の保護**: APIキーはデフォルトでは、OSネイティブの資格情報ストア（Keychain、Windows資格情報マネージャー等）に保存・取得されます。

## ライセンス

[MIT License](LICENSE)

