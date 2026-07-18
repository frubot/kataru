import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Trash2, Plus, List, Type, Heading } from 'lucide-react';

// ---- Types ----

type BlockId = string;

type PromptBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bulletList'; items: string[] };

type BlockItem = PromptBlock & { id: BlockId };

interface Group {
  headingId: BlockId | null;
  blocks: BlockItem[];
}

// ---- Helpers ----

let idCounter = 0;
function uid(): BlockId {
  return `pb-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

function readHeadingLevelText(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line.trimEnd());
  if (!m) return null;
  return { level: m[1].length, text: m[2].trim() };
}

function normalizeCrlf(v: string): string {
  return v.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function markdownToBlockItems(markdown: string): BlockItem[] {
  const raw = normalizeCrlf(markdown);
  const lines = raw.split('\n');
  const items: BlockItem[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    if (trimmed === '') {
      i++;
      continue;
    }

    const heading = readHeadingLevelText(trimmed);
    if (heading) {
      items.push({ type: 'heading', level: heading.level, text: heading.text, id: uid() });
      i++;
      continue;
    }

    const listMatch = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (listMatch) {
      const listItems: string[] = [listMatch[1].trim()];
      i++;
      while (i < lines.length) {
        const next = lines[i].trimEnd();
        if (next === '') {
          i++;
          continue;
        }
        const nm = /^[-*+]\s+(.*)$/.exec(next);
        if (!nm) break;
        listItems.push(nm[1].trim());
        i++;
      }
      items.push({ type: 'bulletList', items: listItems, id: uid() });
      continue;
    }

    const paraLines: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const next = lines[i].trimEnd();
      if (next === '') {
        i++;
        break;
      }
      if (readHeadingLevelText(next) || /^[-*+]\s+/.test(next)) break;
      paraLines.push(next);
      i++;
    }
    items.push({ type: 'paragraph', text: paraLines.join('\n'), id: uid() });
  }

  return items;
}

export function blockItemsToMarkdown(items: BlockItem[]): string {
  const out: string[] = [];
  for (const b of items) {
    switch (b.type) {
      case 'heading':
        out.push(`${'#'.repeat(b.level)} ${b.text}`);
        break;
      case 'paragraph':
        out.push(b.text);
        break;
      case 'bulletList':
        for (const item of b.items) out.push(`- ${item}`);
        break;
    }
  }
  return out.join('\n\n');
}

function groupBlocks(items: BlockItem[]): Group[] {
  const groups: Group[] = [];
  let cur: Group = { headingId: null, blocks: [] };

  for (const b of items) {
    if (b.type === 'heading') {
      if (cur.headingId !== null || cur.blocks.length > 0) groups.push(cur);
      cur = { headingId: b.id, blocks: [b] };
    } else {
      cur.blocks.push(b);
    }
  }
  if (cur.headingId !== null || cur.blocks.length > 0) groups.push(cur);
  return groups;
}

function focusNextInput(current: HTMLElement, direction: 'next' | 'prev' = 'next') {
  const container = current.closest('[data-prompt-editor]') as HTMLElement | null;
  if (!container) return;
  const inputs = Array.from(container.querySelectorAll<HTMLElement>('[data-focusable="true"]'));
  const idx = inputs.indexOf(current);
  if (idx === -1) return;
  const target = inputs[direction === 'next' ? idx + 1 : idx - 1];
  if (target) {
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const len = target.value.length;
      target.setSelectionRange(len, len);
    }
  }
}

function focusFirstInput(container: HTMLElement | null) {
  if (!container) return;
  const first = container.querySelector<HTMLElement>('[data-focusable="true"]');
  first?.focus({ preventScroll: true });
}

// ---- Sub-components ----

function HeadingRow({
  text,
  isOpen,
  onToggle,
  onChangeText,
  onDelete,
  onInsertAfter,
}: {
  text: string;
  isOpen: boolean;
  onToggle: () => void;
  onChangeText: (v: string) => void;
  onDelete: () => void;
  onInsertAfter: (block: PromptBlock) => void;
}) {
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        borderRadius: '0.5rem',
        background: hover ? 'color-mix(in srgb, var(--bg-primary) 88%, var(--bg-hover))' : 'var(--bg-primary)',
        border: 'none',
        transform: hover ? 'translateY(-1px)' : 'translateY(0)',
        transition: 'background 0.18s ease, transform 0.18s ease',
      }}
    >
      <motion.span
        data-role="toggle"
        animate={{ rotate: isOpen ? 0 : -90 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          flexShrink: 0,
          cursor: 'pointer',
          width: '20px',
          height: '20px',
          borderRadius: '0.25rem',
          transition: 'background 0.12s ease',
        }}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(var(--text-muted-rgb), 0.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <ChevronDown size={16} />
      </motion.span>
      <input
        ref={inputRef}
        data-focusable="true"
        value={text}
        onChange={(e) => onChangeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onInsertAfter({ type: 'paragraph', text: '' });
          }
        }}
        placeholder="セクション名"
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--text-primary)',
          fontSize: '0.9375rem',
          fontWeight: 600,
          padding: 0,
          paddingRight: '2rem',
          cursor: 'text',
        }}
      />
      {hover && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="削除"
          style={{
            position: 'absolute',
            right: '0.75rem',
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0.25rem',
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            borderRadius: '0.375rem',
            transition: 'color 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--error)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function ParagraphRow({
  text,
  onChange,
  onDelete,
  onInsertAfter,
}: {
  text: string;
  onChange: (v: string) => void;
  onDelete: () => void;
  onInsertAfter: (block: PromptBlock) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 300) + 'px';
  }, [text]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onInsertAfter({ type: 'paragraph', text: '' });
      setTimeout(() => focusNextInput(e.currentTarget, 'next'), 0);
    }
    if (e.key === 'Backspace' && text === '') {
      e.preventDefault();
      const el = e.currentTarget;
      onDelete();
      setTimeout(() => focusNextInput(el, 'prev'), 0);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.25rem',
      }}
    >
      <textarea
        ref={taRef}
        data-focusable="true"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="テキスト"
        rows={1}
        style={{
          flex: 1,
          minWidth: 0,
          resize: 'none',
          overflow: 'auto',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--text-primary)',
          fontSize: '0.875rem',
          lineHeight: 1.6,
          padding: '1.25rem 0 0.375rem 0',
          fontFamily: 'inherit',
          cursor: 'text',
          touchAction: 'pan-y',
          overscrollBehavior: 'contain',
          maxHeight: '300px',
        }}
      />
    </div>
  );
}

function ListBlock({
  items,
  onChange,
  onDelete,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  onDelete: () => void;
}) {
  const itemsRef = useRef<(HTMLInputElement | null)[]>([]);

  const updateItem = (index: number, value: string) => {
    const next = [...items];
    next[index] = value;
    onChange(next);
  };

  const addItemAt = (index: number) => {
    const next = [...items];
    next.splice(index + 1, 0, '');
    onChange(next);
    setTimeout(() => {
      itemsRef.current[index + 1]?.focus();
    }, 0);
  };

  const removeItemAt = (index: number, focusPrev: boolean) => {
    if (items.length === 1) {
      const el = itemsRef.current[index];
      onDelete();
      if (el) setTimeout(() => focusNextInput(el, 'prev'), 0);
      return;
    }
    const next = items.filter((_, i) => i !== index);
    onChange(next);
    if (focusPrev && index > 0) {
      setTimeout(() => {
        const el = itemsRef.current[index - 1];
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }, 0);
    }
  };

  return (
    <div style={{ padding: '0.125rem 0' }}>
      {items.map((item, idx) => (
        <div
          key={idx}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            padding: '0.25rem 0',
          }}
        >
          <span
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.875rem',
              userSelect: 'none',
              flexShrink: 0,
              width: '1rem',
              textAlign: 'center',
              paddingTop: '0.125rem',
            }}
          >
            •
          </span>
          <input
            ref={(el) => { itemsRef.current[idx] = el; }}
            data-focusable="true"
            value={item}
            onChange={(e) => updateItem(idx, e.target.value)}
            onKeyDown={(e) => {
              const target = e.currentTarget;
              if (e.key === 'Enter') {
                e.preventDefault();
                addItemAt(idx);
              }
              if (e.key === 'Backspace' && item === '') {
                e.preventDefault();
                removeItemAt(idx, true);
              }
              if (e.key === 'Backspace' && target.selectionStart === 0 && target.selectionEnd === 0 && item !== '') {
                e.preventDefault();
                if (idx > 0) {
                  const prev = items[idx - 1];
                  const merged = prev + item;
                  const next = [...items];
                  next[idx - 1] = merged;
                  next.splice(idx, 1);
                  onChange(next);
                  setTimeout(() => {
                    const el = itemsRef.current[idx - 1];
                    if (el) {
                      el.focus();
                      el.setSelectionRange(prev.length, prev.length);
                    }
                  }, 0);
                }
              }
            }}
            placeholder="リスト項目"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontSize: '0.875rem',
              padding: '1.25rem 0 0.25rem 0',
              fontFamily: 'inherit',
              cursor: 'text',
              touchAction: 'pan-x',
            }}
          />
        </div>
      ))}
      {/* Ghost row to add item */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.375rem',
          padding: '0.25rem 0',
          cursor: 'pointer',
          opacity: 0.5,
          transition: 'opacity 0.15s ease',
        }}
        onClick={() => addItemAt(items.length - 1)}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
      >
        <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem', userSelect: 'none', flexShrink: 0, width: '1rem', textAlign: 'center' }}>+</span>
        <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>項目を追加...</span>
      </div>
    </div>
  );
}

function BlockRow({
  block,
  onUpdate,
  onDelete,
  onInsertAfter,
  onConvertType,
}: {
  block: BlockItem;
  onUpdate: (next: BlockItem) => void;
  onDelete: () => void;
  onInsertAfter: (block: PromptBlock) => void;
  onConvertType: () => void;
}) {
  const [hover, setHover] = useState(false);
  if (block.type === 'heading') return null;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.25rem',
        padding: '0.125rem 0',
        borderRadius: '0.375rem',
        transition: 'background 0.12s ease',
        background: hover ? 'rgba(var(--accent-primary-rgb), 0.04)' : 'transparent',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {block.type === 'paragraph' && (
          <ParagraphRow
            text={block.text}
            onChange={(text) => onUpdate({ ...block, text })}
            onDelete={onDelete}
            onInsertAfter={onInsertAfter}
          />
        )}
        {block.type === 'bulletList' && (
          <ListBlock
            items={block.items}
            onChange={(items) => onUpdate({ ...block, items })}
            onDelete={onDelete}
          />
        )}
      </div>
      {hover && (
        <div style={{ position: 'absolute', right: 0, top: '0.125rem', display: 'flex', alignItems: 'flex-start', gap: '0.125rem', paddingTop: '0.25rem' }}>
          <button
            type="button"
            onClick={onConvertType}
            title={block.type === 'paragraph' ? 'リストに変換' : 'テキストに変換'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0.25rem',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              borderRadius: '0.375rem',
              transition: 'color 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            {block.type === 'paragraph' ? <List size={14} /> : <Type size={14} />}
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="削除"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0.25rem',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              borderRadius: '0.375rem',
              transition: 'color 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--error)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function AddBlockButton({
  onAdd,
  onlyHeading,
}: {
  onAdd: (block: PromptBlock) => void;
  onlyHeading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.375rem 0.75rem',
    borderRadius: '0.5rem',
    border: 'none',
    background: 'var(--bg-primary)',
    color: 'var(--text-muted)',
    fontSize: '0.8125rem',
    cursor: 'pointer',
    width: '100%',
    justifyContent: 'center',
    transition: 'background 0.15s ease, color 0.15s ease',
  };

  const setButtonHover = (button: HTMLButtonElement, active: boolean) => {
    button.style.background = active
      ? 'color-mix(in srgb, var(--bg-primary) 88%, var(--bg-hover))'
      : 'var(--bg-primary)';
    button.style.color = active ? 'var(--accent-primary)' : 'var(--text-muted)';
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  const handleHeading = () => {
    onAdd({ type: 'heading', level: 2, text: '' });
    setOpen(false);
  };

  if (onlyHeading) {
    return (
      <button
        type="button"
        onClick={handleHeading}
        style={buttonStyle}
        onMouseEnter={(e) => setButtonHover(e.currentTarget, true)}
        onMouseLeave={(e) => setButtonHover(e.currentTarget, false)}
      >
        <Plus size={14} /> セクション見出しを追加
      </button>
    );
  }

  return (
    <div
      ref={ref}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={buttonStyle}
        onMouseEnter={(e) => setButtonHover(e.currentTarget, true)}
        onMouseLeave={(e) => setButtonHover(e.currentTarget, false)}
      >
        <Plus size={14} /> ブロックを追加
      </button>
      {open && (
        <div
          style={{
            background: 'var(--bg-primary)',
            border: 'none',
            borderRadius: '0.5rem',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            padding: '0.375rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem',
          }}
        >
          <MiniMenuItem icon={<Type size={14} />} label="テキスト" onClick={() => { onAdd({ type: 'paragraph', text: '' }); setOpen(false); }} />
          <MiniMenuItem icon={<List size={14} />} label="リスト" onClick={() => { onAdd({ type: 'bulletList', items: [''] }); setOpen(false); }} />
          <MiniMenuItem icon={<Heading size={14} />} label="セクション見出し" onClick={() => { onAdd({ type: 'heading', level: 2, text: '' }); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

function MiniMenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.5rem 0.625rem',
        borderRadius: '0.375rem',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'var(--text-secondary)',
        fontSize: '0.8125rem',
        textAlign: 'left',
        width: '100%',
        transition: 'background 0.12s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
    >
      {icon}
      {label}
    </button>
  );
}

// ---- Main component ----

interface PromptBlockEditorProps {
  markdown: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  frame?: boolean;
  minHeight?: React.CSSProperties['minHeight'];
  maxHeight?: React.CSSProperties['maxHeight'] | null;
}

export default function PromptBlockEditor({
  markdown,
  onChange,
  placeholder,
  frame = true,
  minHeight = '150px',
  maxHeight,
}: PromptBlockEditorProps) {
  const [items, setItems] = useState<BlockItem[]>(() => markdownToBlockItems(markdown));
  const [openMap, setOpenMap] = useState<Record<BlockId, boolean>>(() => ({}));
  const containerRef = useRef<HTMLDivElement>(null);
  const effectiveMaxHeight = maxHeight === undefined ? 'min(450px, 60vh)' : maxHeight;
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    border: frame ? '1px solid var(--border-color)' : 'none',
    borderRadius: frame ? '0.5rem' : 0,
    padding: frame ? '0.75rem' : 0,
    background: frame ? 'var(--bg-primary)' : 'transparent',
    minHeight,
  };
  if (effectiveMaxHeight !== null) {
    containerStyle.maxHeight = effectiveMaxHeight;
    containerStyle.overflowY = 'auto';
  }

  // Sync from external markdown
  useEffect(() => {
    const current = blockItemsToMarkdown(items);
    if (current === markdown) return;
    const next = markdownToBlockItems(markdown);
    setItems(next);
    setOpenMap((prev) => {
      const map: Record<BlockId, boolean> = {};
      for (const b of next) {
        if (b.type === 'heading') {
          map[b.id] = prev[b.id] ?? false;
        }
      }
      return map;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown]);

  const emit = (next: BlockItem[]) => {
    setItems(next);
    onChange(blockItemsToMarkdown(next));
  };

  const toggleHeading = (id: BlockId) => {
    setOpenMap((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const updateBlock = (id: BlockId, patch: Partial<PromptBlock>) => {
    const next = items.map((b) => (b.id === id ? ({ ...b, ...patch } as BlockItem) : b));
    emit(next);
  };

  const deleteBlock = (id: BlockId) => {
    const idx = items.findIndex((b) => b.id === id);
    if (idx === -1) return;
    const target = items[idx];

    let endIdx = idx + 1;
    if (target.type === 'heading') {
      // Delete this heading and all blocks that belong to it (until next heading or end)
      while (endIdx < items.length && items[endIdx].type !== 'heading') {
        endIdx++;
      }
    }

    const next = [...items];
    next.splice(idx, endIdx - idx);
    emit(next);
  };

  const insertAfter = (afterId: BlockId, block: PromptBlock) => {
    const idx = items.findIndex((b) => b.id === afterId);
    if (idx === -1) return;
    const next = [...items];
    next.splice(idx + 1, 0, { ...block, id: uid() });
    emit(next);
    setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      const all = Array.from(container.querySelectorAll<HTMLElement>('[data-focusable="true"]'));
      const target = all[idx + 1];
      target?.focus();
    }, 0);
  };

  const appendToRoot = (block: PromptBlock) => {
    const next = [...items, { ...block, id: uid() }];
    emit(next);
    setTimeout(() => {
      focusFirstInput(containerRef.current);
    }, 0);
  };

  const convertBlockType = (id: BlockId) => {
    const block = items.find((b) => b.id === id);
    if (!block) return;
    let nextBlock: BlockItem;
    if (block.type === 'paragraph') {
      nextBlock = { type: 'bulletList', items: block.text ? [block.text] : [''], id: block.id } as BlockItem;
    } else if (block.type === 'bulletList') {
      nextBlock = { type: 'paragraph', text: block.items.join('\n'), id: block.id } as BlockItem;
    } else {
      return;
    }
    const next = items.map((b) => (b.id === id ? nextBlock : b));
    emit(next);
  };

  const groups = useMemo(() => groupBlocks(items), [items]);

  const emptyState = items.length === 0;

  return (
    <div
      ref={containerRef}
      data-prompt-editor
      style={containerStyle}
    >
      {emptyState && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {placeholder && (
            <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)', padding: '0.5rem 0' }}>{placeholder}</div>
          )}
          <AddBlockButton onAdd={appendToRoot} onlyHeading />
        </div>
      )}

      {groups.map((group, gi) => {
        const headingBlockRaw = group.headingId ? items.find((b) => b.id === group.headingId) : null;
        const headingBlock = headingBlockRaw && headingBlockRaw.type === 'heading' ? headingBlockRaw : null;
        const isOpen = headingBlock ? (openMap[headingBlock.id] ?? false) : true;

        return (
          <div key={group.headingId ?? `ungrouped-${gi}`} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {headingBlock && (
              <HeadingRow
                text={headingBlock.text}
                isOpen={isOpen}
                onToggle={() => toggleHeading(headingBlock.id)}
                onChangeText={(text) => updateBlock(headingBlock.id, { text })}
                onDelete={() => deleteBlock(headingBlock.id)}
                onInsertAfter={(block) => insertAfter(headingBlock.id, block)}
              />
            )}

            <AnimatePresence initial={false}>
              {(isOpen || !headingBlock) && (
                <motion.div
                  key="content"
                  initial={headingBlock ? { height: 0, opacity: 0, y: -4 } : false}
                  animate={{
                    height: 'auto',
                    opacity: 1,
                    y: 0,
                    transitionEnd: { overflow: 'visible' },
                  }}
                  exit={headingBlock ? { height: 0, opacity: 0, y: -4 } : undefined}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                  style={{ overflow: headingBlock ? 'hidden' : 'visible' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.125rem',
                      paddingLeft: headingBlock ? '1rem' : undefined,
                      marginLeft: headingBlock ? '0.375rem' : undefined,
                      paddingTop: '0.25rem',
                      paddingBottom: '0.25rem',
                    }}
                  >
                    {group.blocks
                      .filter((b) => b.type !== 'heading')
                      .map((b) => (
                        <BlockRow
                          key={b.id}
                          block={b}
                          onUpdate={(next) => updateBlock(b.id, next as PromptBlock)}
                          onDelete={() => deleteBlock(b.id)}
                          onInsertAfter={(block) => insertAfter(b.id, block)}
                          onConvertType={() => convertBlockType(b.id)}
                        />
                      ))}

                    {isOpen && (
                      <div style={{ marginTop: '0.25rem' }}>
                        <AddBlockButton
                          onAdd={(block) => {
                            const lastId = group.blocks.filter((b) => b.type !== 'heading').at(-1)?.id ?? headingBlock?.id;
                            if (lastId) insertAfter(lastId, block);
                            else appendToRoot(block);
                          }}
                        />
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}

      {!emptyState && (
        <div style={{ marginTop: '0.25rem' }}>
          <AddBlockButton onAdd={appendToRoot} onlyHeading />
        </div>
      )}
    </div>
  );
}
