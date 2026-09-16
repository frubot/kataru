import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';

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

function ensureEditableSections(sections: SectionItem[]): SectionItem[] {
    return sections.length > 0
        ? sections
        : [{ id: uid(), title: null, level: 2, body: '' }];
}

function prevFocusable(current: HTMLElement): HTMLElement | null {
    const container = current.closest('[data-prompt-editor]');
    if (!container) return null;
    const inputs = Array.from(container.querySelectorAll<HTMLElement>('[data-focusable="true"]'));
    return inputs[inputs.indexOf(current) - 1] ?? null;
}

// ---- Sub-components ----

function SectionRow({
    section,
    onUpdate,
    onDelete,
    placeholder,
}: {
    section: SectionItem;
    onUpdate: (patch: { title?: string | null; body?: string }) => void;
    onDelete: () => void;
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
        if (e.key === 'Backspace' && section.body === '') {
            e.preventDefault();
            const prev = prevFocusable(e.currentTarget);
            onDelete();
            setTimeout(() => prev?.focus(), 0);
        }
    };

    return (
        <div className="prompt-section-row">
            <input
                className="prompt-section-label"
                data-focusable="true"
                data-section-label="true"
                value={section.title ?? ''}
                onChange={(e) => onUpdate({ title: e.target.value })}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
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

// ---- Main component ----

interface PromptSectionEditorProps {
    markdown: string;
    onChange: (markdown: string) => void;
    placeholder?: string;
}

export default function PromptSectionEditor({
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

    const appendSection = () => {
        emit([...sections, { id: uid(), title: '', level: 2, body: '' }]);
        setTimeout(() => {
            const labels = containerRef.current?.querySelectorAll<HTMLElement>('[data-section-label="true"]');
            labels?.[labels.length - 1]?.focus();
        }, 0);
    };

    return (
        <div ref={containerRef} data-prompt-editor className="prompt-section-list">
            {sections.map((section) => (
                <SectionRow
                    key={section.id}
                    section={section}
                    onUpdate={(patch) => updateSection(section.id, patch)}
                    onDelete={() => deleteSection(section.id)}
                    placeholder={placeholder}
                />
            ))}
            <button type="button" className="prompt-section-add" onClick={appendSection}>
                <Plus size={13} /> 項目を追加
            </button>
        </div>
    );
}
