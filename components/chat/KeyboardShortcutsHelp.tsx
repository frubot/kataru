import { useEffect, useRef, useState } from 'react';
import { CircleHelp, X } from 'lucide-react';
import { useModalKeyboard } from '../useModalKeyboard';

type ShortcutContext = {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    isComposing: boolean;
    editableTarget: boolean;
    modalOpen: boolean;
};

export function shouldOpenKeyboardShortcutsHelp(context: ShortcutContext): boolean {
    return context.key === '?'
        && !context.ctrlKey
        && !context.metaKey
        && !context.altKey
        && !context.isComposing
        && !context.editableTarget
        && !context.modalOpen;
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.matches('input, textarea, select, [contenteditable="true"]')
        || target.closest('[contenteditable="true"]') != null;
}

const shortcuts = [
    { keys: ['Enter'], description: 'メッセージを送信（デスクトップ）' },
    { keys: ['Shift', 'Enter'], description: '入力欄で改行' },
    { keys: ['文字入力'], description: 'チャット入力欄へフォーカス（デスクトップ）' },
    { keys: ['Enter / Space'], description: 'ゲームモードの文字送りを完了' },
    { keys: ['Esc'], description: '最前面のメニューやダイアログを閉じる' },
    { keys: ['?'], description: 'このショートカット一覧を表示' },
];

export default function KeyboardShortcutsHelp() {
    const [open, setOpen] = useState(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    useModalKeyboard({
        isOpen: open,
        containerRef: dialogRef,
        onClose: () => setOpen(false),
    });

    useEffect(() => {
        if (open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!shouldOpenKeyboardShortcutsHelp({
                key: event.key,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
                isComposing: event.isComposing,
                editableTarget: isEditableTarget(event.target),
                modalOpen: document.querySelector('[aria-modal="true"]') != null,
            })) return;
            event.preventDefault();
            setOpen(true);
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open]);

    return (
        <>
            <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setOpen(true)}
                title="キーボードショートカット (?)"
                aria-label="キーボードショートカットを表示"
                aria-haspopup="dialog"
                aria-expanded={open}
            >
                <CircleHelp size={18} />
            </button>
            {open && (
                <div
                    className="modal-overlay"
                    onPointerDown={(event) => {
                        if (event.target === event.currentTarget) setOpen(false);
                    }}
                >
                    <div
                        ref={dialogRef}
                        className="modal-content"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="keyboard-shortcuts-title"
                        style={{ maxWidth: 520 }}
                    >
                        <div className="modal-header">
                            <h2 id="keyboard-shortcuts-title" style={{ fontSize: '1.125rem', fontWeight: 600 }}>
                                キーボードショートカット
                            </h2>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => setOpen(false)}
                                title="閉じる"
                                aria-label="閉じる"
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div className="modal-body">
                            <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(7rem, auto) 1fr', gap: '0.875rem 1rem', margin: 0 }}>
                                {shortcuts.map((shortcut) => (
                                    <div key={shortcut.description} style={{ display: 'contents' }}>
                                        <dt style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem' }}>
                                            {shortcut.keys.map((key) => (
                                                <kbd
                                                    key={key}
                                                    style={{
                                                        minWidth: '1.75rem',
                                                        padding: '0.2rem 0.45rem',
                                                        border: '1px solid var(--border-color)',
                                                        borderBottomWidth: 2,
                                                        borderRadius: '0.375rem',
                                                        background: 'var(--bg-tertiary)',
                                                        color: 'var(--text-primary)',
                                                        fontSize: '0.75rem',
                                                        fontFamily: 'inherit',
                                                        textAlign: 'center',
                                                    }}
                                                >
                                                    {key}
                                                </kbd>
                                            ))}
                                        </dt>
                                        <dd style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: 1.5 }}>
                                            {shortcut.description}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
