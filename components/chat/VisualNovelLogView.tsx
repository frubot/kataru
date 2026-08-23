import { useEffect, useMemo, useRef } from 'react';
import { History, UserRound, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Character } from '@/lib/store';
import type {
    ChatMessagePresentation,
    ChatStreamingPreview,
    PriorMessagePresentation,
} from '@/lib/chatMessagePresentation';
import { formatAssistantMarkdown } from '@/lib/markdownUtils';
import StoredImage from '../StoredImage';
import WaitingEllipsis from './WaitingEllipsis';

type VisualNovelLogViewProps = {
    character: Character | null;
    priorMessages: PriorMessagePresentation[];
    messages: ChatMessagePresentation[];
    activeStreamingPreview: ChatStreamingPreview | null;
    streamingPreviewCharacter: Character | null | undefined;
    formattedStreamingPreviewMessages: string[];
    isLoading: boolean;
    isSummarizing: boolean;
    onClose: () => void;
};

type VisualNovelLogEntry = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    speakerName: string;
    characterIcon?: string;
    archived?: boolean;
    showArchiveDivider?: boolean;
    isStreaming?: boolean;
};

function LogAvatar({ entry }: { entry: VisualNovelLogEntry }) {
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

function LogEntry({ entry }: { entry: VisualNovelLogEntry }) {
    return (
        <>
            {entry.showArchiveDivider && (
                <div className="vn-log-divider" role="separator">
                    現在の会話
                </div>
            )}
            <article
                className={`vn-log-entry ${entry.role}${entry.archived ? ' archived' : ''}${entry.isStreaming ? ' streaming' : ''}`}
            >
                <LogAvatar entry={entry} />
                <div className="vn-log-entry-body">
                    <div className="vn-log-speaker">{entry.speakerName}</div>
                    <div
                        className="vn-log-content"
                        {...(entry.isStreaming ? { role: 'status', 'aria-live': 'polite' as const } : {})}
                    >
                        <ReactMarkdown>
                            {entry.role === 'assistant'
                                ? formatAssistantMarkdown(entry.content)
                                : entry.content}
                        </ReactMarkdown>
                    </div>
                </div>
            </article>
        </>
    );
}

export default function VisualNovelLogView({
    character,
    priorMessages,
    messages,
    activeStreamingPreview,
    streamingPreviewCharacter,
    formattedStreamingPreviewMessages,
    isLoading,
    isSummarizing,
    onClose,
}: VisualNovelLogViewProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const followBottomRef = useRef(true);

    const entries = useMemo<VisualNovelLogEntry[]>(() => {
        const priorEntries = priorMessages.map(({ message, character: priorCharacter }) => ({
            id: `prior:${message.id}`,
            role: message.role,
            content: message.content,
            speakerName: message.role === 'user'
                ? 'あなた'
                : priorCharacter?.name ?? character?.name ?? 'Character',
            characterIcon: message.role === 'assistant'
                ? priorCharacter?.icon ?? character?.icon
                : undefined,
        }));
        const roomEntries = messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.displayContent,
            speakerName: message.role === 'user'
                ? 'あなた'
                : message.msgCharacterName ?? character?.name ?? 'Character',
            characterIcon: message.role === 'assistant'
                ? message.msgCharacterIcon ?? character?.icon
                : undefined,
            archived: message.isArchived,
            showArchiveDivider: message.showArchiveDivider,
        }));
        const previewTurns = activeStreamingPreview?.turns;
        const streamingEntries = previewTurns && previewTurns.length > 0
            ? previewTurns.flatMap((turn) => {
                const contents = turn.formattedMessages?.filter((content) => content.trim());
                return (contents && contents.length > 0 ? contents : [turn.content])
                    .filter((content) => content.trim())
                    .map((content, index) => ({
                        id: `preview:${activeStreamingPreview.jobId}:${turn.turnIndex}:${index}`,
                        role: 'assistant' as const,
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

        return [...priorEntries, ...roomEntries, ...streamingEntries];
    }, [
        activeStreamingPreview,
        character,
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
                    <div>
                        <h2>会話ログ</h2>
                        <span>BACK LOG</span>
                    </div>
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
                        entries.map((entry) => <LogEntry key={entry.id} entry={entry} />)
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
