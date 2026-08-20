import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useModalKeyboard } from '../useModalKeyboard';

type ShortcutContext = {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    isComposing: boolean;
    modalOpen: boolean;
};

export function shouldOpenKeyboardShortcutsHelp(context: ShortcutContext): boolean {
    return context.key === '/'
        && context.ctrlKey
        && !context.metaKey
        && !context.altKey
        && !context.isComposing
        && !context.modalOpen;
}

const shortcuts = [
    { keys: ['Enter'], description: 'メッセージを送信' },
    { keys: ['Shift', 'Enter'], description: 'メッセージを改行' },
    { keys: ['Enter / Space'], description: 'ゲームモードの文字送りをスキップ' },
    { keys: ['Esc'], description: '最前面のダイアログを閉じる' },
    { keys: ['Ctrl', '/'], description: 'ショートカット一覧を表示' },
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
            {open && (
                <div
                    className="modal-overlay"
                    onPointerDown={(event) => {
                        if (event.target === event.currentTarget) setOpen(false);
                    }}
                >
                    <div
                        ref={dialogRef}
                        className="modal-content keyboard-shortcuts-modal"
                        onClick={(event) => event.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="keyboard-shortcuts-title"
                    >
                        <div className="modal-header">
                            <h2 id="keyboard-shortcuts-title" style={{ fontSize: '1.125rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                                キーボードショートカット
                            </h2>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => setOpen(false)}
                                style={{ padding: '0.5rem' }}
                                title="閉じる"
                                aria-label="閉じる"
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
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
