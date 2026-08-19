import { useEffect } from 'react';
import type {
    ChangeEvent,
    Dispatch,
    FormEvent,
    ReactNode,
    RefObject,
    SetStateAction,
} from 'react';
import { ArrowUp, ChevronsDown, Square, X } from 'lucide-react';
import StoredImage from '../StoredImage';
import ChatNoticeBanner from './ChatNoticeBanner';
import type { ChatNotice } from './useChatNotice';
import { useChatComposerKeyboard, useChatInputRedirect } from './useChatKeyboard';

type MentionCandidate = {
    id: string;
    name: string;
    icon?: string;
};

type ChatComposerProps<TMention extends MentionCandidate> = {
    inputRef: RefObject<HTMLTextAreaElement | null>;
    focusKey: string;
    value: string;
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    placeholder: string;
    disabled: boolean;
    redirectDisabled: boolean;
    submitDisabled: boolean;
    isMobile: boolean;
    isInlineEditing: boolean;
    isBusy: boolean;
    isTypewriterActive: boolean;
    onSubmit: () => void;
    onSubmitEdit: () => void;
    onCancelEdit: () => void;
    onStop: () => void;
    notice: ChatNotice | null;
    noticeActionDisabled: boolean;
    onNoticeAction: () => void;
    onDismissNotice: () => void;
    onNoticeInteractionStart: () => void;
    onNoticeInteractionEnd: () => void;
    replySuggestions: ReactNode;
    visualNovelMode: boolean;
    mentionOpen: boolean;
    mentionCandidates: TMention[];
    selectedMentionIndex: number;
    setSelectedMentionIndex: Dispatch<SetStateAction<number>>;
    onApplyMention: (candidate: TMention) => void;
    onCloseMention: () => void;
};

export default function ChatComposer<TMention extends MentionCandidate>({
    inputRef,
    focusKey,
    value,
    onChange,
    placeholder,
    disabled,
    redirectDisabled,
    submitDisabled,
    isMobile,
    isInlineEditing,
    isBusy,
    isTypewriterActive,
    onSubmit,
    onSubmitEdit,
    onCancelEdit,
    onStop,
    notice,
    noticeActionDisabled,
    onNoticeAction,
    onDismissNotice,
    onNoticeInteractionStart,
    onNoticeInteractionEnd,
    replySuggestions,
    visualNovelMode,
    mentionOpen,
    mentionCandidates,
    selectedMentionIndex,
    setSelectedMentionIndex,
    onApplyMention,
    onCloseMention,
}: ChatComposerProps<TMention>) {
    useChatInputRedirect({
        inputRef,
        disabled: redirectDisabled,
        isMobile,
    });
    const handleKeyDown = useChatComposerKeyboard({
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
    });

    useEffect(() => {
        const textarea = inputRef.current;
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
    }, [inputRef, value]);

    useEffect(() => {
        if (focusKey && window.innerWidth > 768) {
            inputRef.current?.focus();
        }
    }, [focusKey, inputRef]);

    const handleSubmit = (event: FormEvent) => {
        event.preventDefault();
        if (isInlineEditing) {
            onSubmitEdit();
        } else {
            onSubmit();
        }
    };

    return (
        <div className="chat-input-area" style={{ position: 'relative' }}>
            {notice && (
                <ChatNoticeBanner
                    key={notice.id}
                    notice={notice}
                    retryDisabled={noticeActionDisabled}
                    onAction={onNoticeAction}
                    onDismiss={onDismissNotice}
                    onInteractionStart={onNoticeInteractionStart}
                    onInteractionEnd={onNoticeInteractionEnd}
                />
            )}
            {!visualNovelMode && replySuggestions}
            {mentionOpen && mentionCandidates.length > 0 && (
                <div className="chat-mention-menu" style={{
                    position: 'absolute',
                    bottom: '100%',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '0.5rem',
                    overflow: 'hidden',
                    boxShadow: '0 -4px 12px rgba(0,0,0,0.15)',
                    zIndex: 50,
                }}>
                    {mentionCandidates.map((candidate, index) => (
                        <button
                            key={candidate.id}
                            type="button"
                            onMouseDown={(event) => {
                                event.preventDefault();
                                onApplyMention(candidate);
                            }}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                width: '100%',
                                padding: '0.5rem 0.75rem',
                                background: index === selectedMentionIndex ? 'var(--bg-hover)' : 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                                textAlign: 'left',
                                color: 'var(--text-primary)',
                                fontSize: '0.875rem',
                            }}
                            onMouseEnter={() => setSelectedMentionIndex(index)}
                        >
                            <div style={{ flexShrink: 0, width: '1.5rem', height: '1.5rem', borderRadius: '50%', overflow: 'hidden', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                                {candidate.icon ? (
                                    <StoredImage
                                        src={candidate.icon}
                                        alt={candidate.name}
                                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                    />
                                ) : candidate.name.charAt(0)}
                            </div>
                            <span>{candidate.name}</span>
                        </button>
                    ))}
                </div>
            )}
            <form onSubmit={handleSubmit} className={`chat-input-wrapper ${isInlineEditing ? 'editing' : ''}`}>
                <textarea
                    ref={inputRef}
                    className="input chat-input"
                    value={value}
                    onChange={onChange}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    disabled={disabled}
                    rows={1}
                />
                {isBusy ? (
                    <button
                        type="button"
                        className="btn btn-primary chat-input-send"
                        onClick={onStop}
                        style={isTypewriterActive ? undefined : { backgroundColor: '#ef4444' }}
                        title={isTypewriterActive ? '全文表示' : '生成を中断'}
                    >
                        {isTypewriterActive
                            ? <ChevronsDown size={16} />
                            : <Square size={16} fill="currentColor" />}
                    </button>
                ) : (
                    <>
                        {isInlineEditing && (
                            <button
                                type="button"
                                className="btn btn-ghost chat-input-cancel"
                                onClick={onCancelEdit}
                                title="編集をキャンセル"
                                aria-label="編集をキャンセル"
                            >
                                <X size={15} />
                            </button>
                        )}
                        <button
                            type="submit"
                            className="btn btn-primary chat-input-send"
                            disabled={submitDisabled}
                            title={isInlineEditing ? '編集して送信' : '送信'}
                        >
                            <ArrowUp size={16} />
                        </button>
                    </>
                )}
            </form>
        </div>
    );
}
