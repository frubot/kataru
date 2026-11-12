import { useRef, useState, type CSSProperties } from 'react';

interface SliderValueInputProps {
    /** 現在の値（保存単位）。編集開始時の初期値に使う */
    value: number;
    /** 非編集時に表示する文字列 */
    label: string;
    /** 受け付ける範囲（保存単位）。範囲外の入力は丸める */
    min: number;
    max: number;
    /** 編集単位での小数桁数。0なら整数 */
    decimals: number;
    /** 編集単位 = 保存単位 × scale（例: 音量 0〜1 を % で編集するなら 100） */
    scale?: number;
    /** 編集中に入力欄の右に表示する単位 */
    unit?: string;
    color: string;
    disabled?: boolean;
    ariaLabel: string;
    onCommit: (value: number) => void;
}

const baseTextStyle: CSSProperties = {
    fontSize: '0.8125rem',
    fontWeight: 600,
    minWidth: '3.5rem',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
};

function formatEditValue(value: number, decimals: number): string {
    const fixed = value.toFixed(decimals);
    // 末尾の不要な0は消して入力しやすくする
    return decimals > 0 ? String(Number(fixed)) : fixed;
}

/** スライダーの数値表示。クリックするとキーボードで直接入力できる。 */
export default function SliderValueInput({
    value,
    label,
    min,
    max,
    decimals,
    scale = 1,
    unit,
    color,
    disabled = false,
    ariaLabel,
    onCommit,
}: SliderValueInputProps) {
    const [draft, setDraft] = useState<string | null>(null);
    const cancelledRef = useRef(false);

    const startEditing = () => {
        if (disabled) return;
        cancelledRef.current = false;
        setDraft(formatEditValue(value * scale, decimals));
    };

    const commit = () => {
        if (draft === null) return;
        const text = draft.trim().replace(/[０-９．－]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) - 0xFEE0),
        ).replace(/[%x×件回]$/i, '').trim();
        setDraft(null);
        if (cancelledRef.current || text === '') return;
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) return;
        const factor = 10 ** decimals;
        const rounded = Math.round(parsed * factor) / factor;
        const stored = Math.max(min, Math.min(max, rounded / scale));
        if (stored !== value) onCommit(stored);
    };

    if (draft !== null) {
        return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', justifyContent: 'flex-end' }}>
                <input
                    type="text"
                    inputMode={decimals > 0 ? 'decimal' : 'numeric'}
                    aria-label={ariaLabel}
                    value={draft}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            e.currentTarget.blur();
                        } else if (e.key === 'Escape') {
                            // モーダル自体が閉じないようにする
                            e.preventDefault();
                            e.stopPropagation();
                            cancelledRef.current = true;
                            e.currentTarget.blur();
                        }
                    }}
                    style={{
                        ...baseTextStyle,
                        width: '3.5rem',
                        padding: '0.0625rem 0.25rem',
                        border: '1px solid var(--accent-primary)',
                        borderRadius: '4px',
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        outline: 'none',
                    }}
                />
                {unit && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{unit}</span>
                )}
            </span>
        );
    }

    return (
        <button
            type="button"
            onClick={startEditing}
            disabled={disabled}
            title={disabled ? undefined : 'クリックして数値を入力'}
            aria-label={`${ariaLabel}を数値で入力（現在: ${label}）`}
            style={{
                ...baseTextStyle,
                color,
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: disabled ? 'default' : 'text',
                textDecoration: disabled ? 'none' : 'underline dotted',
                textUnderlineOffset: '3px',
                textDecorationColor: 'var(--text-muted)',
                fontFamily: 'inherit',
            }}
        >
            {label}
        </button>
    );
}
