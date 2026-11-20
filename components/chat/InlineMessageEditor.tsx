import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

type InlineMessageEditorProps = {
    value: string;
    onChange: (value: string) => void;
    onCancel: () => void;
    onSubmit: () => void;
    disabled?: boolean;
    submitDisabled?: boolean;
    submitLabel: string;
    submitIcon: ReactNode;
    className?: string;
};

/** 会話中のメッセージをその場で書き換える入力欄。 */
export default function InlineMessageEditor({
    value,
    onChange,
    onCancel,
    onSubmit,
    disabled = false,
    submitDisabled = false,
    submitLabel,
    submitIcon,
    className,
}: InlineMessageEditorProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, []);

    return (
        <form
            className={className ? `inline-message-editor ${className}` : 'inline-message-editor'}
            onSubmit={(e) => {
                e.preventDefault();
                if (disabled || submitDisabled) return;
                onSubmit();
            }}
        >
            <textarea
                ref={textareaRef}
                className="input inline-message-edit-input"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
                    // 会話ログなど、Escapeで閉じる親の画面まで閉じないようにする。
                    e.preventDefault();
                    e.stopPropagation();
                    onCancel();
                }}
                disabled={disabled}
                rows={Math.min(8, Math.max(2, value.split('\n').length))}
            />
            <div className="inline-message-edit-actions">
                <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={onCancel}
                    disabled={disabled}
                >
                    <X size={14} />
                    キャンセル
                </button>
                <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={disabled || submitDisabled}
                >
                    {submitIcon}
                    {submitLabel}
                </button>
            </div>
        </form>
    );
}
