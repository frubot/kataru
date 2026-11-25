import { useEffect, useMemo, useRef } from 'react';
import { ArrowUp, Check, History, Pencil, UserRound, X } from 'lucide-react';
import type { Character } from '@/lib/store';
import { formatMessageTextWithAttachments } from '@/lib/chatAttachments';
import type {
    ChatMessagePresentation,
    ChatStreamingPreview,
    PriorMessagePresentation,
} from '@/lib/chatMessagePresentation';
import { formatAssistantMarkdown, hideAssistantDialogueBrackets } from '@/lib/markdownUtils';
import { isNarrationMessage, isNarratorCharacterId } from '@/lib/narration';
import SafeMarkdown from '../SafeMarkdown';
import StoredImage from '../StoredImage';
import InlineMessageEditor from './InlineMessageEditor';
import WaitingEllipsis from './WaitingEllipsis';

type VisualNovelLogViewProps = {
    character: Character | null;
    priorMessages: PriorMessagePresentation[];
    messages: ChatMessagePresentation[];
    activeStreamingPreview: ChatStreamingPreview | null;
    streamingPreviewCharacter: Character | null | undefined;
    formattedStreamingPreviewMessages: string[];
    /** 直前バブルへ連結されたプレビューセグメントのキー。ログ側では重複なので除外する。 */
    continuationAppendPreviewKey?: string;
    isLoading: boolean;
    isSummarizing: boolean;
    canEdit: boolean;
    editingMessage: {
        messageId: string;
        content: string;
        hasAttachments: boolean;
    } | null;
    onEdit: (messageId: string) => void;
    onEditChange: (content: string) => void;
    onCancelEdit: () => void;
    onSubmitEdit: () => void;
    onClose: () => void;
};

type VisualNovelLogEntry = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    speakerName: string;
    characterIcon?: string;
    isStreaming?: boolean;
    /** シチュエーションの場面ナレーション。話者名とアイコンを出さない。 */
    isNarration?: boolean;
    /** 書き換えられる会話中のメッセージ。導入の会話や生成中の発言は対象外。 */
    editable?: boolean;
    isArchived?: boolean;
};

function LogAvatar({ entry }: { entry: VisualNovelLogEntry }) {
    if (entry.isNarration) {
        return <div aria-hidden="true" />;
    }
    if (entry.role === 'user') {
        return (
            <div className="vn-log-avatar user" aria-hidden="true">
                <UserRound size={20} strokeWidth={1.8} />
            </div>
        );
    }

    return (
        <div className="vn-log-avatar" aria-hidden="true">
            {entry.characterIcon ? (
                <StoredImage src={entry.characterIcon} alt="" />
            ) : (
                <span>{entry.speakerName.charAt(0) || '?'}</span>
            )}
        </div>
    );
}

type LogEntryEditProps = {
    canEdit: boolean;
    editContent: string | null;
    editHasAttachments: boolean;
    onEdit: (messageId: string) => void;
    onEditChange: (content: string) => void;
    onCancelEdit: () => void;
    onSubmitEdit: () => void;
};

function LogEntry({
    entry,
    canEdit,
    editContent,
    editHasAttachments,
    onEdit,
    onEditChange,
    onCancelEdit,
    onSubmitEdit,
}: { entry: VisualNovelLogEntry } & LogEntryEditProps) {
    const isEditing = editContent != null;
    const showEditButton = entry.editable && canEdit && !isEditing;
    const editTitle = entry.role === 'user' && entry.isArchived ? 'ここまで巻き戻して編集' : 'メッセージを編集';
    return (
        <article
            className={`vn-log-entry ${entry.role}${entry.isNarration ? ' narration' : ''}${entry.isStreaming ? ' streaming' : ''}${showEditButton ? ' editable' : ''}`}
        >
            <LogAvatar entry={entry} />
            <div className="vn-log-entry-body">
                {!entry.isNarration && <div className="vn-log-speaker">{entry.speakerName}</div>}
                {isEditing ? (
                    <InlineMessageEditor
                        className="vn-log"
                        value={editContent}
                        onChange={onEditChange}
                        onCancel={onCancelEdit}
                        onSubmit={onSubmitEdit}
                        disabled={!canEdit}
                        submitDisabled={entry.role === 'user'
                            ? !editContent.trim() && !editHasAttachments
                            : !editContent.trim()}
                        submitLabel={entry.role === 'user' ? '送信' : '保存'}
                        submitIcon={entry.role === 'user' ? <ArrowUp size={14} /> : <Check size={14} />}
                    />
                ) : (
                    <div
                        className="vn-log-content"
                        {...(entry.isStreaming ? { role: 'status', 'aria-live': 'polite' as const } : {})}
                    >
                        <SafeMarkdown>{formatAssistantMarkdown(
                            entry.role === 'assistant' ? hideAssistantDialogueBrackets(entry.content) : entry.content,
                        )}</SafeMarkdown>
                    </div>
                )}
            </div>
            {showEditButton && (
                <button
                    type="button"
                    className="btn btn-ghost message-action-button vn-log-edit-button"
                    onClick={() => onEdit(entry.id)}
                    title={editTitle}
                    aria-label={editTitle}
                >
                    <Pencil size={14} />
                </button>
            )}
        </article>
    );
}

export default function VisualNovelLogView({
    character,
    priorMessages,
    messages,
    activeStreamingPreview,
    streamingPreviewCharacter,
    formattedStreamingPreviewMessages,
    continuationAppendPreviewKey,
    isLoading,
    isSummarizing,
    canEdit,
    editingMessage,
    onEdit,
    onEditChange,
    onCancelEdit,
    onSubmitEdit,
    onClose,
}: VisualNovelLogViewProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const followBottomRef = useRef(true);

    const entries = useMemo<VisualNovelLogEntry[]>(() => {
        const priorEntries = priorMessages.map(({ message, character: priorCharacter }) => ({
            id: `prior:${message.id}`,
            role: message.role === 'user' ? 'user' as const : 'assistant' as const,
            isNarration: message.role === 'narration',
            content: message.content,
            speakerName: message.role === 'user'
                ? 'あなた'
                : priorCharacter?.name ?? character?.name ?? 'Character',
            characterIcon: message.role === 'assistant'
                ? priorCharacter?.icon ?? character?.icon
                : undefined,
        }));
        const roomEntries = messages.filter((message) => !message.mergedIntoPrevious).map((message) => ({
            id: message.id,
            isNarration: isNarrationMessage(message),
            // 続き生成で連結した発言は複数メッセージにまたがるため、書き換えの対象にしない。
            editable: message.branchMessageId === message.id,
            isArchived: message.isArchived,
            role: message.role,
            content: message.displayContent.trim()
                ? message.displayContent
                : formatMessageTextWithAttachments(message.displayContent, message.attachments),
            speakerName: message.role === 'user'
                ? 'あなた'
                : message.msgCharacterName ?? character?.name ?? 'Character',
            characterIcon: message.role === 'assistant'
                ? message.msgCharacterIcon ?? character?.icon
                : undefined,
        }));
        const appendedEntryId = continuationAppendPreviewKey
            ? `preview:${continuationAppendPreviewKey}`
            : undefined;
        const previewTurns = activeStreamingPreview?.turns;
        const streamingEntries = previewTurns && previewTurns.length > 0
            ? previewTurns.flatMap((turn) => {
                const contents = turn.formattedMessages?.filter((content) => content.trim());
                return (contents && contents.length > 0 ? contents : [turn.content])
                    .filter((content) => content.trim())
                    .map((content, index) => ({
                        id: `preview:${activeStreamingPreview.jobId}:${turn.turnIndex}:${index}`,
                        role: 'assistant' as const,
                        isNarration: isNarratorCharacterId(turn.characterId),
                        content,
                        speakerName: turn.characterName
                            ?? activeStreamingPreview.characterName
                            ?? streamingPreviewCharacter?.name
                            ?? character?.name
                            ?? 'Character',
                        characterIcon: turn.characterId === streamingPreviewCharacter?.id
                            ? streamingPreviewCharacter?.icon
                            : undefined,
                        isStreaming: !turn.complete,
                    }));
            })
            : activeStreamingPreview
                ? (formattedStreamingPreviewMessages.length > 0
                    ? formattedStreamingPreviewMessages
                    : [activeStreamingPreview.content]
                ).filter((content) => content.trim()).map((content, index) => ({
                    id: `preview:${activeStreamingPreview.jobId}:${index}`,
                    role: 'assistant' as const,
                    content,
                    speakerName: activeStreamingPreview.characterName
                        ?? streamingPreviewCharacter?.name
                        ?? character?.name
                        ?? 'Character',
                    characterIcon: streamingPreviewCharacter?.icon ?? character?.icon,
                    isStreaming: true,
                }))
                : [];

        return [
            ...priorEntries,
            ...roomEntries,
            ...streamingEntries.filter((entry) => entry.id !== appendedEntryId),
        ];
    }, [
        activeStreamingPreview,
        character,
        continuationAppendPreviewKey,
        formattedStreamingPreviewMessages,
        messages,
        priorMessages,
        streamingPreviewCharacter,
    ]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    useEffect(() => {
        if (!followBottomRef.current) return;
        const frameId = requestAnimationFrame(() => {
            const scroll = scrollRef.current;
            if (scroll) scroll.scrollTop = scroll.scrollHeight;
        });
        return () => cancelAnimationFrame(frameId);
    }, [entries, isLoading, isSummarizing]);

    return (
        <section className="vn-log-view" aria-label="会話ログ">
            <header className="vn-log-header">
                <div className="vn-log-heading">
                    <History size={19} aria-hidden="true" />
                    <h2>会話ログ</h2>
                </div>
                <button
                    type="button"
                    className="btn btn-ghost vn-log-close"
                    onClick={onClose}
                    title="ゲーム画面に戻る"
                    aria-label="ゲーム画面に戻る"
                    autoFocus
                >
                    <X size={20} />
                </button>
            </header>
            <div
                ref={scrollRef}
                className="vn-log-scroll"
                onScroll={(event) => {
                    const target = event.currentTarget;
                    followBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
                }}
            >
                <div className="vn-log-list">
                    {entries.length === 0 && !isLoading ? (
                        <div className="vn-log-empty">
                            <History size={24} aria-hidden="true" />
                            <p>会話履歴はまだありません。</p>
                        </div>
                    ) : (
                        entries.map((entry) => (
                            <LogEntry
                                key={entry.id}
                                entry={entry}
                                canEdit={canEdit}
                                editContent={editingMessage?.messageId === entry.id ? editingMessage.content : null}
                                editHasAttachments={editingMessage?.messageId === entry.id && editingMessage.hasAttachments}
                                onEdit={onEdit}
                                onEditChange={onEditChange}
                                onCancelEdit={onCancelEdit}
                                onSubmitEdit={onSubmitEdit}
                            />
                        ))
                    )}
                    {isLoading && !activeStreamingPreview && (
                        <div className="vn-log-pending" role="status" aria-live="polite">
                            <WaitingEllipsis />
                        </div>
                    )}
                    {isSummarizing && (
                        <div className="vn-log-status" role="status">
                            <div className="spinner" />
                            古い会話を要約中...
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
}
