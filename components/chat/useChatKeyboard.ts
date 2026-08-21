import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, RefObject, SetStateAction } from 'react';
import { DEFAULT_KEYBOARD_SHORTCUTS, useStore, type KeyboardShortcut } from '../../lib/store';
import { matchesAnyKeyboardShortcut } from '../../lib/keyboardShortcuts';

type ChatInputKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>;
type ShortcutKeyEvent = Pick<KeyboardEvent, 'key'>
    & Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>>;

export function shouldIgnoreDocumentChatShortcut({
    defaultPrevented,
    modalOpen,
}: {
    defaultPrevented: boolean;
    modalOpen: boolean;
}): boolean {
    return defaultPrevented || modalOpen;
}

export function shouldRedirectChatInput(event: ChatInputKeyEvent): boolean {
    if (event.key === '?') return false;
    if (event.key.length !== 1 && event.key !== 'Backspace') return false;
    return !event.metaKey && !event.ctrlKey && !event.altKey;
}

export function shouldAdvanceTypewriter(
    event: ShortcutKeyEvent,
    shortcuts: readonly KeyboardShortcut[] = DEFAULT_KEYBOARD_SHORTCUTS.advanceTypewriter,
): boolean {
    return matchesAnyKeyboardShortcut(event, shortcuts);
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

type UseChatInputRedirectOptions = {
    inputRef: RefObject<HTMLTextAreaElement | null>;
    disabled: boolean;
    isMobile: boolean;
};

export function useChatInputRedirect({ inputRef, disabled, isMobile }: UseChatInputRedirectOptions) {
    useEffect(() => {
        if (isMobile) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (shouldIgnoreDocumentChatShortcut({
                defaultPrevented: event.defaultPrevented,
                modalOpen: document.querySelector('[aria-modal="true"]') != null,
            })) return;
            if (isEditableTarget(event.target) || !shouldRedirectChatInput(event)) return;
            if (!inputRef.current || disabled) return;
            inputRef.current.focus();
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [disabled, inputRef, isMobile]);
}

type UseTypewriterAdvanceOptions = {
    activeRef: RefObject<unknown>;
    onAdvance: () => void;
};

export function useTypewriterAdvance({ activeRef, onAdvance }: UseTypewriterAdvanceOptions) {
    const onAdvanceRef = useRef(onAdvance);
    const advanceTypewriterShortcuts = useStore((state) => state.keyboardShortcuts.advanceTypewriter);

    useEffect(() => {
        onAdvanceRef.current = onAdvance;
    }, [onAdvance]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!activeRef.current) return;
            if (shouldIgnoreDocumentChatShortcut({
                defaultPrevented: event.defaultPrevented,
                modalOpen: document.querySelector('[aria-modal="true"]') != null,
            })) return;

            const target = event.target as HTMLElement | null;
            const isDisabledFormTarget = target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || target instanceof HTMLSelectElement
                ? target.disabled
                : false;
            if (isEditableTarget(target) && !isDisabledFormTarget) return;
            if (!shouldAdvanceTypewriter(event, advanceTypewriterShortcuts)) return;

            event.preventDefault();
            onAdvanceRef.current();
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [activeRef, advanceTypewriterShortcuts]);
}

type UseChatComposerKeyboardOptions<T> = {
    mentionOpen: boolean;
    mentionCandidates: T[];
    selectedMentionIndex: number;
    setSelectedMentionIndex: Dispatch<SetStateAction<number>>;
    onApplyMention: (candidate: T) => void;
    onCloseMention: () => void;
    isMobile: boolean;
    isInlineEditing: boolean;
    onSubmit: () => void;
    onSubmitEdit: () => void;
};

export function useChatComposerKeyboard<T>({
    mentionOpen,
    mentionCandidates,
    selectedMentionIndex,
    setSelectedMentionIndex,
    onApplyMention,
    onCloseMention,
    isMobile,
    isInlineEditing,
    onSubmit,
    onSubmitEdit,
}: UseChatComposerKeyboardOptions<T>) {
    const sendMessageShortcuts = useStore((state) => state.keyboardShortcuts.sendMessage);
    return useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (mentionOpen && mentionCandidates.length > 0) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelectedMentionIndex((index) => (index + 1) % mentionCandidates.length);
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelectedMentionIndex((index) => (index - 1 + mentionCandidates.length) % mentionCandidates.length);
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onApplyMention(mentionCandidates[selectedMentionIndex]);
                return;
            }
            if (event.key === 'Escape') {
                onCloseMention();
                return;
            }
        }

        if (isMobile || !matchesAnyKeyboardShortcut(event, sendMessageShortcuts)) return;
        event.preventDefault();
        if (isInlineEditing) {
            onSubmitEdit();
        } else {
            onSubmit();
        }
    }, [
        isInlineEditing,
        isMobile,
        mentionCandidates,
        mentionOpen,
        onApplyMention,
        onCloseMention,
        onSubmit,
        onSubmitEdit,
        selectedMentionIndex,
        sendMessageShortcuts,
        setSelectedMentionIndex,
    ]);
}
