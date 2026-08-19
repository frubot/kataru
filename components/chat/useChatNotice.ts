import { useCallback, useEffect, useRef, useState } from 'react';

import { shouldAutoHideChatNotice } from '@/lib/chatErrorPolicy';

const CHAT_NOTICE_AUTO_HIDE_MS = 5000;

export type ChatNoticeAction =
    | { type: 'retry'; label: '再試行' }
    | { type: 'open-settings'; label: '設定を確認' };

export type ChatNotice = {
    id: number;
    message: string;
    tone: 'error';
    action?: ChatNoticeAction;
};

type UseChatNoticeOptions = {
    onClearAction: () => void;
};

export function useChatNotice({ onClearAction }: UseChatNoticeOptions) {
    const [notice, setNotice] = useState<ChatNotice | null>(null);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoveredRef = useRef(false);
    const onClearActionRef = useRef(onClearAction);

    useEffect(() => {
        onClearActionRef.current = onClearAction;
    }, [onClearAction]);

    const clearTimer = useCallback(() => {
        if (!timeoutRef.current) return;
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
    }, []);

    const scheduleAutoHide = useCallback(() => {
        if (hoveredRef.current) return;
        clearTimer();
        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            onClearActionRef.current();
            setNotice(null);
        }, CHAT_NOTICE_AUTO_HIDE_MS);
    }, [clearTimer]);

    const dismissNotice = useCallback(() => {
        clearTimer();
        hoveredRef.current = false;
        onClearActionRef.current();
        setNotice(null);
    }, [clearTimer]);

    const showNotice = useCallback((message: string, action?: ChatNoticeAction) => {
        clearTimer();
        if (action?.type !== 'retry') {
            onClearActionRef.current();
        }
        setNotice({
            id: Date.now(),
            message,
            tone: 'error',
            action,
        });
        if (shouldAutoHideChatNotice(action?.type)) {
            scheduleAutoHide();
        }
    }, [clearTimer, scheduleAutoHide]);

    const handleMouseEnter = useCallback(() => {
        hoveredRef.current = true;
        clearTimer();
    }, [clearTimer]);

    const handleMouseLeave = useCallback(() => {
        hoveredRef.current = false;
        if (shouldAutoHideChatNotice(notice?.action?.type)) {
            scheduleAutoHide();
        }
    }, [notice?.action?.type, scheduleAutoHide]);

    useEffect(() => () => clearTimer(), [clearTimer]);

    return {
        notice,
        showNotice,
        dismissNotice,
        handleMouseEnter,
        handleMouseLeave,
    };
}
