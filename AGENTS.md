# AGENTS.md

## コマンド

```bash
npm run dev          # 明示的に依頼された場合だけ実行
npm run lint
npx tsc --noEmit
npm run build        # Vite静的出力
cargo test
cargo clippy --all-targets -- -D warnings
npm run build:binary
npm run smoke:binary
```

## 構成

- `App.tsx`, `components/`, `lib/`: React UI。永続化は`lib/db.ts`から`/api/storage`を使用します。
- `src/main.rs`: Axumの起動、routing、loopback/Origin保護。
- `src/db/`: SQLiteとストレージcommand。
- `src/ai/`: OpenRouter/OpenAI互換APIクライアントと生成API。
- `src/conversation/`: 会話、要約、指揮役、記憶検索・抽出。
- `migrations/`: SQLite migration。
- `out/`: Viteの静的出力。Rustバイナリへ埋め込みます。

## セキュリティ

- `.env.*`の内容は読まないでください。