import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, LockOpen, Plus, Sparkles, Trash2 } from 'lucide-react';
import * as db from '@/lib/db';
import type { CoreMemory, CoreMemoryEntry, CoreMemorySection } from '@/lib/store';
import {
    CORE_MEMORY_ENTRY_MAX_CHARS,
    CORE_MEMORY_MAX_CHARS,
    CORE_MEMORY_SECTIONS,
    coreMemoryDraftProblems,
    countCoreMemoryChars,
    emptyCoreMemory,
    totalCoreMemoryChars,
} from '@/lib/coreMemory';
import { generateId } from '@/lib/id';

interface CoreMemoryEditorProps {
    characterId: string;
}

/** 画面の中だけで使う行。新しい行は id が空なので、表示用のキーを別に持つ。 */
type DraftEntry = CoreMemoryEntry & { key: string };

function toDraft(memory: CoreMemory): DraftEntry[] {
    return memory.entries.map((entry) => ({ ...entry, key: entry.id || generateId() }));
}

function sameEntries(left: DraftEntry[], right: DraftEntry[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((entry, index) => {
        const other = right[index];
        return entry.id === other.id
            && entry.section === other.section
            && entry.text === other.text
            && (entry.locked === true) === (other.locked === true);
    });
}

export default function CoreMemoryEditor({ characterId }: CoreMemoryEditorProps) {
    const [saved, setSaved] = useState<CoreMemory>(() => emptyCoreMemory(characterId));
    const [savedDraft, setSavedDraft] = useState<DraftEntry[]>([]);
    const [draft, setDraft] = useState<DraftEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const applyLoaded = useCallback((memory: CoreMemory | null) => {
        const next = memory ?? emptyCoreMemory(characterId);
        const nextDraft = toDraft(next);
        setSaved(next);
        setSavedDraft(nextDraft);
        setDraft(nextDraft);
    }, [characterId]);

    const reload = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            applyLoaded(await db.getCoreMemory(characterId));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : '常駐記憶を読み込めませんでした');
        } finally {
            setIsLoading(false);
        }
    }, [applyLoaded, characterId]);

    useEffect(() => {
        setNotice(null);
        void reload();
    }, [reload]);

    const totalChars = useMemo(() => totalCoreMemoryChars(draft), [draft]);
    const problems = useMemo(() => coreMemoryDraftProblems(draft), [draft]);
    const isDirty = !sameEntries(draft, savedDraft);

    const updateEntry = (key: string, updates: Partial<CoreMemoryEntry>) => {
        setDraft((current) => current.map((entry) => (entry.key === key ? { ...entry, ...updates } : entry)));
    };

    const removeEntry = (key: string) => {
        setDraft((current) => current.filter((entry) => entry.key !== key));
    };

    const addEntry = (section: CoreMemorySection) => {
        setDraft((current) => {
            // 見出しの中の最後に足す。
            const lastIndex = current.reduce((last, entry, index) => (entry.section === section ? index : last), -1);
            const entry: DraftEntry = { key: generateId(), id: '', section, text: '', locked: false };
            if (lastIndex < 0) return [...current, entry];
            return [...current.slice(0, lastIndex + 1), entry, ...current.slice(lastIndex + 1)];
        });
    };

    const handleSave = async () => {
        if (!isDirty || problems.length > 0 || isSaving) return;
        setIsSaving(true);
        setError(null);
        setNotice(null);
        try {
            const result = await db.putCoreMemory({
                characterId,
                version: saved.version,
                nextId: saved.nextId,
                entries: draft
                    .filter((entry) => entry.text.trim().length > 0)
                    .map(({ id, section, text, locked, author, updatedAt }) => ({
                        id, section, text, locked, author, updatedAt,
                    })),
            }, saved.version);
            applyLoaded(result.coreMemory);
            if (result.status === 'conflict') {
                setNotice('会話の裏で常駐記憶が更新されていたため、最新の内容を読み込みました。もう一度編集してください。');
            } else {
                setNotice('保存しました');
            }
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : '常駐記憶を保存できませんでした');
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) {
        return (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                読み込み中...
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
                常駐記憶は、話題に関係なく毎回キャラクターが参照する短い記憶です。
                記憶をまとめて抽出する設定がオンのとき、AIが会話から自動で更新します。
                鍵をかけた行はAIが変更しません。
            </p>

            {CORE_MEMORY_SECTIONS.map((section) => {
                const entries = draft.filter((entry) => entry.section === section.value);
                return (
                    <section key={section.value} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}>
                            <div>
                                <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{section.label}</div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{section.hint}</div>
                            </div>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => addEntry(section.value)}
                                style={{ fontSize: '0.75rem', flexShrink: 0 }}
                            >
                                <Plus size={14} />
                                追加
                            </button>
                        </div>
                        {entries.length === 0 ? (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '0.25rem 0' }}>
                                まだありません
                            </div>
                        ) : entries.map((entry) => {
                            const length = countCoreMemoryChars(entry.text);
                            const tooLong = length > CORE_MEMORY_ENTRY_MAX_CHARS;
                            return (
                                <div
                                    key={entry.key}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: '0.5rem',
                                        padding: '0.5rem',
                                        background: 'var(--bg-tertiary)',
                                        borderRadius: '0.5rem',
                                    }}
                                >
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <textarea
                                            className="input textarea"
                                            value={entry.text}
                                            onChange={(event) => updateEntry(entry.key, { text: event.target.value })}
                                            rows={2}
                                            aria-label={`${section.label}の行`}
                                            style={{ width: '100%', resize: 'vertical', fontSize: '0.875rem' }}
                                        />
                                        <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.7rem', color: tooLong ? 'var(--error)' : 'var(--text-muted)', marginTop: '0.25rem' }}>
                                            {entry.author === 'ai' && (
                                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }} title="AIが書いた行">
                                                    <Sparkles size={11} />AI
                                                </span>
                                            )}
                                            <span>{length}/{CORE_MEMORY_ENTRY_MAX_CHARS}</span>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        className="btn btn-ghost"
                                        onClick={() => updateEntry(entry.key, { locked: !entry.locked })}
                                        aria-pressed={entry.locked === true}
                                        title={entry.locked ? '固定を外す（AIが変更できるようにする）' : '固定する（AIが変更しないようにする）'}
                                        aria-label={entry.locked ? '固定を外す' : '固定する'}
                                        style={{ padding: '0.25rem', color: entry.locked ? 'var(--accent-primary)' : 'var(--text-muted)' }}
                                    >
                                        {entry.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-ghost"
                                        onClick={() => removeEntry(entry.key)}
                                        title="この行を削除"
                                        aria-label="この行を削除"
                                        style={{ padding: '0.25rem', color: 'var(--text-muted)' }}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            );
                        })}
                    </section>
                );
            })}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.8rem', color: totalChars > CORE_MEMORY_MAX_CHARS ? 'var(--error)' : 'var(--text-secondary)' }}>
                    {totalChars} / {CORE_MEMORY_MAX_CHARS}文字
                </span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                            setDraft(savedDraft);
                            setNotice(null);
                        }}
                        disabled={!isDirty || isSaving}
                    >
                        元に戻す
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void handleSave()}
                        disabled={!isDirty || problems.length > 0 || isSaving}
                    >
                        {isSaving ? '保存中...' : '保存'}
                    </button>
                </div>
            </div>
            {problems.includes('entryTooLong') && (
                <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>
                    1行は{CORE_MEMORY_ENTRY_MAX_CHARS}文字までです。
                </div>
            )}
            {problems.includes('totalTooLong') && (
                <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>
                    全部で{CORE_MEMORY_MAX_CHARS}文字までです。
                </div>
            )}
            {notice && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{notice}</div>}
            {error && <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>{error}</div>}
        </div>
    );
}
