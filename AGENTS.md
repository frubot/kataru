# AGENTS.md

## コマンド

```bash
npm run dev          # 明示的に依頼された場合だけ実行
npm run lint
npx tsc --noEmit
npm run build        # Next.js静的出力
cargo test
cargo clippy --all-targets -- -D warnings
npm run build:binary
npm run smoke:binary
```

Windowsのサンドボックス内ではNext.js buildやRust release buildが権限エラーになることがあるため、必要に応じてサンドボックス外で実行します。

## 構成

- `app/`, `components/`, `lib/`: React UI。永続化は`lib/db.ts`から`/api/storage`を使用します。
- `src/main.rs`: Axumの起動、routing、loopback/Origin保護。
- `src/db/`: SQLiteとストレージcommand。
- `src/ai/`: OpenRouter/OpenAI互換providerと生成API。
- `src/conversation/`: 会話、要約、指揮役、記憶検索・抽出。
- `migrations/`: SQLite migration。
- `out/`: Next.js静的出力。Rustバイナリへ埋め込みます。

## セキュリティ

- `.env.*`の内容は読まないでください。
- APIキーはサーバー環境変数だけから取得します。
- クライアント指定のOpenAI互換base URLへサーバーAPIキーを送らないでください。
- 待受アドレスと開発用Originはloopbackだけを許可します。
- secret modeの会話、要約、記憶、usageは永続化しません。