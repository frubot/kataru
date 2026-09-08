import { useCallback, useEffect, useRef, useState } from 'react';
import type { VnTypingSpeed } from '@/lib/store';
import { VisualNovelTypewriter, type VisualNovelTypingSnapshot } from '@/lib/visualNovelTypewriter';
import { useTypewriterAdvance } from './useChatKeyboard';

type UseVisualNovelPresentationOptions = {
    typingSpeed: VnTypingSpeed;
};

export function useVisualNovelPresentation({ typingSpeed }: UseVisualNovelPresentationOptions) {
    const [bounceActive, setBounceActive] = useState(false);
    const [typing, setTyping] = useState<VisualNovelTypingSnapshot>({ messageId: null, content: '', active: false });
    const bounceStartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const bounceStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const typewriterActiveRef = useRef(false);
    const typingSpeedRef = useRef(typingSpeed);
    const [typewriter] = useState(() => new VisualNovelTypewriter(setTyping, typingSpeed));

    useEffect(() => {
        typingSpeedRef.current = typingSpeed;
        typewriter.setSpeed(typingSpeed);
    }, [typingSpeed, typewriter]);

    useEffect(() => {
        typewriterActiveRef.current = typing.active;
    }, [typing.active]);

    const clearBounceTimers = useCallback(() => {
        if (bounceStartRef.current) {
            clearTimeout(bounceStartRef.current);
            bounceStartRef.current = null;
        }
        if (bounceStopRef.current) {
            clearTimeout(bounceStopRef.current);
            bounceStopRef.current = null;
        }
    }, []);

    const stopBounce = useCallback(() => {
        clearBounceTimers();
        setBounceActive(false);
    }, [clearBounceTimers]);

    const triggerBounce = useCallback(() => {
        stopBounce();
        bounceStartRef.current = setTimeout(() => {
            setBounceActive(true);
            bounceStopRef.current = setTimeout(() => {
                setBounceActive(false);
                bounceStopRef.current = null;
            }, 620);
            bounceStartRef.current = null;
        }, 20);
    }, [stopBounce]);

    const stopTypewriter = useCallback((revealFull: boolean) => typewriter.stop(revealFull), [typewriter]);
    const playTypewriter = useCallback((messageId: string, content: string, incremental = false) => (
        typewriter.play(messageId, content, incremental)
    ), [typewriter]);

    useTypewriterAdvance({
        activeRef: typewriterActiveRef,
        onAdvance: () => stopTypewriter(true),
    });

    useEffect(() => () => {
        clearBounceTimers();
        typewriter.dispose();
    }, [clearBounceTimers, typewriter]);

    return {
        bounceActive,
        typingMessageId: typing.messageId,
        typedContent: typing.content,
        isTypewriterActive: typing.active,
        typingSpeedRef,
        triggerBounce,
        stopBounce,
        stopTypewriter,
        playTypewriter,
    };
}
