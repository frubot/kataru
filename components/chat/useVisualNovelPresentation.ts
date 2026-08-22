import { useCallback, useEffect, useRef, useState } from 'react';
import type { VnTypingSpeed } from '@/lib/store';
import {
    buildVisualNovelTypingSegments,
    getVisualNovelTypingDelay,
} from '@/lib/visualNovelPresentation';
import { useTypewriterAdvance } from './useChatKeyboard';

type UseVisualNovelPresentationOptions = {
    typingSpeed: VnTypingSpeed;
};

export function useVisualNovelPresentation({ typingSpeed }: UseVisualNovelPresentationOptions) {
    const [bounceActive, setBounceActive] = useState(false);
    const [typingMessageId, setTypingMessageId] = useState<string | null>(null);
    const [typedContent, setTypedContent] = useState('');
    const [isTypewriterActive, setIsTypewriterActive] = useState(false);
    const bounceStartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const bounceStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const typewriterRef = useRef<{ messageId: string; fullContent: string } | null>(null);
    const typeDelayRef = useRef<{ timeout: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);
    const typingSpeedRef = useRef(typingSpeed);

    useEffect(() => {
        typingSpeedRef.current = typingSpeed;
    }, [typingSpeed]);

    const triggerBounce = useCallback(() => {
        if (bounceStartRef.current) {
            clearTimeout(bounceStartRef.current);
            bounceStartRef.current = null;
        }
        if (bounceStopRef.current) {
            clearTimeout(bounceStopRef.current);
            bounceStopRef.current = null;
        }
        setBounceActive(false);
        bounceStartRef.current = setTimeout(() => {
            setBounceActive(true);
            bounceStopRef.current = setTimeout(() => {
                setBounceActive(false);
                bounceStopRef.current = null;
            }, 620);
            bounceStartRef.current = null;
        }, 20);
    }, []);

    const releaseTypeDelay = useCallback(() => {
        const pendingDelay = typeDelayRef.current;
        if (!pendingDelay) return;
        clearTimeout(pendingDelay.timeout);
        typeDelayRef.current = null;
        pendingDelay.resolve();
    }, []);

    const stopTypewriter = useCallback((revealFull: boolean) => {
        const activeRun = typewriterRef.current;
        if (!activeRun) {
            if (!revealFull) {
                setTypedContent('');
                setTypingMessageId(null);
                setIsTypewriterActive(false);
            }
            return false;
        }

        typewriterRef.current = null;
        releaseTypeDelay();
        setTypedContent(revealFull ? activeRun.fullContent : '');
        setTypingMessageId(revealFull ? activeRun.messageId : null);
        setIsTypewriterActive(false);
        return true;
    }, [releaseTypeDelay]);

    const playTypewriter = useCallback(async (messageId: string, fullContent: string) => {
        stopTypewriter(false);

        const segments = buildVisualNovelTypingSegments(fullContent);
        if (segments.length === 0) {
            setTypingMessageId(null);
            setTypedContent('');
            setIsTypewriterActive(false);
            return;
        }

        const run = { messageId, fullContent };
        typewriterRef.current = run;
        setTypingMessageId(messageId);
        if (typingSpeedRef.current === 'streaming') {
            typewriterRef.current = null;
            setTypedContent(fullContent);
            setIsTypewriterActive(false);
            return;
        }
        setTypedContent('');
        setIsTypewriterActive(true);

        let nextContent = '';
        for (const segment of segments) {
            if (typewriterRef.current !== run) return;

            nextContent += segment;
            setTypedContent(nextContent);

            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (typeDelayRef.current?.timeout === timeout) {
                        typeDelayRef.current = null;
                    }
                    resolve();
                }, getVisualNovelTypingDelay(segment, typingSpeedRef.current));
                typeDelayRef.current = { timeout, resolve };
            });
        }

        if (typewriterRef.current !== run) return;
        typewriterRef.current = null;
        setTypedContent(fullContent);
        setTypingMessageId(messageId);
        setIsTypewriterActive(false);
    }, [stopTypewriter]);

    useTypewriterAdvance({
        activeRef: typewriterRef,
        onAdvance: () => stopTypewriter(true),
    });

    useEffect(() => () => {
        if (bounceStartRef.current) clearTimeout(bounceStartRef.current);
        if (bounceStopRef.current) clearTimeout(bounceStopRef.current);
        typewriterRef.current = null;
        releaseTypeDelay();
    }, [releaseTypeDelay]);

    return {
        bounceActive,
        typingMessageId,
        typedContent,
        isTypewriterActive,
        typingSpeedRef,
        triggerBounce,
        stopTypewriter,
        playTypewriter,
    };
}
