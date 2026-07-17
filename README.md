# Kataru

Kataruは、キャラクターとの会話や複数キャラクターによるシチュエーションを楽しむための、ローカルファーストなロールプレイチャットアプリです。

Next.jsで構築したUIをRust/Axumサーバーから配信し、キャラクター、会話履歴、メモリ、使用量などをローカルのSQLiteデータベースへ保存します。AI接続先にはOpenRouterまたはOpenAI互換APIを利用できます。

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

- Node.js 20.9以降
- npm
- Rustのstable toolchain（Cargoを含む）
- OpenRouterのAPIキー、または起動済みのOpenAI互換APIサーバー

## セットアップ

依存関係をインストールします。

```bash
npm install
```

### OpenRouterを使う場合

`OPENROUTER_API_KEY`を、Kataruを起動するプロセスの環境変数に設定します。

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

ブラウザで <http://127.0.0.1:3000> を開いてください。接続先の初期値はOpenRouterです。

### OpenAI互換APIを使う場合

接続先と、必要に応じてAPIキーを環境変数で設定します。

PowerShell:

```powershell
$env:OPENAI_COMPAT_BASE_URL = "http://127.0.0.1:1234/v1"
$env:OPENAI_COMPAT_API_KEY = "your-api-key"
npm run dev
```

bash:

```bash
export OPENAI_COMPAT_BASE_URL="http://127.0.0.1:1234/v1"
export OPENAI_COMPAT_API_KEY="your-api-key"
npm run dev
```

起動後、アプリの「設定」→「モデル」→「API 接続先」で「OpenAI互換API」を選択してください。

- `OPENAI_COMPAT_BASE_URL`の初期値は`http://localhost:1234/v1`です。
- `OPENAI_COMPAT_API_KEY`を省略した場合は`local`が送信されます。
- embeddingsと画像生成は設定画面から個別に有効化できます。利用するAPIサーバーが対応するエンドポイントを実装している必要があります。
- 接続先URLとAPIキーはサーバー側の環境変数だけから取得します。ブラウザから任意の接続先へサーバーのAPIキーを送信することはありません。

Rustサーバーは`.env`ファイルを自動では読み込みません。環境変数は、上記のようにシェルまたはプロセスマネージャーで設定してください。

## 開発

```bash
npm run dev
```

このコマンドは次の2プロセスを起動します。

- Next.js開発サーバー: <http://127.0.0.1:3000>
- Rust APIサーバー: <http://127.0.0.1:37371>

Next.js開発サーバーは`/api/*`をRust APIサーバーへ転送します。

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

Next.jsの静的出力を埋め込んだリリースバイナリを作成します。

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

起動すると既定のブラウザで <http://127.0.0.1:37371> が開きます。バイナリのスモークテストは次のコマンドで実行できます。

```bash
npm run smoke:binary
```

### 起動オプション

```text
--host <IP>           待受IP。loopbackアドレスのみ指定可能
--port <PORT>         待受ポート（既定: 37371）
--data-dir <PATH>     データ保存先
--portable            実行ファイル横の kataru-data/ を使用
--no-open             ブラウザを自動で開かない
--dev-origin <ORIGIN> 開発UI用のloopbackオリジンを許可
```

例:

```bash
npm start -- --portable --no-open
```

## データとバックアップ

通常はOSのユーザーデータディレクトリ内に`kataru.db`を作成します。保存先を明示したい場合は`--data-dir`、実行ファイルと一緒に持ち運びたい場合は`--portable`を使用してください。

アプリの「設定」→「一般」→「バックアップ」から、キャラクター、シチュエーション、ルーム、メッセージ、メモリ、使用記録をJSONとして書き出せます。インポート時は、現在のデータへの追加または全置換を選択できます。

シークレットモードのルームとその会話、要約、メモリ、使用量はSQLiteやバックアップへ保存されません。ページを閉じると復元できないためご注意ください。

## セキュリティ

- サーバーはloopbackアドレスだけで待ち受けます。
- Hostヘッダーと、状態を変更するリクエストのOriginを検証します。
- APIキーはサーバー環境変数だけから取得し、SQLiteやブラウザの設定には保存しません。
- OpenAI互換APIの接続先はサーバー環境変数で固定されます。

Kataruはローカル利用を前提としており、外部ネットワークへ公開する構成には対応していません。

## プロジェクト構成

```text
app/                 Next.jsのページとグローバルスタイル
components/          チャット、設定、キャラクター編集などのUI
lib/                 状態管理、APIクライアント、バックアップ処理
src/main.rs          Axumサーバー、ルーティング、アクセス保護
src/ai/              OpenRouter／OpenAI互換APIとの通信
src/conversation/    会話生成、要約、指揮役、メモリ処理
src/db/              SQLiteとストレージコマンド
migrations/          SQLiteマイグレーション
scripts/             開発、起動、スモークテスト用スクリプト
```

## ライセンス

[MIT License](LICENSE)
