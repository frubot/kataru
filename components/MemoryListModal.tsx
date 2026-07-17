'use client';

import { useCallback, useEffect, useState } from 'react';
import { X, Trash2, Brain } from 'lucide-react';
import { useStore, Character, MemoryRecord } from '@/lib/store';

interface MemoryListModalProps {
    isOpen: boolean;
    onClose: () => void;
    character: Character | null;
}

export default function MemoryListModal({ isOpen, onClose, character }: MemoryListModalProps) {
    const { removeMemoryRecord, clearMemories, listMemoriesForCharacter } = useStore();
    const liveCharacter = useStore((s) => (character ? s.characters.find((c) => c.id === character.id) : undefined)) ?? character;
    const [memories, setMemories] = useState<MemoryRecord[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    const reloadMemories = useCallback(async () => {
        if (!liveCharacter) return;
        setIsLoading(true);
        try {
            setMemories(await listMemoriesForCharacter(liveCharacter.id));
        } finally {
            setIsLoading(false);
        }
    }, [listMemoriesForCharacter, liveCharacter]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    useEffect(() => {
        if (!isOpen || !liveCharacter) {
            setMemories([]);
            return;
        }
        reloadMemories();
    }, [isOpen, liveCharacter, reloadMemories]);

    if (!isOpen || !liveCharacter) return null;

    const handleRemoveMemory = async (memoryId: string) => {
        await removeMemoryRecord(liveCharacter.id, memoryId);
        setMemories((current) => current.filter((memory) => memory.id !== memoryId));
    };

    const handleClearAll = async () => {
        if (confirm('すべてのメモリを削除しますか？')) {
            await clearMemories(liveCharacter.id);
            setMemories([]);
        }
    };

    const formatMemoryKind = (kind: MemoryRecord['kind']) => {
        switch (kind) {
            case 'preference': return '好み';
            case 'event': return '出来事';
            case 'relationship': return '関係性';
            case 'instruction': return '指示';
            default: return '事実';
        }
    };

    const formatDate = (timestamp?: number) => {
        if (!timestamp) return '未使用';
        return new Date(timestamp).toLocaleString();
    };

    return (
        <div
            className="modal-overlay"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                className="modal-content settings-form-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={`${liveCharacter.name}のメモリ`}
            >
                <div className="settings-form-modal-actions">
                    <button
                        className="btn btn-ghost"
                        onClick={onClose}
                        aria-label="閉じる"
                        title="閉じる"
                        style={{
                            width: 36,
                            height: 36,
                            minWidth: 36,
                            minHeight: 36,
                            padding: '0.5rem',
                            flex: '0 0 36px',
                        }}
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body">
                    {isLoading ? (
                        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                            読み込み中...
                        </div>
                    ) : memories.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                            <Brain size={48} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
                            <p>まだメモリがありません</p>
                            <p style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>
                                会話の中で「覚えて」と指示すると、キャラクターが記憶します
                            </p>
                        </div>
                    ) : (
                        <div>
                            <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                                    {memories.length}件のメモリ
                                </span>
                                <button className="btn btn-ghost" onClick={handleClearAll} style={{ color: 'var(--error)', fontSize: '0.75rem' }}>
                                    <Trash2 size={14} />
                                    すべて削除
                                </button>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {memories.map((memory) => (
                                    <div
                                        key={memory.id}
                                        className="memory-item"
                                        style={{
                                            display: 'flex',
                                            alignItems: 'flex-start',
                                            gap: '0.75rem',
                                            padding: '0.75rem',
                                            background: 'var(--bg-tertiary)',
                                            borderRadius: '0.5rem',
                                        }}
                                    >
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: '0.875rem', lineHeight: 1.5 }}>
                                                {memory.content}
                                            </div>
                                            <div style={{ marginTop: '0.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                                <span>{formatMemoryKind(memory.kind)}</span>
                                                <span>重要度 {Math.round(memory.importance * 100)}%</span>
                                                <span>使用 {memory.usageCount}回</span>
                                                <span>最終使用 {formatDate(memory.lastUsedAt)}</span>
                                            </div>
                                        </div>
                                        <button
                                            className="btn btn-ghost"
                                            onClick={() => handleRemoveMemory(memory.id)}
                                            style={{ padding: '0.25rem', color: 'var(--text-muted)' }}
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
