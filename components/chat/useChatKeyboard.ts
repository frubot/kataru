import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, RefObject, SetStateAction } from 'react';

type KeyboardShortcut = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>;

export function shouldIgnoreDocumentChatShortcut({
    defaultPrevented,
    modalOpen,
}: {
    defaultPrevented: boolean;
    modalOpen: boolean;
}): boolean {
    return defaultPrevented || modalOpen;
}

export function shouldRedirectChatInput(event: KeyboardShortcut): boolean {
    if (event.key === '?') return false;
    if (event.key.length !== 1 && event.key !== 'Backspace') return false;
    return !event.metaKey && !event.ctrlKey && !event.altKey;
}

export function shouldAdvanceTypewriter(event: Pick<KeyboardEvent, 'key'>): boolean {
    return event.key === 'Enter' || event.key === ' ';
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
            if (!shouldAdvanceTypewriter(event)) return;

            event.preventDefault();
            onAdvanceRef.current();
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [activeRef]);
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

        if (isMobile || event.key !== 'Enter' || event.shiftKey) return;
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
        setSelectedMentionIndex,
    ]);
}
