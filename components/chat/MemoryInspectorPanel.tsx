import { useEffect, useMemo, useState } from 'react';
import { Pencil, Pin, Save, Trash2 } from 'lucide-react';

import { useStore, type MemoryRecord, type Room } from '@/lib/store';

const cardStyle: React.CSSProperties = {
    padding: '0.875rem',
    border: '1px solid var(--border-color)',
    borderRadius: '0.625rem',
    background: 'var(--bg-secondary)',
};

export default function MemoryInspectorPanel({ room }: { room: Room }) {
    const { listMemoriesByIds, updateMemoryRecord, removeMemoryRecord } = useStore();
    const responses = useMemo(
        () => room.messages.filter((message) => message.role === 'assistant' && message.usedMemoryIds?.length),
        [room.messages],
    );
    const referencedIds = useMemo(
        () => [...new Set(responses.flatMap((message) => message.usedMemoryIds ?? []))],
        [responses],
    );
    const referenceKey = referencedIds.join('\u0000');
    const [records, setRecords] = useState<MemoryRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [busyMemoryId, setBusyMemoryId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');

    useEffect(() => {
        let active = true;
        setLoading(true);
        setLoadError(null);
        void listMemoriesByIds(referencedIds).then((loaded) => {
            if (active) setRecords(loaded);
        }).catch(() => {
            if (!active) return;
            setRecords([]);
            setLoadError('参照メモリを読み込めませんでした。もう一度インスペクターを開いてください。');
        }).finally(() => {
            if (active) setLoading(false);
        });
        return () => { active = false; };
        // referenceKey is the stable identity of the ids used by these responses.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [listMemoriesByIds, referenceKey]);

    const recordsById = useMemo(
        () => new Map(records.map((record) => [record.id, record])),
        [records],
    );

    const saveEdit = async (memory: MemoryRecord) => {
        if (busyMemoryId) return;
        setBusyMemoryId(memory.id);
        setActionError(null);
        try {
            const updated = await updateMemoryRecord(memory.characterId ?? '', memory.id, { content: draft });
            if (!updated) throw new Error('memory update was rejected');
            setRecords((current) => current.map((record) => record.id === updated.id ? updated : record));
            setEditingId(null);
        } catch {
            setActionError('メモリを保存できませんでした。内容を確認して、もう一度お試しください。');
        } finally {
            setBusyMemoryId(null);
        }
    };

    const togglePinned = async (memory: MemoryRecord) => {
        if (busyMemoryId) return;
        setBusyMemoryId(memory.id);
        setActionError(null);
        try {
            const updated = await updateMemoryRecord(memory.characterId ?? '', memory.id, { pinned: !memory.pinned });
            if (!updated) throw new Error('memory pin update was rejected');
            setRecords((current) => current.map((record) => record.id === updated.id ? updated : record));
        } catch {
            setActionError('メモリの優先固定を変更できませんでした。もう一度お試しください。');
        } finally {
            setBusyMemoryId(null);
        }
    };

    const remove = async (memory: MemoryRecord) => {
        if (busyMemoryId) return;
        if (!confirm('このメモリを削除しますか？')) return;
        setBusyMemoryId(memory.id);
        setActionError(null);
        try {
            await removeMemoryRecord(memory.characterId ?? '', memory.id);
            setRecords((current) => current.filter((record) => record.id !== memory.id));
            if (editingId === memory.id) setEditingId(null);
        } catch {
            setActionError('メモリを削除できませんでした。もう一度お試しください。');
        } finally {
            setBusyMemoryId(null);
        }
    };

    if (responses.length === 0) {
        return (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                参照メモリを記録した応答はまだありません。メモリが検索された次の応答から確認できます。
            </p>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                応答の生成時に実際のシステムプロンプトへ挿入された長期メモリを表示します。
            </p>
            {loadError && (
                <p role="alert" style={{ margin: 0, color: 'var(--error)', fontSize: '0.75rem' }}>
                    {loadError}
                </p>
            )}
            {actionError && (
                <p role="alert" style={{ margin: 0, color: 'var(--error)', fontSize: '0.75rem' }}>
                    {actionError}
                </p>
            )}
            {responses.slice().reverse().map((response) => (
                <section key={response.id} style={cardStyle}>
                    <div style={{ marginBottom: '0.625rem' }}>
                        <time style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            {new Date(response.timestamp).toLocaleString()}
                        </time>
                        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                            {response.content.length > 140 ? `${response.content.slice(0, 140)}…` : response.content}
                        </p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {(response.usedMemoryIds ?? []).map((memoryId) => {
                            const memory = recordsById.get(memoryId);
                            if (!memory) {
                                return (
                                    <div key={memoryId} style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        {loading ? 'メモリを読み込み中…' : `削除済みまたは取得できないメモリ (${memoryId})`}
                                    </div>
                                );
                            }
                            const editing = editingId === memory.id;
                            return (
                                <div key={memory.id} style={{ padding: '0.625rem', borderRadius: '0.5rem', background: 'var(--bg-tertiary)' }}>
                                    {editing ? (
                                        <textarea
                                            value={draft}
                                            onChange={(event) => setDraft(event.target.value)}
                                            rows={3}
                                            autoFocus
                                            disabled={busyMemoryId != null}
                                            aria-label="メモリ内容"
                                            style={{ width: '100%', resize: 'vertical' }}
                                        />
                                    ) : (
                                        <p style={{ margin: 0, fontSize: '0.8125rem', lineHeight: 1.5 }}>{memory.content}</p>
                                    )}
                                    <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: '0.6875rem', color: memory.pinned ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                            {memory.pinned ? '優先固定中' : `重要度 ${Math.round(memory.importance * 100)}%`}
                                        </span>
                                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                                            {editing ? (
                                                <>
                                                    <button type="button" className="btn btn-ghost" onClick={() => setEditingId(null)} disabled={busyMemoryId != null}>キャンセル</button>
                                                    <button type="button" className="btn btn-primary" onClick={() => void saveEdit(memory)} disabled={!draft.trim() || busyMemoryId != null}>
                                                        <Save size={14} />{busyMemoryId === memory.id ? '保存中…' : '保存'}
                                                    </button>
                                                </>
                                            ) : (
                                                <>
                                                    <button
                                                        type="button"
                                                        className="btn btn-ghost"
                                                        onClick={() => void togglePinned(memory)}
                                                        aria-pressed={memory.pinned === true}
                                                        aria-label={memory.pinned ? 'メモリの優先固定を解除' : 'メモリを優先固定'}
                                                        title={memory.pinned ? '優先固定を解除' : '検索時に優先する'}
                                                        disabled={busyMemoryId != null}
                                                    >
                                                        <Pin size={14} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="btn btn-ghost"
                                                        onClick={() => { setEditingId(memory.id); setDraft(memory.content); }}
                                                        aria-label="メモリを編集"
                                                        title="編集"
                                                        disabled={busyMemoryId != null}
                                                    >
                                                        <Pencil size={14} />
                                                    </button>
                                                    <button type="button" className="btn btn-ghost" onClick={() => void remove(memory)} aria-label="メモリを削除" title="削除" disabled={busyMemoryId != null} style={{ color: 'var(--error)' }}>
                                                        <Trash2 size={14} />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </section>
            ))}
        </div>
    );
}
