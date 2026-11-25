<p align="center">
  <img src="public/logo.png" alt="Kataru" width="240">
</p>

# Kataru

Kataruは、AIキャラクターとの1対1の会話や、複数キャラクターが織りなすシチュエーションを楽しめる、ローカルファーストなロールプレイチャットアプリです。

OpenRouter、OpenAI互換API、Anthropic APIに対応しています。TypeSafe AI やVOICEVOX、Irodori TTS Serverも接続できます！

## 主な機能

- **見やすいキャラクター切り替え**: キャラクターやシチュエーションごとにフォルダ分けして、すぐに他の部屋に切り替えできる
- **複数のAI接続先**: OpenRouter / OpenAI互換 / Anthropic / TypeSafe AI / VOICEVOX / Irodori TTS の接続先を複数登録し、キャラクターや用途別モデルごとに使い分け
- **衣装・表情の差分管理**: 立ち絵となる衣装を複数登録し、デフォルトの衣装を選択。AIによるゼロからの生成や既存衣装からの差分生成、衣装ごとの表情差分に対応
- **3Dアバター（VRM）**: VRM 0.x / 1.0 の3Dアバターをゲームモードで表示・操作
- **3種類の表示モード**: ベーシック（平文で返答）、メッセージ（チャット風、JSONで複数の吹き出し）、ゲーム（ビジュアルノベル風、JSONで表情・モーションを指定）
- **シチュエーション会話**: 複数キャラクターが参加できるグループ会話
- **音声読み上げ（TTS）**: 音声合成でAIキャラクターの返答とナレーションを生成。
- **メモリ**: 重要そうな情報は「メモリ」として保存し、キャラクターが他の会話で参照できる
- **使用統計**: トークン消費量や利用コストの可視化

## 動作要件

- **対応OS**: Windows / macOS / Linux
- OpenRouter / OpenAI / Anthropic いずれかのAPIキー、またはローカル等で稼働中の互換APIサーバー
- （読み上げ機能を使う場合）ローカルで起動したVOICEVOXエンジンまたはIrodori TTS Server、あるいは音声合成に対応しているAPI

## セットアップ

1. [GitHub Releases](https://github.com/frubot/kataru/releases) からお使いのOS向け（Windows / macOS / Linux）のアーカイブをダウンロードして展開します。
2. 実行ファイル（`kataru` または `kataru.exe`）を起動します。
3. ブラウザが自動で開きます（開かない場合は <http://127.0.0.1:37371> を開いてください）。

### デスクトップ版（Windows）

Windows向けアーカイブには、ブラウザを使わずアプリのウインドウで開くデスクトップ版 `kataru-desktop.exe` も含まれています。データの保存先はブラウザ版と共通です。

- ウインドウを閉じるとKataruも終了します。
- 起動中にもう一度開くと、表示中のウインドウが前面に出ます。
- ブラウザ版と同じポートを使うため、両方を同時には起動できません。
- 表示には Microsoft Edge WebView2 ランタイムを使用します（Windows 11 には標準で入っています）。

### AI接続先の設定

Kataruでは複数のAI接続先を登録し、キャラクターごとや用途別モデルに自由に割り当てて利用できます。

基本はアプリ起動後、画面の **「設定」→「モデル」→「接続先」** からGUIで追加・設定します（APIキーはOSの資格情報ストアに安全に保管されます）。CLIコマンドや環境変数（`.env`）での事前設定にも対応しています。

> **Note**: CLIからの接続先追加・管理手順については、後述の [接続先の追加・削除（CLI）](#接続先の追加削除cli) を参照してください。

## 音声合成（TTS / 読み上げ）

キャラクターの返答を、音声で楽しむことができます。

- **対応する接続先**: VOICEVOX、Irodori TTS、OpenAI互換API、OpenRouter
- **声の指定**: VOICEVOX接続では話者一覧からキャラクター・スタイルを、Irodori TTS接続ではサーバーに登録済みのvoiceを一覧から選択できます。その他の接続先ではモデル固有の声名（例: `alloy`）を入力します
- **再生する範囲**: キャラクターの返答だけを読み上げるか、ナレーションも読み上げるかを選択できます。
- **VRMリップシンク**: ゲームモードでVRMアバターを表示している場合、読み上げ時に口が動きます。
## データ管理とバックアップ

### 3Dアバター（VRM）の利用

キャラクター設定の「衣装」→「追加」→「3D(VRM)」からVRMファイルを登録できます。

- **対応形式**: VRM 0.x / 1.0（テクスチャ内包、1ファイルあたり最大50MBまで）
- **機能・表現**: 待機モーション、自動まばたき、揺れもの物理、会話内容に応じた表情の自動切り替え、TTS読み上げに連動したリップシンクに対応。「調整」パネルから表情の割り当てや初期プレビューを細かくカスタマイズできます。

### データの保存先と復元手順

通常はOS標準のユーザーデータディレクトリ内に `kataru.db` が作成されます。保存先を変更したい場合は `--data-dir`、USBメモリ等に入れて持ち運びたい場合は `--portable` を指定してください。

> **注意**: `--data-dir` / `--portable` に共有フォルダやUSBメモリを指定すると、保存先にはアクセストークン・会話履歴・記憶・画像がそのまま置かれるため、同じPCの他ユーザーや同じネットワークの他のPCから読める可能性があります。心当たりがない場合は、ローカルのディスク上のフォルダを指定してください。WindowsでUNCパス（`\\server\share`）や `--portable` を指定した場合は、起動時に警告を表示します。Unixではデータディレクトリを `0700`、`kataru.db`・`auth-token`・自動バックアップを `0600` に設定しますが、この保護は共有フォルダやUSBメモリを持ち出した先では効きません。

#### 自動バックアップ（SQLiteスナップショット）からの復元

Kataruは起動時に、SQLiteのオンラインバックアップ機能を利用してデータベースのスナップショットを自動取得します。データディレクトリ内の `kataru-backups/` に `kataru-auto-*.db` として最大5世代保持されます。

自動バックアップからデータを復元する手順:

1. Kataruを完全に終了します。
2. データディレクトリにある現在の `kataru.db`（および存在するなら `kataru.db-wal` と `kataru.db-shm`）を別の場所に退避します。
3. `kataru-backups/` の中から復元したい日時の `kataru-auto-*.db` を選び、`kataru.db` という名前に変更してデータディレクトリ直下に配置します（バックアップファイル自体が完全なSQLiteデータベースです）。
4. Kataruを起動します。

## セキュリティ

- **トークン認証**: 起動時に `Kataru: http://127.0.0.1:37371/?token=...` のようなURLを表示し、ブラウザで自動的に開きます。このURLを開くとブラウザにログイン用のCookieが保存され、以後はトークンなしで使えます。トークンはデータディレクトリの `auth-token` に保存され、再起動しても変わりません。
  - URLを見失った場合は `kataru token` で再表示できます（`--data-dir` / `--portable` / `--host` / `--port` は起動時と同じものを指定）。
  - トークンが漏れた場合は `kataru token --rotate` で再発行し、Kataruを再起動してください。ログイン済みのブラウザはすべて再認証が必要になります。
  - スクリプトなどからAPIを呼ぶ場合は `Authorization: Bearer <token>` ヘッダーでも認証できます。
  - `--token <TOKEN>` でトークンをCLI引数として渡すと、プロセス一覧（`ps` やタスクマネージャー）・シェル履歴・サービス定義ファイルに残ります。共有PCや共用サーバーでは `--token` を使わず、自動生成されるデータディレクトリの `auth-token`（表示は `kataru token`）を利用してください。
- **外部非公開が前提**: Kataruはローカル環境での利用を想定して設計されています。`--host` には `0.0.0.0` / `::`（全アドレスでの待受）やホスト名を指定できません。スマートフォンなどLAN内の端末から使う場合は、このPCのIPアドレス（例: `--host 192.168.1.20`）を指定してください。インターネットへ直接公開しないでください。
  - ただしLAN内で使う場合も通信は暗号化されないHTTP（平文）です。トークンや会話内容が同じネットワーク上から傍受されうるため、**信頼できるネットワーク限定**で使ってください。詳しくは後述の [LAN内の端末・スマートフォンから使う場合](#lan内の端末スマートフォンから使う場合) を参照してください。
- **認証情報の保護**: APIキーはデフォルトでは、OSネイティブの資格情報ストア（Keychain、Windows資格情報マネージャー等）に保存・取得されます。

### LAN内の端末・スマートフォンから使う場合

KataruのHTTPサーバーは **TLS（HTTPS）に対応していません**。`--host` にこのPCのIPアドレスを指定すると、同じネットワーク上の端末から `http://<このPCのIP>:37371/?token=...` でアクセスできますが、通信はすべて平文で流れます。

- 起動時に表示されるアクセスURLの `?token=...`、ログイン後のCookie、会話の内容は、いずれも暗号化されずに流れます。
- 同じLANに接続している第三者、公衆Wi-Fiの他の利用者、侵害されたルーターやアクセスポイントは、これらを傍受・盗聴できます。

そのため、LAN内で使う場合も次の点を守ってください。

- **信頼できるネットワーク（自宅LANなど）の内側だけで使う。** 会社・学校・宿泊先・カフェなどの共有ネットワークでは使わないでください。
- **公衆Wi-Fiでは使わない。** どうしても必要な場合は、後述のTailscaleやSSHポートフォワードで暗号化した経路を使ってください。
- **インターネットへ直接公開しない。** ルーターのポート開放やリバースプロキシで外部へ晒す運用は想定していません。

`--host` がloopback（`127.0.0.1` / `::1` / `localhost`）とTailscaleのアドレス以外のときは、起動時に平文HTTPで待ち受けている旨の警告が表示されます。

#### 外出先から使う場合: Tailscale（推奨）

[Tailscale](https://tailscale.com/) は、端末同士を暗号化されたプライベートネットワーク（VPN）でつなぐサービスです。KataruのホストPCと手元の端末を同じtailnetに参加させれば、平文HTTPの通信はTailscaleが暗号化するため、外出先から安全に使えます。

1. Kataruを動かすPCと、アクセスする端末（スマートフォンなど）の両方にTailscaleをインストールします。
2. 両方の端末で同じアカウントにログインします（CLIなら `tailscale up`、アプリならログイン操作）。
3. `tailscale ip -4` で表示されるこのPCのTailscale IPを確認し、そのアドレスでKataruを起動します。

   ```bash
   kataru --host 100.101.102.103
   ```

4. 手元の端末から、Tailscale経由のアドレスで開きます。

   ```text
   http://100.101.102.103:37371/?token=...
   ```

`--host` に指定できるのはIPアドレスか `localhost` だけなので、MagicDNSのホスト名ではなく `tailscale ip -4` で確認したIPアドレスを指定してください。ブラウザから開くときも、同じIPアドレス（`http://100.x.y.z:37371/?token=...`）を使ってください。

#### 外出先から使う場合: SSHポートフォワード

SSHでログインできるホストなら、Kataruはloopbackで起動したまま、手元の端末からSSHトンネルを張る方法もあります。この場合Kataru自体はLANに公開されず、経路はSSHが暗号化します。

1. Kataruをloopbackで起動します（例ではポートを8080にしています）。

   ```bash
   kataru --host 127.0.0.1 --port 8080
   ```

2. 手元の端末からSSHトンネルを張ります。

   ```bash
   ssh -L 8080:127.0.0.1:8080 user@host
   ```

   `user@host` はKataruを動かしているPCです。`-L 8080:127.0.0.1:8080` は「手元の8080番への接続を、SSH先の127.0.0.1:8080へ転送する」という意味です。

3. 手元のブラウザで <http://127.0.0.1:8080/?token=...> を開きます。

KataruはHostヘッダーが待受アドレスと一致することを検査するため、転送先のポートは `--port` に指定した値と同じにしてください。トークン付きURLは、ホスト側で `kataru token --port 8080` を実行すると再表示できます。

### 起動オプション・CLIコマンド

```text
version, --version, -V 現在のバージョンを表示
update                最新バージョンを確認し、利用可能なら自動更新
config                AI接続設定の確認・変更
models                モデル一覧キャッシュの更新
token                 アクセス用URLを表示（--rotate でトークンを再発行）
--host <HOST>         リッスンホスト（IPアドレスか localhost。デフォルト: 127.0.0.1）
--port <PORT>         リッスンポート（デフォルト: 37371）
--data-dir <PATH>     データ保存先ディレクトリ
--portable            実行ファイルと同じ階層の kataru-data/ を使用
--no-open             起動時にブラウザを自動で開かない
--token <TOKEN>       アクセストークンを固定（32文字以上の英数字と - _ . ~。引数に残るため共有環境では非推奨）
--no-auth             トークン認証を無効化（loopbackで待ち受けるときだけ指定可能）
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

## 開発

ソースコードからビルド・開発する場合の手順です。

### 開発環境要件

- Node.js 20.19 以降
- npm
- Rust stable ツールチェーン（Cargo を含む）

### 依存関係のインストール

```bash
npm install
```

### 開発サーバーの起動

```bash
npm run dev
```

このコマンドを実行すると、以下の2つのプロセスが同時に立ち上がります。

- **Vite開発サーバー**: <http://127.0.0.1:3000>
- **Rust APIサーバー**: <http://127.0.0.1:37372>

Vite開発サーバーへの `/api/*` リクエストは、Rust APIサーバーへ自動的にリバースプロキシされます。

開発サーバーのデータはリポジトリ直下の `.kataru-dev/` に保存され、通常起動時のデータとは分離されます。AI接続設定も別扱いとなるため、初回は開発サーバー側で設定してください。ポートも通常版と異なるため、通常版のKataruと同時に起動できます。

デスクトップ版で開発する場合は、次のコマンドを使用します。

```bash
npm run dev:desktop
```

Vite開発サーバーの画面をデスクトップ版のウインドウで表示します。データ保存先とポートは `npm run dev` と共通です。ウインドウを閉じると、Vite開発サーバーも終了します。

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

### ダミーAPIサーバー（APIキー不要）

外部APIに接続せず、チャット・ストリーミング・構造化出力の動作を確認したい場合は、OpenAI互換APIとAnthropic Messages APIを模擬するダミーサーバーを起動できます（Node.jsのみで動作します）。

```bash
npm run dummy:api        # http://127.0.0.1:4200
PORT=4300 npm run dummy:api
```

Kataruの **「設定」→「モデル」→「接続先」** で、次のベースURLを登録してください。APIキーは任意の文字列で構いません。

| 接続先 | ベースURL |
| --- | --- |
| OpenAI互換 | `http://127.0.0.1:4200/v1` |
| Anthropic | `http://127.0.0.1:4200/v1` |

最後のユーザーメッセージに `slow` を含めると10秒待ってから応答し、`fail`（`fail:429` など）を含めるとエラーを返します。画像生成を確認する場合は `node scripts/dummy-image-server.mjs` を使用してください。

## 単一バイナリのビルド

フロントエンドの静的アセットを内包した、配布・実行用のリリースバイナリをビルドします。

```bash
npm run build:binary
```

ビルド成果物の出力先:

- **Windows**: `target/release/kataru.exe`
- **macOS / Linux**: `target/release/kataru`

デスクトップ版も含めてビルドする場合:

```bash
npm run build:desktop
```

出力先は `target/release/kataru-desktop.exe` です。

ビルド済みバイナリの起動:

```bash
npm start
```

ビルドして、プロジェクト外の固定の場所へ配置する場合:

```bash
npm run install:binary
```

配置先は、Windowsでは `%LOCALAPPDATA%\Programs\Kataru\kataru.exe`、macOS / Linuxでは `~/.local/bin/kataru` です。普段使いのショートカットはこちらを指してください。Codexなどのサンドボックスが作業フォルダにLow整合性ラベルを付けている場合、`target/release` 内のバイナリは「unable to open database file」で起動できません。

バイナリのスモークテスト:

```bash
npm run smoke:binary
```

## ライセンス

[MIT License](LICENSE)

