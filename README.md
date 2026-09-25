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

Kataruでは複数のAI接続先を登録し、キャラクターごとや用途別モデルに自由に割り当てて利用できます。

基本はアプリ起動後、画面の **「設定」→「モデル」→「接続先」** からGUIで追加・設定します（APIキーはOSの資格情報ストアに安全に保管されます）。CLIコマンドや環境変数（`.env`）での事前設定にも対応しています。

#### 主な接続先と用途

- **OpenRouter**: 多彩なクラウドモデルを単一APIキーで利用（会話・要約・画像生成・TTSなど）
- **OpenAI / 互換API**: 公式OpenAIのほか、OllamaやLM Studio、vLLM等のローカルLLMサーバー（Embeddings・画像生成・TTSにも対応）
- **Anthropic / 互換API**: Claudeシリーズ等のMessages API互換モデル
- **TypeSafe AI (Jev)**: 内部処理を高速化する専用接続
- **VOICEVOX / Irodori TTS**: 音声読み上げ（TTS）専用のローカル・外部音声サーバー

> **Note**: CLIからの接続先追加・管理手順については、後述の [接続先の追加・削除（CLI）](#接続先の追加削除cli) を参照してください。

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

