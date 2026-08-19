import { AlertTriangle, RefreshCw, Settings2, X } from 'lucide-react';

import type { ChatNotice } from './useChatNotice';

type ChatNoticeBannerProps = {
    notice: ChatNotice;
    retryDisabled: boolean;
    onAction: () => void;
    onDismiss: () => void;
    onInteractionStart: () => void;
    onInteractionEnd: () => void;
};

export default function ChatNoticeBanner({
    notice,
    retryDisabled,
    onAction,
    onDismiss,
    onInteractionStart,
    onInteractionEnd,
}: ChatNoticeBannerProps) {
    return (
        <div
            className={`chat-notice ${notice.tone}`}
            role="alert"
            aria-live="polite"
            aria-atomic="true"
            onMouseEnter={onInteractionStart}
            onMouseLeave={onInteractionEnd}
            onFocus={onInteractionStart}
            onBlur={onInteractionEnd}
        >
            <AlertTriangle size={16} className="chat-notice-icon" />
            <div className="chat-notice-body">
                <span className="chat-notice-message">{notice.message}</span>
                {notice.action && (
                    <button
                        type="button"
                        className="chat-notice-action"
                        onClick={onAction}
                        disabled={notice.action.type === 'retry' && retryDisabled}
                        title={notice.action.label}
                    >
                        {notice.action.type === 'retry'
                            ? <RefreshCw size={14} aria-hidden="true" />
                            : <Settings2 size={14} aria-hidden="true" />}
                        {notice.action.label}
                    </button>
                )}
            </div>
            <button
                type="button"
                className="chat-notice-close"
                onClick={onDismiss}
                title="閉じる"
                aria-label="通知を閉じる"
            >
                <X size={14} />
            </button>
        </div>
    );
}
