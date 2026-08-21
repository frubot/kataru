import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
    DEFAULT_KEYBOARD_SHORTCUTS,
    useStore,
    type KeyboardShortcut,
} from '../../lib/store';
import { matchesAnyKeyboardShortcut } from '../../lib/keyboardShortcuts';
import KeyboardSettingsPanel from '../KeyboardSettingsPanel';
import { useModalKeyboard } from '../useModalKeyboard';

type ShortcutContext = {
    key: string;
    ctrlKey: boolean;
    shiftKey?: boolean;
    metaKey: boolean;
    altKey: boolean;
    isComposing: boolean;
    modalOpen: boolean;
};

export function shouldOpenKeyboardShortcutsHelp(
    context: ShortcutContext,
    shortcuts: readonly KeyboardShortcut[] = DEFAULT_KEYBOARD_SHORTCUTS.openShortcutHelp,
): boolean {
    return !context.isComposing
        && !context.modalOpen
        && matchesAnyKeyboardShortcut(context, shortcuts);
}

export default function KeyboardShortcutsHelp() {
    const [open, setOpen] = useState(false);
    const openShortcutHelp = useStore((state) => state.keyboardShortcuts.openShortcutHelp);
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
                shiftKey: event.shiftKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
                isComposing: event.isComposing,
                modalOpen: document.querySelector('[aria-modal="true"]') != null,
            }, openShortcutHelp)) return;
            event.preventDefault();
            setOpen(true);
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, openShortcutHelp]);

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
                        <div className="modal-body">
                            <KeyboardSettingsPanel />
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
