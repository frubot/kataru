import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';

import { useStore, type Room } from '@/lib/store';

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

export default function SummaryInspectorPanel({ room }: { room: Room }) {
    const updateRoomSummary = useStore((state) => state.updateRoomSummary);
    const [draft, setDraft] = useState(room.summary ?? '');
    useEffect(() => setDraft(room.summary ?? ''), [room.id, room.summary]);
    const archived = room.messages.filter((message) => message.archived);
    const checkpoint = room.summaryCheckpointUserMessageId
        ? room.messages.find((message) => message.id === room.summaryCheckpointUserMessageId)
        : undefined;
    const history = room.summaryHistory ?? [];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <section style={cardStyle}>
                <label htmlFor="summary-inspector-editor" style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                    現在APIへ渡される要約
                </label>
                <textarea
                    id="summary-inspector-editor"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={9}
                    placeholder="まだ要約はありません"
                    style={{ width: '100%', resize: 'vertical', lineHeight: 1.55 }}
                />
                <div style={{ marginTop: '0.625rem', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!draft.trim() || draft === (room.summary ?? '')}
                        onClick={() => updateRoomSummary(room.id, draft.trim(), room.summaryCheckpointUserMessageId, 'manual')}
                    >
                        <Save size={15} />要約を保存
                    </button>
                </div>
                {room.summary && !draft.trim() && (
                    <p style={{ margin: '0.5rem 0 0', fontSize: '0.7rem', color: 'var(--error)' }}>
                        圧縮済み履歴の文脈を失わないよう、要約を空にはできません。
                    </p>
                )}
            </section>
            <section style={cardStyle}>
                <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem' }}>圧縮範囲</h4>
                <div style={{ display: 'grid', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    <span>圧縮済みメッセージ: {archived.length}件</span>
                    <span>チェックポイント: {room.summaryCheckpointUserMessageId ?? 'なし'}</span>
                    {checkpoint && <span>チェックポイント内容: {checkpoint.content.slice(0, 120)}</span>}
                    {archived.length > 0 && (
                        <span>
                            範囲: {new Date(archived[0].timestamp).toLocaleString()} ～ {new Date(archived[archived.length - 1].timestamp).toLocaleString()}
                        </span>
                    )}
                </div>
            </section>
            <section style={cardStyle}>
                <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem' }}>要約履歴</h4>
                {history.length === 0 ? (
                    <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.75rem' }}>履歴はまだありません。</p>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {history.slice().reverse().map((revision, index) => (
                            <details key={`${revision.createdAt}-${index}`}>
                                <summary style={{ cursor: 'pointer', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    {new Date(revision.createdAt).toLocaleString()} / {revision.source === 'manual' ? '手動編集' : '自動要約'}
                                </summary>
                                <pre style={{ ...codeStyle, marginTop: '0.375rem' }}>{revision.text || '（空の要約）'}</pre>
                            </details>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
