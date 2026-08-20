import type { PromptInspectionSnapshot } from '@/lib/promptInspector';

const cardStyle: React.CSSProperties = {
    padding: '0.875rem',
    border: '1px solid var(--border-color)',
    borderRadius: '0.625rem',
    background: 'var(--bg-secondary)',
};

const codeStyle: React.CSSProperties = {
    margin: 0,
    maxHeight: 420,
    overflow: 'auto',
    padding: '0.75rem',
    borderRadius: '0.5rem',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: '0.75rem',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
};

export default function PromptInspectorPanel({ snapshots }: { snapshots: PromptInspectionSnapshot[] }) {
    if (snapshots.length === 0) {
        return (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                有効化後に生成されたプロンプトはまだありません。シークレットモードのプロンプトは取得しません。
            </p>
        );
    }
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                messagesはKataruが生成リクエスト直前に組み立てた最終メッセージ内容です。providerによりHTTP payload上の表現は変換されます。トークン数はモデル固有tokenizerを使わない文字種ベースの概算で、message wrapper等は含みません。
            </p>
            {snapshots.map((snapshot) => (
                <details key={snapshot.id} open={snapshots.length === 1} style={cardStyle}>
                    <summary style={{ cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600 }}>
                        {snapshot.characterName} / {snapshot.model ?? 'モデル不明'} / {snapshot.source} / 約{snapshot.breakdown.totalEstimatedTokens} tokens
                    </summary>
                    <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                            {[snapshot.breakdown.history, snapshot.breakdown.summary, snapshot.breakdown.memory].map((part) => (
                                <span key={part.label} style={{ padding: '0.25rem 0.5rem', borderRadius: 999, background: 'var(--bg-tertiary)', fontSize: '0.7rem' }}>
                                    {part.label}: 約{part.estimatedTokens}
                                </span>
                            ))}
                        </div>
                        <div>
                            <div style={{ marginBottom: '0.375rem', fontSize: '0.75rem', fontWeight: 600 }}>システムプロンプトのブロック内訳</div>
                            <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                                {snapshot.breakdown.systemBlocks.map((part, index) => (
                                    <span key={`${part.label}-${index}`} style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                                        {part.label}: 約{part.estimatedTokens}
                                    </span>
                                ))}
                            </div>
                        </div>
                        <div>
                            <div style={{ marginBottom: '0.375rem', fontSize: '0.75rem', fontWeight: 600 }}>生成に使用した最終messages</div>
                            <pre style={codeStyle}>{JSON.stringify(snapshot.messages, null, 2)}</pre>
                        </div>
                    </div>
                </details>
            ))}
        </div>
    );
}
