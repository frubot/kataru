import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';

// ---- Types ----

type SectionId = string;

interface SectionItem {
    id: SectionId;
    // null = 文頭の「見出しなし」本文
    title: string | null;
    level: number;
    body: string;
}

// ---- Helpers ----

let idCounter = 0;
function uid(): SectionId {
    return `ps-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

function readHeadingLevelText(line: string): { level: number; text: string } | null {
    const m = /^(#{1,6})(?:\s+(.*))?$/.exec(line.trimEnd());
    if (!m) return null;
    return { level: m[1].length, text: (m[2] ?? '').trim() };
}

function normalizeCrlf(v: string): string {
    return v.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function cleanBodyText(body: string): string {
    return normalizeCrlf(body)
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/^\n+|\n+$/g, '');
}

export function markdownToSections(markdown: string): SectionItem[] {
    const sections: SectionItem[] = [];
    let title: string | null = null;
    let level = 2;
    let buf: string[] = [];

    const flush = () => {
        const body = buf.join('\n').replace(/^\n+|\n+$/g, '');
        buf = [];
        if (title === null && body === '') return;
        sections.push({ id: uid(), title, level, body });
    };

    for (const raw of normalizeCrlf(markdown).split('\n')) {
        const line = raw.trimEnd();
        const heading = readHeadingLevelText(line);
        if (heading) {
            flush();
            title = heading.text;
            level = heading.level;
        } else {
            buf.push(line);
        }
    }
    flush();
    return sections;
}

export function sectionsToMarkdown(sections: SectionItem[]): string {
    const parts: string[] = [];
    for (const s of sections) {
        const body = cleanBodyText(s.body);
        if (s.title === null) {
            if (body) parts.push(body);
            continue;
        }
        const title = s.title.trim();
        if (!title && !body) continue;
        const head = '#'.repeat(s.level) + (title ? ` ${title}` : '');
        parts.push(body ? `${head}\n\n${body}` : head);
    }
    return parts.join('\n\n');
}

export function ensureEditableSections(sections: SectionItem[]): SectionItem[] {
    if (sections.length === 0) return [{ id: uid(), title: null, level: 2, body: '' }];
    // 見出しなしの本文を先頭以外に置くと直前の項目の本文に吸収されるため、空見出しの項目として扱う。
    return sections.map((s, i) => (i > 0 && s.title === null ? { ...s, title: '' } : s));
}

export function insertSectionAt(sections: SectionItem[], index: number): SectionItem[] {
    const next = [...sections];
    next.splice(index, 0, { id: uid(), title: '', level: 2, body: '' });
    return next;
}

// toIndex は移動前の並びにおける挿入位置（0〜length）。
export function moveSection(sections: SectionItem[], fromIndex: number, toIndex: number): SectionItem[] {
    if (fromIndex < 0 || fromIndex >= sections.length) return sections;
    if (toIndex === fromIndex || toIndex === fromIndex + 1) return sections;
    const next = [...sections];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex > fromIndex ? toIndex - 1 : toIndex, 0, moved);
    return next;
}

function isInsertShortcut(e: KeyboardEvent): boolean {
    return e.key === 'Enter'
        && (e.ctrlKey || e.metaKey)
        && !e.shiftKey
        && !e.altKey
        && !e.nativeEvent.isComposing;
}

function prevFocusable(current: HTMLElement): HTMLElement | null {
    const container = current.closest('[data-prompt-editor]');
    if (!container) return null;
    const inputs = Array.from(container.querySelectorAll<HTMLElement>('[data-focusable="true"]'));
    return inputs[inputs.indexOf(current) - 1] ?? null;
}

// ---- Sub-components ----

interface RowDragProps {
    draggable: boolean;
    onDragStart: (e: DragEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent<HTMLDivElement>) => void;
    onDrop: (e: DragEvent<HTMLDivElement>) => void;
}

function SectionRow({
    section,
    onUpdate,
    onDelete,
    onInsertBelow,
    dragProps,
    onHandlePointerDown,
    dragging,
    placeholder,
}: {
    section: SectionItem;
    onUpdate: (patch: { title?: string | null; body?: string }) => void;
    onDelete: () => void;
    onInsertBelow: () => void;
    dragProps: RowDragProps;
    onHandlePointerDown: () => void;
    dragging: boolean;
    placeholder?: string;
}) {
    const bodyRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const ta = bodyRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 300) + 'px';
    }, [section.body]);

    const handleBodyKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (isInsertShortcut(e)) {
            e.preventDefault();
            onInsertBelow();
            return;
        }
        if (e.key === 'Backspace' && section.body === '') {
            e.preventDefault();
            const prev = prevFocusable(e.currentTarget);
            onDelete();
            setTimeout(() => prev?.focus(), 0);
        }
    };

    return (
        <div className={`prompt-section-row${dragging ? ' dragging' : ''}`} {...dragProps}>
            <span
                className="prompt-section-handle"
                onPointerDown={onHandlePointerDown}
                title="ドラッグして並べ替え"
                aria-hidden="true"
            >
                <GripVertical size={14} />
            </span>
            <input
                className="prompt-section-label"
                data-focusable="true"
                data-section-label="true"
                value={section.title ?? ''}
                onChange={(e) => onUpdate({ title: e.target.value })}
                onKeyDown={(e) => {
                    if (isInsertShortcut(e)) {
                        e.preventDefault();
                        onInsertBelow();
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        bodyRef.current?.focus();
                    }
                }}
                placeholder="見出し"
                aria-label="項目名"
            />
            <textarea
                ref={bodyRef}
                className="prompt-section-body"
                data-focusable="true"
                value={section.body}
                onChange={(e) => onUpdate({ body: e.target.value })}
                onKeyDown={handleBodyKeyDown}
                placeholder={placeholder ?? '内容'}
                rows={1}
            />
            <button
                type="button"
                className="prompt-section-delete"
                onClick={onDelete}
                title="削除"
                aria-label="項目を削除"
            >
                <Trash2 size={14} />
            </button>
        </div>
    );
}

function SectionGap({
    onInsert,
    dropActive,
    onDragOver,
    onDrop,
}: {
    onInsert?: () => void;
    dropActive: boolean;
    onDragOver: (e: DragEvent<HTMLDivElement>) => void;
    onDrop: (e: DragEvent<HTMLDivElement>) => void;
}) {
    return (
        <div
            className={`prompt-section-gap${dropActive ? ' drop-active' : ''}`}
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            {onInsert && (
                <button
                    type="button"
                    className="prompt-section-insert"
                    onClick={onInsert}
                    tabIndex={-1}
                    title="ここに項目を追加"
                    aria-label="ここに項目を追加"
                >
                    <span className="prompt-section-insert-icon"><Plus size={11} /></span>
                </button>
            )}
        </div>
    );
}

function PlainPromptEditor({ markdown, onChange, placeholder }: PromptSectionEditorProps) {
    const bodyRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const ta = bodyRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 300) + 'px';
    }, [markdown]);

    return (
        <div className="prompt-section-list">
            <div className="prompt-section-row prompt-section-row-plain">
                <textarea
                    ref={bodyRef}
                    className="prompt-section-body"
                    value={markdown}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder ?? '内容'}
                    rows={1}
                />
            </div>
        </div>
    );
}

// ---- Main component ----

interface PromptSectionEditorProps {
    markdown: string;
    onChange: (markdown: string) => void;
    placeholder?: string;
    plain?: boolean;
}

export default function PromptSectionEditor(props: PromptSectionEditorProps) {
    return props.plain ? <PlainPromptEditor {...props} /> : <SectionedPromptEditor {...props} />;
}

function SectionedPromptEditor({
    markdown,
    onChange,
    placeholder,
}: PromptSectionEditorProps) {
    const [sections, setSections] = useState<SectionItem[]>(
        () => ensureEditableSections(markdownToSections(markdown)),
    );
    const containerRef = useRef<HTMLDivElement>(null);

    // Sync from external markdown
    useEffect(() => {
        const current = sectionsToMarkdown(sections);
        if (current === markdown) return;
        setSections(ensureEditableSections(markdownToSections(markdown)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [markdown]);

    const emit = (next: SectionItem[]) => {
        const editable = ensureEditableSections(next);
        setSections(editable);
        onChange(sectionsToMarkdown(editable));
    };

    const updateSection = (id: SectionId, patch: { title?: string | null; body?: string }) => {
        emit(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    };

    const deleteSection = (id: SectionId) => {
        emit(sections.filter((s) => s.id !== id));
    };

    // 挿入直後の入力が元の欄に入らないよう、描画直後に新しい項目へフォーカスを移す。
    const pendingFocusIndexRef = useRef<number | null>(null);
    useLayoutEffect(() => {
        const index = pendingFocusIndexRef.current;
        if (index === null) return;
        pendingFocusIndexRef.current = null;
        const labels = containerRef.current?.querySelectorAll<HTMLElement>('[data-section-label="true"]');
        labels?.[index]?.focus();
    }, [sections]);

    const insertAt = (index: number) => {
        pendingFocusIndexRef.current = index;
        emit(insertSectionAt(sections, index));
    };

    // ---- 並べ替え ----

    // つまみを押している行だけ draggable にし、本文の文字選択と干渉しないようにする。
    const [armedIndex, setArmedIndex] = useState<number | null>(null);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);

    useEffect(() => {
        if (armedIndex === null) return;
        const disarm = () => setArmedIndex(null);
        window.addEventListener('pointerup', disarm);
        return () => window.removeEventListener('pointerup', disarm);
    }, [armedIndex]);

    const endDrag = () => {
        setArmedIndex(null);
        setDragIndex(null);
        setDropIndex(null);
    };

    const acceptDrag = (e: DragEvent) => {
        if (dragIndex === null) return false;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        return true;
    };

    const showDropAt = (index: number) => {
        const next = dragIndex !== null && (index === dragIndex || index === dragIndex + 1) ? null : index;
        setDropIndex((current) => (current === next ? current : next));
    };

    const dropAt = (e: DragEvent, index: number) => {
        if (!acceptDrag(e) || dragIndex === null) return;
        emit(moveSection(sections, dragIndex, index));
        endDrag();
    };

    const rowDropIndex = (e: DragEvent<HTMLDivElement>, index: number) => {
        const rect = e.currentTarget.getBoundingClientRect();
        return e.clientY < rect.top + rect.height / 2 ? index : index + 1;
    };

    const rowDragProps = (index: number): RowDragProps => ({
        draggable: armedIndex === index || dragIndex === index,
        onDragStart: (e) => {
            if (armedIndex !== index) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', '');
            setDragIndex(index);
        },
        onDragEnd: endDrag,
        onDragOver: (e) => {
            if (acceptDrag(e)) showDropAt(rowDropIndex(e, index));
        },
        onDrop: (e) => dropAt(e, rowDropIndex(e, index)),
    });

    const gapDropProps = (index: number) => ({
        dropActive: dropIndex === index,
        onDragOver: (e: DragEvent<HTMLDivElement>) => {
            if (acceptDrag(e)) showDropAt(index);
        },
        onDrop: (e: DragEvent<HTMLDivElement>) => dropAt(e, index),
    });

    return (
        <div
            ref={containerRef}
            data-prompt-editor
            className={`prompt-section-list${dragIndex !== null ? ' is-dragging' : ''}`}
            onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null);
            }}
        >
            {sections.map((section, index) => (
                <div key={section.id} className="prompt-section-item">
                    <SectionGap onInsert={() => insertAt(index)} {...gapDropProps(index)} />
                    <SectionRow
                        section={section}
                        onUpdate={(patch) => updateSection(section.id, patch)}
                        onDelete={() => deleteSection(section.id)}
                        onInsertBelow={() => insertAt(index + 1)}
                        dragProps={rowDragProps(index)}
                        onHandlePointerDown={() => setArmedIndex(index)}
                        dragging={dragIndex === index}
                        placeholder={placeholder}
                    />
                </div>
            ))}
            <SectionGap {...gapDropProps(sections.length)} />
            <button type="button" className="prompt-section-add" onClick={() => insertAt(sections.length)}>
                <Plus size={13} /> 項目を追加
            </button>
        </div>
    );
}
