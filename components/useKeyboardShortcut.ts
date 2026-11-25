import { useEffect, useRef } from 'react';
import { useStore } from '../lib/store';
import {
    hasCommandModifier,
    matchesAnyKeyboardShortcut,
    type KeyboardShortcutAction,
} from '../lib/keyboardShortcuts';

export function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

type ShortcutGuardContext = {
    defaultPrevented: boolean;
    isComposing: boolean;
    modalOpen: boolean;
    menuOpen: boolean;
};

/** ほかの処理が先に受け取ったキーや、ダイアログ・メニューを開いている間のキーは扱いません。 */
export function shouldIgnoreGlobalShortcut(context: ShortcutGuardContext): boolean {
    return context.defaultPrevented || context.isComposing || context.modalOpen || context.menuOpen;
}

type TargetContext = {
    key: string;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    editableTarget: boolean;
};

/** 修飾キーなしのショートカットは、入力欄で文字を打つ操作とぶつかるため入力欄の外でだけ受け付けます。 */
export function acceptsShortcutTargetByDefault(context: TargetContext): boolean {
    return hasCommandModifier(context) || !context.editableTarget;
}

type UseKeyboardShortcutOptions = {
    action: KeyboardShortcutAction;
    enabled?: boolean;
    allowRepeat?: boolean;
    /** 既定の判定（修飾キーなしなら入力欄の外だけ）の代わりに、受け付ける場所を判定します。 */
    acceptTarget?: (event: KeyboardEvent) => boolean;
    onTrigger: () => void;
};

export function useKeyboardShortcut({
    action,
    enabled = true,
    allowRepeat = false,
    acceptTarget,
    onTrigger,
}: UseKeyboardShortcutOptions) {
    const shortcuts = useStore((state) => state.keyboardShortcuts[action]);
    const onTriggerRef = useRef(onTrigger);
    const acceptTargetRef = useRef(acceptTarget);

    useEffect(() => {
        onTriggerRef.current = onTrigger;
        acceptTargetRef.current = acceptTarget;
    });

    useEffect(() => {
        if (!enabled) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.repeat && !allowRepeat) return;
            if (shouldIgnoreGlobalShortcut({
                defaultPrevented: event.defaultPrevented,
                isComposing: event.isComposing,
                modalOpen: document.querySelector('[aria-modal="true"]') != null,
                menuOpen: document.querySelector('[role="menu"]') != null,
            })) return;
            if (!matchesAnyKeyboardShortcut(event, shortcuts)) return;
            const accepted = acceptTargetRef.current
                ? acceptTargetRef.current(event)
                : acceptsShortcutTargetByDefault({
                    key: event.key,
                    ctrlKey: event.ctrlKey,
                    altKey: event.altKey,
                    metaKey: event.metaKey,
                    editableTarget: isEditableTarget(event.target),
                });
            if (!accepted) return;

            event.preventDefault();
            onTriggerRef.current();
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [allowRepeat, enabled, shortcuts]);
}
