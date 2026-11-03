import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import * as db from '@/lib/db';
import { useStore } from '@/lib/store';
import type { CoreMemory, CoreMemorySection } from '@/lib/store';
import {
    CORE_MEMORY_ENTRY_MAX_CHARS,
    CORE_MEMORY_SECTIONS,
    coreMemoryDraftProblems,
    coreMemorySectionToText,
    emptyCoreMemory,
    isLockedCoreMemoryLine,
    parseCoreMemorySectionText,
    tooLongCoreMemoryLines,
    totalCoreMemoryChars,
} from '@/lib/coreMemory';

interface CoreMemoryEditorProps {
    characterId: string;
}

/** 見出しごとのテキストエリアの中身。 */
type SectionTexts = Record<CoreMemorySection, string>;

function toTexts(memory: CoreMemory): SectionTexts {
    return {
        user: coreMemorySectionToText(memory.entries, 'user'),
        relationship: coreMemorySectionToText(memory.entries, 'relationship'),
        self: coreMemorySectionToText(memory.entries, 'self'),
    };
}

function sameTexts(left: SectionTexts, right: SectionTexts): boolean {
    return CORE_MEMORY_SECTIONS.every(({ value }) => left[value] === right[value]);
}

/** テキストエリアと下敷きで同じにする文字まわりの見た目。ずれると色が行からはみ出す。 */
const FIELD_TEXT_STYLE: CSSProperties = {
    margin: 0,
    padding: '0.75rem 1rem',
    fontFamily: 'inherit',
    fontSize: '0.875rem',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
};

interface SectionTextareaProps {
    id: string;
    value: string;
    onChange: (value: string) => void;
}

/**
 * 固定した行（頭に `!`）に色を付けるテキストエリア。
 * テキストエリアは行ごとに色を変えられないので、裏に同じ文字並びの下敷きを置き、
 * 固定した行だけ下敷きに色を塗る。中でスクロールすると下敷きとずれるので、
 * テキストエリアは中身に合わせて高さを伸ばす。
 */
function SectionTextarea({ id, value, onChange }: SectionTextareaProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // 枠線の上下1pxずつを足して、中身がちょうど収まる高さにする。
    const fitHeight = useCallback(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight + 2}px`;
    }, []);

    useLayoutEffect(fitHeight, [fitHeight, value]);

    // 幅が変わると折り返しが変わるので、高さを合わせ直す。
    useEffect(() => {
        window.addEventListener('resize', fitHeight);
        return () => window.removeEventListener('resize', fitHeight);
    }, [fitHeight]);

    return (
        <div style={{ position: 'relative', background: 'var(--bg-secondary)', borderRadius: '0.5rem' }}>
            <div
                aria-hidden="true"
                style={{
                    ...FIELD_TEXT_STYLE,
                    // テキストエリアの枠線と同じ幅を空けておく。
                    border: '1px solid transparent',
                    position: 'absolute',
                    inset: 0,
                    overflow: 'hidden',
                    color: 'transparent',
                    pointerEvents: 'none',
                }}
            >
                {value.split('\n').map((line, index) => (
                    <div
                        key={index}
                        style={isLockedCoreMemoryLine(line) ? {
                            background: 'rgba(var(--accent-primary-rgb), 0.18)',
                            borderRadius: '0.25rem',
                            margin: '0 -0.375rem',
                            padding: '0 0.375rem',
                        } : undefined}
                    >
                        {line || ' '}
                    </div>
                ))}
            </div>
            <textarea
                ref={textareaRef}
                id={id}
                className="input textarea"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                rows={3}
                placeholder="まだありません"
                spellCheck={false}
                style={{
                    ...FIELD_TEXT_STYLE,
                    position: 'relative',
                    display: 'block',
                    width: '100%',
                    minHeight: 0,
                    resize: 'none',
                    overflow: 'hidden',
                    background: 'transparent',
                }}
            />
        </div>
    );
}

export default function CoreMemoryEditor({ characterId }: CoreMemoryEditorProps) {
    const maxChars = useStore((state) => state.coreMemoryMaxChars);
    const [saved, setSaved] = useState<CoreMemory>(() => emptyCoreMemory(characterId));
    const [savedTexts, setSavedTexts] = useState<SectionTexts>(() => toTexts(emptyCoreMemory(characterId)));
    const [texts, setTexts] = useState<SectionTexts>(savedTexts);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const applyLoaded = useCallback((memory: CoreMemory | null) => {
        const next = memory ?? emptyCoreMemory(characterId);
        const nextTexts = toTexts(next);
        setSaved(next);
        setSavedTexts(nextTexts);
        setTexts(nextTexts);
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

    const entries = useMemo(
        () => CORE_MEMORY_SECTIONS.flatMap(({ value }) => parseCoreMemorySectionText(texts[value], value, saved.entries)),
        [saved.entries, texts],
    );
    const totalChars = useMemo(() => totalCoreMemoryChars(entries), [entries]);
    const problems = useMemo(() => coreMemoryDraftProblems(entries, maxChars), [entries, maxChars]);
    const isDirty = !sameTexts(texts, savedTexts);

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
                entries,
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
                行の頭に「!」を付けると、その行はAIが変更しません。
            </p>

            {CORE_MEMORY_SECTIONS.map((section) => {
                const text = texts[section.value];
                const sectionChars = totalCoreMemoryChars(
                    entries.filter((entry) => entry.section === section.value),
                );
                const longLines = tooLongCoreMemoryLines(text);
                return (
                    <section key={section.value} style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                        <label
                            htmlFor={`core-memory-${section.value}`}
                            style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}
                        >
                            <span>
                                <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{section.label}</span>
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{section.hint}</span>
                            </span>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>{sectionChars}文字</span>
                        </label>
                        <SectionTextarea
                            id={`core-memory-${section.value}`}
                            value={text}
                            onChange={(value) => setTexts((current) => ({ ...current, [section.value]: value }))}
                        />
                        {longLines.length > 0 && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>
                                {longLines.join('・')}行目が{CORE_MEMORY_ENTRY_MAX_CHARS}文字を超えています。
                            </div>
                        )}
                    </section>
                );
            })}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.8rem', color: totalChars > maxChars ? 'var(--error)' : 'var(--text-secondary)' }}>
                    {totalChars} / {maxChars}文字
                </span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                            setTexts(savedTexts);
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
            {problems.includes('totalTooLong') && (
                <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>
                    全部で{maxChars}文字までです。上限はグローバル設定で変えられます。
                </div>
            )}
            {notice && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{notice}</div>}
            {error && <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>{error}</div>}
        </div>
    );
}
