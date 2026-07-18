import { memo, useEffect, useRef } from 'react';
import { Brain, Pencil, Copy, Check, RefreshCw, Send, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { formatAssistantMarkdown, splitAssistantMarkdownActions } from '@/lib/markdownUtils';
import StoredImage from './StoredImage';

interface MessageBubbleProps {
    messageId: string;
    role: 'user' | 'assistant';
    content: string;
    displayContent: string;
    index: number;
    isArchived: boolean;
    isLastMessage: boolean;
    isLoading: boolean;
    isHovered: boolean;
    isCopied: boolean;
    isTypewriterActive?: boolean;
    formatAssistantActions?: boolean;
    isAssistantContinuation?: boolean;
    showAssistantActions?: boolean;
    showMemoryIndicator: boolean;
    showArchiveDivider: boolean;
    memoryCharacterId?: string;
    characterIcon?: string;
    characterName?: string;
    isGroupRoom?: boolean;
    onMouseEnter: (id: string) => void;
    onMouseLeave: (e: React.MouseEvent) => void;
    onTouchStart: (id: string) => void;
    onEdit: (messageId: string, index: number, content: string) => void;
    isEditing?: boolean;
    editContent?: string;
    onEditChange: (content: string) => void;
    onCancelEdit: () => void;
    onSubmitEdit: () => void;
    onCopy: (id: string, content: string) => void;
    onRegenerate: () => void;
    onOpenMemoryList: (characterId?: string) => void;
    onRevealTypewriter?: () => void;
}

export default memo(function MessageBubble({
    messageId,
    role,
    content,
    displayContent,
    index,
    isArchived,
    isLastMessage,
    isLoading,
    isHovered,
    isCopied,
    isTypewriterActive,
    formatAssistantActions = true,
    isAssistantContinuation = false,
    showAssistantActions = true,
    showMemoryIndicator,
    showArchiveDivider,
    memoryCharacterId,
    characterIcon,
    characterName,
    isGroupRoom,
    onMouseEnter,
    onMouseLeave,
    onTouchStart,
    onEdit,
    isEditing = false,
    editContent = '',
    onEditChange,
    onCancelEdit,
    onSubmitEdit,
    onCopy,
    onRegenerate,
    onOpenMemoryList,
    onRevealTypewriter,
}: MessageBubbleProps) {
    const editTextareaRef = useRef<HTMLTextAreaElement>(null);
    const isUserMessage = role === 'user';
    const showRegenerateBtn = isLastMessage && role === 'assistant' && !isLoading;

    const assistantContent = displayContent || '...';
    const assistantSegments = splitAssistantMarkdownActions(assistantContent);
    const formatAssistantSegment = (segmentContent: string) => (
        formatAssistantActions ? formatAssistantMarkdown(segmentContent) : segmentContent
    );

    useEffect(() => {
        if (!isEditing) return;
        const textarea = editTextareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditing]);

    return (
        <div className={isAssistantContinuation ? 'message-continuation' : undefined} style={isArchived ? { opacity: 0.45 } : undefined}>
            {showArchiveDivider && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    margin: '0.75rem 0',
                    fontSize: '0.7rem',
                    color: 'var(--text-muted)',
                }}>
                    <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
                    圧縮済み
                    <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
                </div>
            )}
            {showMemoryIndicator && (
                <button
                    type="button"
                    className="memory-indicator"
                    onClick={() => onOpenMemoryList(memoryCharacterId)}
                    title="記憶を表示"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.375rem',
                        padding: '0.375rem 0.75rem',
                        marginBottom: '0.5rem',
                        background: 'rgba(var(--accent-primary-rgb), 0.15)',
                        border: '1px solid rgba(var(--accent-primary-rgb), 0.3)',
                        borderRadius: '1rem',
                        fontSize: '0.75rem',
                        color: 'var(--accent-primary)',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                    }}
                >
                    <Brain size={14} />
                    覚えました
                </button>
            )}
            {isUserMessage ? (
                <div
                    className="message-hover-zone user-message-wrapper"
                    onMouseEnter={() => onMouseEnter(messageId)}
                    onMouseLeave={onMouseLeave}
                    onTouchStart={(e) => {
                        e.stopPropagation();
                        if ((e.target as Element).closest('button, a, input, textarea, select, [role="button"]')) return;
                        onTouchStart(messageId);
                    }}
                >
                    {isEditing ? (
                        <form
                            className="inline-message-editor"
                            onSubmit={(e) => {
                                e.preventDefault();
                                onSubmitEdit();
                            }}
                        >
                            <textarea
                                ref={editTextareaRef}
                                className="input inline-message-edit-input"
                                value={editContent}
                                onChange={(e) => onEditChange(e.target.value)}
                                disabled={isLoading}
                                rows={Math.min(8, Math.max(2, editContent.split('\n').length))}
                            />
                            <div className="inline-message-edit-actions">
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={onCancelEdit}
                                    disabled={isLoading}
                                >
                                    <X size={14} />
                                    キャンセル
                                </button>
                                <button
                                    type="submit"
                                    className="btn btn-primary"
                                    disabled={isLoading || !editContent.trim()}
                                >
                                    <Send size={14} />
                                    送信
                                </button>
                            </div>
                        </form>
                    ) : (
                        <div className="message-bubble user animate-slide-up">
                            {content}
                        </div>
                    )}
                    <div
                        className="edit-btn-wrapper"
                        style={{
                            opacity: isHovered && !isEditing ? 1 : 0,
                            pointerEvents: isHovered && !isEditing ? 'auto' : 'none',
                            transition: 'opacity 0.15s ease',
                            display: 'flex',
                            justifyContent: 'flex-end',
                            gap: '0.375rem',
                            marginTop: '0.25rem',
                            marginRight: '0.25rem',
                        }}
                    >
                        <button
                            type="button"
                            className="btn btn-ghost edit-btn"
                            onClick={() => onCopy(messageId, content)}
                            style={{
                                fontSize: '0.75rem',
                                padding: '0.25rem 0.625rem',
                                height: 'auto',
                                gap: '0.25rem',
                                color: isCopied ? 'var(--accent-primary)' : 'var(--text-muted)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '0.75rem',
                                transition: 'color 0.15s ease',
                            }}
                            title="コピー"
                        >
                            {isCopied ? <Check size={12} /> : <Copy size={12} />}
                            {isCopied ? 'コピー済' : 'コピー'}
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost edit-btn"
                            onClick={() => onEdit(messageId, index, content)}
                            style={{
                                fontSize: '0.75rem',
                                padding: '0.25rem 0.625rem',
                                height: 'auto',
                                gap: '0.25rem',
                                color: 'var(--text-muted)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '0.75rem',
                                display: isArchived ? 'none' : undefined,
                            }}
                            title="メッセージを編集"
                            disabled={isLoading}
                        >
                            <Pencil size={12} />
                            編集
                        </button>
                    </div>
                </div>
            ) : (
                <div
                    className="message-hover-zone"
                    onMouseEnter={() => onMouseEnter(messageId)}
                    onMouseLeave={onMouseLeave}
                    onTouchStart={(e) => {
                        e.stopPropagation();
                        if ((e.target as Element).closest('button, a, input, textarea, select, [role="button"]')) return;
                        onTouchStart(messageId);
                    }}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}
                >
                    <div
                        aria-hidden={isAssistantContinuation}
                        style={{
                            flexShrink: 0,
                            width: '2rem',
                            height: '2rem',
                            borderRadius: '50%',
                            overflow: 'hidden',
                            marginTop: '0.25rem',
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border-color)',
                            visibility: isAssistantContinuation ? 'hidden' : undefined,
                        }}
                    >
                        {!isAssistantContinuation && (
                            characterIcon ? (
                                <StoredImage src={characterIcon} alt={characterName ?? 'character'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                                    {characterName ? characterName.charAt(0) : '?'}
                                </div>
                            )
                        )}
                    </div>
                    <div className="assistant-message-content">
                    {isGroupRoom && characterName && !isAssistantContinuation && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.125rem', marginLeft: '0.25rem', fontWeight: 500 }}>
                            {characterName}
                        </div>
                    )}
                    {assistantSegments.map((segment, segmentIndex) => (
                        segment.type === 'action' ? (
                            <div
                                key={`${messageId}-segment-${segmentIndex}`}
                                className="assistant-action-description animate-slide-up"
                                onClick={isTypewriterActive ? onRevealTypewriter : undefined}
                                title={isTypewriterActive ? '全文表示' : undefined}
                                style={{ cursor: isTypewriterActive ? 'pointer' : undefined }}
                            >
                                <ReactMarkdown>{segment.content}</ReactMarkdown>
                            </div>
                        ) : (
                            <div
                                key={`${messageId}-segment-${segmentIndex}`}
                                className={`message-bubble assistant animate-slide-up assistant-segment-bubble ${segmentIndex > 0 ? 'assistant-segment-continuation' : ''}`}
                                onClick={isTypewriterActive ? onRevealTypewriter : undefined}
                                title={isTypewriterActive ? '全文表示' : undefined}
                                style={{ cursor: isTypewriterActive ? 'pointer' : undefined }}
                            >
                                <ReactMarkdown>{formatAssistantSegment(segment.content)}</ReactMarkdown>
                            </div>
                        )
                    ))}
                    {showAssistantActions && (
                        <div className="assistant-btn-row" style={{
                            display: 'flex',
                            justifyContent: 'flex-start',
                            gap: '0.375rem',
                            marginTop: '0.25rem',
                            marginLeft: '0.25rem',
                            opacity: isHovered ? 1 : 0,
                            pointerEvents: isHovered ? 'auto' : 'none',
                            transition: 'opacity 0.15s ease',
                        }}>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => onCopy(messageId, displayContent)}
                                style={{
                                    fontSize: '0.75rem',
                                    padding: '0.25rem 0.625rem',
                                    height: 'auto',
                                    color: isCopied ? 'var(--accent-primary)' : 'var(--text-muted)',
                                    gap: '0.25rem',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: '0.75rem',
                                    transition: 'color 0.15s ease',
                                }}
                                title="コピー"
                            >
                                {isCopied ? <Check size={12} /> : <Copy size={12} />}
                                {isCopied ? 'コピー済' : 'コピー'}
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={onRegenerate}
                                style={{
                                    fontSize: '0.75rem',
                                    padding: '0.25rem 0.625rem',
                                    height: 'auto',
                                    color: 'var(--text-muted)',
                                    gap: '0.25rem',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: '0.75rem',
                                    display: showRegenerateBtn ? undefined : 'none',
                                }}
                                title="回答を再生成"
                            >
                                <RefreshCw size={14} />
                                再生成
                            </button>
                        </div>
                    )}
                    </div>
                </div>
            )}
        </div>
    );
});
