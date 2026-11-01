import { Plus, Trash2 } from 'lucide-react';
import type { WordReplacement } from '@/lib/store';
import {
    MAX_WORD_REPLACEMENT_FROM_CHARS,
    MAX_WORD_REPLACEMENT_TO_CHARS,
    MAX_WORD_REPLACEMENTS,
} from '@/lib/wordReplacements';

interface WordReplacementEditorProps {
    value: WordReplacement[];
    onChange: (value: WordReplacement[]) => void;
}

export default function WordReplacementEditor({ value, onChange }: WordReplacementEditorProps) {
    const updateRule = (index: number, patch: Partial<WordReplacement>) => {
        onChange(value.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {value.map((rule, index) => (
                <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                        type="text"
                        className="input"
                        value={rule.from}
                        maxLength={MAX_WORD_REPLACEMENT_FROM_CHARS}
                        onChange={(event) => updateRule(index, { from: event.target.value })}
                        placeholder="禁止ワード"
                        aria-label={`禁止ワード ${index + 1}`}
                        style={{ flex: 1, minWidth: 0 }}
                    />
                    <span aria-hidden="true" style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>→</span>
                    <input
                        type="text"
                        className="input"
                        value={rule.to}
                        maxLength={MAX_WORD_REPLACEMENT_TO_CHARS}
                        onChange={(event) => updateRule(index, { to: event.target.value })}
                        placeholder="空欄なら削除"
                        aria-label={`置き換え後 ${index + 1}`}
                        style={{ flex: 1, minWidth: 0 }}
                    />
                    <button
                        type="button"
                        className="ai-connection-icon-button"
                        title="この禁止ワードを削除"
                        aria-label={`禁止ワード ${index + 1} を削除`}
                        onClick={() => onChange(value.filter((_, i) => i !== index))}
                    >
                        <Trash2 size={16} aria-hidden="true" />
                    </button>
                </div>
            ))}
            <div>
                <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={value.length >= MAX_WORD_REPLACEMENTS}
                    onClick={() => onChange([...value, { from: '', to: '' }])}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}
                >
                    <Plus size={14} aria-hidden="true" />
                    追加
                </button>
            </div>
        </div>
    );
}
