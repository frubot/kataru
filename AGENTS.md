# AGENTS.md

## コマンド

```bash
npm run dev          # 明示的に依頼された場合だけ実行
npm run lint
npx tsc --noEmit
npm run build        # Vite静的出力
cargo test
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features desktop -- -D warnings  # デスクトップ版を含めた検査
npm run build:binary
npm run build:desktop # デスクトップ版（kataru-desktop）も含めてビルド
npm run smoke:binary
npm audit            # 依存関係の脆弱性監査（high以上でfail）
cargo audit          # 依存関係の脆弱性監査（CIは週次、.github/workflows/audit.yml）
```

## 構成

- `App.tsx`, `components/`, `lib/`: React UI。永続化は`lib/db.ts`から`/api/storage`を使用します。
- `src/lib.rs`: Axumの起動、routing、loopback/Origin保護。`src/main.rs`はCLI版の入口です。
- `src/bin/kataru-desktop.rs`: デスクトップ版。同一プロセスでサーバーを起動し、wry/taoのWebViewで表示します（`desktop` feature）。
- `src/db/`: SQLiteとストレージcommand。
- `src/ai/`: OpenRouter/OpenAI互換APIクライアントと生成API。
- `src/conversation/`: 会話（シチュエーションは1回の呼び出しで複数キャラをまとめて生成）、要約、記憶検索・抽出。
- `migrations/`: SQLite migration。
- `out/`: Viteの静的出力。Rustバイナリへ埋め込みます。

## セキュリティ

- `.env.*`の内容は読まないでください。