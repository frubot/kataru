import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent, RefObject } from 'react';

type MentionCandidate = {
    name: string;
};

type UseChatMentionsOptions<T extends MentionCandidate> = {
    enabled: boolean;
    candidates?: T[] | null;
    input: string;
    setInput: (value: string) => void;
    inputRef: RefObject<HTMLTextAreaElement | null>;
};

export function useChatMentions<T extends MentionCandidate>({
    enabled,
    candidates,
    input,
    setInput,
    inputRef,
}: UseChatMentionsOptions<T>) {
    const [query, setQuery] = useState<string | null>(null);
    const [startIndex, setStartIndex] = useState(0);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const filteredCandidates = useMemo(() => {
        if (!enabled || !candidates || query === null) return [];
        const normalizedQuery = query.toLowerCase();
        if (!normalizedQuery) return candidates;
        return candidates.filter((candidate) =>
            candidate.name.toLowerCase().startsWith(normalizedQuery)
        );
    }, [candidates, enabled, query]);

    const close = useCallback(() => setQuery(null), []);

    const apply = useCallback((candidate: T) => {
        const before = input.slice(0, startIndex);
        const after = input.slice(startIndex + 1 + (query?.length ?? 0));
        setInput(`${before}@${candidate.name} ${after}`);
        setQuery(null);
        setTimeout(() => {
            const element = inputRef.current;
            if (!element) return;
            element.focus();
            const cursorPosition = before.length + candidate.name.length + 2;
            element.setSelectionRange(cursorPosition, cursorPosition);
        }, 0);
    }, [input, inputRef, query?.length, setInput, startIndex]);

    const handleInputChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
        const value = event.target.value;
        setInput(value);
        if (!enabled) return;
        const cursorPosition = event.target.selectionStart ?? value.length;
        const textBeforeCursor = value.slice(0, cursorPosition);
        const match = textBeforeCursor.match(/@([\w\u3000-\u9FFF\u30A0-\u30FF\u3040-\u309F\uFF65-\uFF9F]*)$/);
        if (match) {
            setQuery(match[1]);
            setStartIndex(match.index ?? 0);
            setSelectedIndex(0);
        } else {
            setQuery(null);
        }
    }, [enabled, setInput]);

    return {
        query,
        candidates: filteredCandidates,
        selectedIndex,
        setSelectedIndex,
        apply,
        close,
        handleInputChange,
    };
}
