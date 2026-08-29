import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { ReactNode } from 'react';
import { HatGlasses, MessageSquare } from 'lucide-react';
import type { Character } from '@/lib/store';
import type {
    ChatMessagePresentation,
    ChatStreamingPreview,
    PriorMessagePresentation,
} from '@/lib/chatMessagePresentation';
import MessageBubble from '../MessageBubble';
import StoredImage from '../StoredImage';
import {
    buildVirtualLayout,
    CHAT_VIRTUALIZATION_THRESHOLD,
    computeVirtualRange,
    estimateChatMessageHeight,
    getMeasurementScrollAdjustment,
    shouldFollowChatBottom,
} from './chatVirtualization';
import WaitingEllipsis from './WaitingEllipsis';

const NOOP = () => undefined;

function SituationPriorMessageBubble({
    presentation,
    index,
    formatAssistantActions,
}: {
    presentation: PriorMessagePresentation;
    index: number;
    formatAssistantActions: boolean;
}) {
    const { message, character, isAssistantContinuation } = presentation;
    return (
        <MessageBubble
            messageId={`prior-display:${message.id}`}
            role={message.role}
            content={message.content}
            displayContent={message.content}
            index={index}
            isArchived={false}
            isLastMessage={false}
            isLoading={false}
            isHovered={false}
            isCopied={false}
            formatAssistantActions={formatAssistantActions}
            isAssistantContinuation={isAssistantContinuation}
            showAssistantActions={false}
            showBranchAction={false}
            showMemoryIndicator={false}
            showArchiveDivider={false}
            characterIcon={character?.icon}
            characterName={character?.name}
            isGroupRoom
            onMouseEnter={NOOP}
            onMouseLeave={NOOP}
            onTouchStart={NOOP}
            onEdit={NOOP}
            onEditChange={NOOP}
            onCancelEdit={NOOP}
            onSubmitEdit={NOOP}
            onCopy={NOOP}
            onRegenerate={NOOP}
            onBranch={NOOP}
            onOpenMemoryList={NOOP}
        />
    );
}

type EditingMessage = {
    messageId: string;
    content: string;
} | null;

type HistoryItem =
    | {
        key: string;
        kind: 'prior';
        presentation: PriorMessagePresentation;
        presentationIndex: number;
    }
    | {
        key: string;
        kind: 'message';
        presentation: ChatMessagePresentation;
        messageIndex: number;
    };

function MeasuredVirtualRow({
    index,
    itemKey,
    top,
    totalCount,
    setSize,
    children,
}: {
    index: number;
    itemKey: string;
    top: number;
    totalCount: number;
    setSize: (itemKey: string, index: number, size: number) => void;
    children: ReactNode;
}) {
    const rowRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const row = rowRef.current;
        if (!row) return;

        const measure = () => setSize(itemKey, index, row.getBoundingClientRect().height);
        measure();
        if (typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(measure);
        observer.observe(row);
        return () => observer.disconnect();
    }, [index, itemKey, setSize]);

    return (
        <div
            ref={rowRef}
            role="listitem"
            aria-posinset={index + 1}
            aria-setsize={totalCount}
            style={{
                position: 'absolute',
                insetInline: 0,
                top: 0,
                transform: `translateY(${top}px)`,
            }}
        >
            {children}
        </div>
    );
}

type ChatMessagesViewProps = {
    priorMessages: PriorMessagePresentation[];
    messages: ChatMessagePresentation[];
    isSecretMode: boolean;
    isMessageMode: boolean;
    isGroupRoom: boolean;
    character: Character | null;
    activeStreamingPreview: ChatStreamingPreview | null;
    streamingPreviewCharacter: Character | null | undefined;
    formattedStreamingPreviewMessages: string[];
    isLoading: boolean;
    isSummarizing: boolean;
    branchingMessageId: string | null;
    hoveredMessageId: string | null;
    touchedMessageId: string | null;
    copiedMessageId: string | null;
    streamedFinalMessageIds: Set<string>;
    typingMessageId: string | null;
    isTypewriterActive: boolean;
    editingMessage: EditingMessage;
    onMouseEnter: (messageId: string) => void;
    onMouseLeave: (event: React.MouseEvent) => void;
    onTouchStart: (messageId: string) => void;
    onEdit: (messageId: string, messageIndex: number, content: string) => void;
    onEditChange: (content: string) => void;
    onCancelEdit: () => void;
    onSubmitEdit: () => void;
    onCopy: (messageId: string, content: string) => void;
    onRegenerate: () => void;
    onBranch: (messageId: string) => void;
    onOpenMemoryList: (characterId?: string) => void;
    onRevealTypewriter: () => void;
};

function Avatar({ character, name }: { character?: Character | null; name?: string }) {
    return (
        <div style={{ flexShrink: 0, width: '2rem', height: '2rem', borderRadius: '50%', overflow: 'hidden', marginTop: '0.25rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
            {character?.icon ? (
                <StoredImage
                    src={character.icon}
                    alt={name ?? character.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
            ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                    {(name ?? character?.name ?? '?').charAt(0)}
                </div>
            )}
        </div>
    );
}

export default function ChatMessagesView({
    priorMessages,
    messages,
    isSecretMode,
    isMessageMode,
    isGroupRoom,
    character,
    activeStreamingPreview,
    streamingPreviewCharacter,
    formattedStreamingPreviewMessages,
    isLoading,
    isSummarizing,
    branchingMessageId,
    hoveredMessageId,
    touchedMessageId,
    copiedMessageId,
    streamedFinalMessageIds,
    typingMessageId,
    isTypewriterActive,
    editingMessage,
    onMouseEnter,
    onMouseLeave,
    onTouchStart,
    onEdit,
    onEditChange,
    onCancelEdit,
    onSubmitEdit,
    onCopy,
    onRegenerate,
    onBranch,
    onOpenMemoryList,
    onRevealTypewriter,
}: ChatMessagesViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const virtualListRef = useRef<HTMLDivElement>(null);
    const followBottomRef = useRef(true);
    const lastScrollTopRef = useRef(0);
    const pendingScrollAdjustmentRef = useRef(0);
    const scrollFrameRef = useRef<number | null>(null);
    const [measuredHeights, setMeasuredHeights] = useState<Map<string, number>>(() => new Map());
    const [viewport, setViewport] = useState({ scrollOffset: 0, viewportSize: 0 });

    const historyItems = useMemo<HistoryItem[]>(() => [
        ...priorMessages.map((presentation, presentationIndex) => ({
            key: `prior-display:${presentation.message.id}`,
            kind: 'prior' as const,
            presentation,
            presentationIndex,
        })),
        ...messages.map((presentation, messageIndex) => ({
            key: presentation.id,
            kind: 'message' as const,
            presentation,
            messageIndex,
        })),
    ], [messages, priorMessages]);
    const itemSizes = useMemo(() => {
        return historyItems.map((item) => {
            const measuredHeight = measuredHeights.get(item.key);
            if (measuredHeight != null) return measuredHeight;
            const message = item.kind === 'prior' ? item.presentation.message : item.presentation;
            return estimateChatMessageHeight(message.content, message.role);
        });
    }, [historyItems, measuredHeights]);
    const layout = useMemo(() => buildVirtualLayout(itemSizes), [itemSizes]);

    const virtualized = historyItems.length >= CHAT_VIRTUALIZATION_THRESHOLD;

    const readViewport = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        const list = virtualListRef.current;
        const listContentTop = list
            ? list.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
            : 0;
        const nextViewport = {
            scrollOffset: Math.max(0, container.scrollTop - listContentTop),
            viewportSize: container.clientHeight,
        };
        setViewport((current) => (
            Math.abs(current.scrollOffset - nextViewport.scrollOffset) < 0.5
            && current.viewportSize === nextViewport.viewportSize
                ? current
                : nextViewport
        ));
    }, [setViewport]);

    useEffect(() => {
        const activeKeys = new Set(historyItems.map((item) => item.key));
        setMeasuredHeights((current) => {
            if ([...current.keys()].every((key) => activeKeys.has(key))) return current;
            return new Map([...current].filter(([key]) => activeKeys.has(key)));
        });
    }, [historyItems]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        lastScrollTopRef.current = container.scrollTop;

        const handleScroll = () => {
            const scrollTop = container.scrollTop;
            followBottomRef.current = shouldFollowChatBottom({
                previousScrollTop: lastScrollTopRef.current,
                scrollTop,
                distanceFromBottom: container.scrollHeight - scrollTop - container.clientHeight,
            });
            lastScrollTopRef.current = scrollTop;
            if (scrollFrameRef.current != null) return;
            scrollFrameRef.current = requestAnimationFrame(() => {
                scrollFrameRef.current = null;
                readViewport();
            });
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        const observer = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(readViewport);
        observer?.observe(container);
        readViewport();

        return () => {
            container.removeEventListener('scroll', handleScroll);
            observer?.disconnect();
            if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
            scrollFrameRef.current = null;
        };
    }, [readViewport, virtualized]);

    const setVirtualItemSize = useCallback((itemKey: string, reportedIndex: number, nextSize: number) => {
        if (!Number.isFinite(nextSize) || nextSize <= 0) return;
        const index = historyItems[reportedIndex]?.key === itemKey
            ? reportedIndex
            : historyItems.findIndex((item) => item.key === itemKey);
        if (index < 0) return;

        const previousSize = layout.sizes[index] ?? nextSize;
        if (Math.abs(previousSize - nextSize) < 0.5) return;

        const container = containerRef.current;
        const list = virtualListRef.current;
        const listContentTop = container && list
            ? list.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
            : 0;
        const viewportStart = container ? Math.max(0, container.scrollTop - listContentTop) : 0;

        pendingScrollAdjustmentRef.current += getMeasurementScrollAdjustment({
            itemEnd: (layout.starts[index] ?? 0) + previousSize,
            viewportStart,
            previousSize,
            nextSize,
            followingBottom: followBottomRef.current,
        });
        setMeasuredHeights((current) => {
            if (current.get(itemKey) === nextSize) return current;
            const next = new Map(current);
            next.set(itemKey, nextSize);
            return next;
        });
    }, [historyItems, layout, setMeasuredHeights]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const scrollAdjustment = pendingScrollAdjustmentRef.current;
        pendingScrollAdjustmentRef.current = 0;

        if (scrollAdjustment !== 0 && !followBottomRef.current) {
            container.scrollTop += scrollAdjustment;
        } else if (followBottomRef.current) {
            container.scrollTop = container.scrollHeight;
        }
        readViewport();
    });

    const virtualRange = virtualized
        ? computeVirtualRange(layout, viewport.scrollOffset, viewport.viewportSize)
        : { startIndex: 0, endIndex: historyItems.length - 1 };
    const editingIndex = editingMessage
        ? historyItems.findIndex((item) => item.kind === 'message' && item.presentation.id === editingMessage.messageId)
        : -1;
    const visibleIndices = useMemo(() => {
        const indices: number[] = [];
        for (let index = virtualRange.startIndex; index <= virtualRange.endIndex; index++) {
            indices.push(index);
        }
        if (editingIndex >= 0 && !indices.includes(editingIndex)) indices.push(editingIndex);
        return indices.sort((left, right) => left - right);
    }, [editingIndex, virtualRange.endIndex, virtualRange.startIndex]);

    const formatAssistantActions = !isMessageMode;
    const interactionsDisabled = isLoading || isSummarizing || !!branchingMessageId;

    const renderHistoryItem = (item: HistoryItem) => {
        if (item.kind === 'prior') {
            return (
                <SituationPriorMessageBubble
                    presentation={item.presentation}
                    index={item.presentationIndex}
                    formatAssistantActions={formatAssistantActions}
                />
            );
        }

        const { presentation: message, messageIndex: index } = item;
        return (
            <MessageBubble
                messageId={message.id}
                role={message.role}
                content={message.content}
                displayContent={message.displayContent}
                index={index}
                isArchived={message.isArchived}
                isLastMessage={index === messages.length - 1}
                isLoading={interactionsDisabled}
                isHovered={hoveredMessageId === message.id || touchedMessageId === message.id}
                isCopied={copiedMessageId === message.id}
                disableEntranceAnimation={streamedFinalMessageIds.has(message.id)}
                isTypewriterActive={isTypewriterActive && message.id === typingMessageId}
                formatAssistantActions={formatAssistantActions}
                isAssistantContinuation={message.isAssistantContinuation}
                showAssistantActions={message.showAssistantActions}
                showBranchAction={message.showBranchAction}
                showMemoryIndicator={message.showMemoryIndicator}
                showArchiveDivider={message.showArchiveDivider}
                memoryCharacterId={message.characterId}
                characterIcon={message.msgCharacterIcon}
                characterName={message.msgCharacterName}
                isGroupRoom={isGroupRoom}
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
                onTouchStart={onTouchStart}
                onEdit={onEdit}
                isEditing={editingMessage?.messageId === message.id}
                editContent={editingMessage?.messageId === message.id ? editingMessage.content : ''}
                onEditChange={onEditChange}
                onCancelEdit={onCancelEdit}
                onSubmitEdit={onSubmitEdit}
                onCopy={onCopy}
                onRegenerate={onRegenerate}
                onBranch={() => onBranch(message.id)}
                onOpenMemoryList={onOpenMemoryList}
                onRevealTypewriter={onRevealTypewriter}
            />
        );
    };

    return (
        <div ref={containerRef} className="chat-messages">
            {priorMessages.length === 0 && messages.length === 0 ? (
                <div className="empty-state" style={{ opacity: 0.7 }}>
                    {isSecretMode ? (
                        <>
                            <h2 className="empty-state-title">シークレットモード</h2>
                            <p className="empty-state-description">
                                メモリ機能は無効になり、会話は保存されません
                            </p>
                        </>
                    ) : (
                        <>
                            <h2 className="empty-state-title">何を話しますか？</h2>
                        </>
                    )}
                </div>
            ) : (
                virtualized ? (
                    <div
                        ref={virtualListRef}
                        role="list"
                        aria-label="会話履歴"
                        style={{
                            position: 'relative',
                            flex: `0 0 ${layout.totalSize}px`,
                            height: layout.totalSize,
                            minHeight: layout.totalSize,
                        }}
                    >
                        {visibleIndices.map((index) => {
                            const item = historyItems[index];
                            return (
                                <MeasuredVirtualRow
                                    key={item.key}
                                    index={index}
                                    itemKey={item.key}
                                    top={layout.starts[index]}
                                    totalCount={historyItems.length}
                                    setSize={setVirtualItemSize}
                                >
                                    {renderHistoryItem(item)}
                                </MeasuredVirtualRow>
                            );
                        })}
                    </div>
                ) : (
                    historyItems.map((item) => (
                        <Fragment key={item.key}>{renderHistoryItem(item)}</Fragment>
                    ))
                )
            )}
            {formattedStreamingPreviewMessages.length > 0 && activeStreamingPreview ? (
                <>
                    {formattedStreamingPreviewMessages.map((content, index) => (
                        <MessageBubble
                            key={`${activeStreamingPreview.jobId}-preview-${index}`}
                            messageId={`${activeStreamingPreview.jobId}-preview-${index}`}
                            role="assistant"
                            content={content}
                            displayContent={content}
                            index={messages.length + index}
                            isArchived={false}
                            isLastMessage={index === formattedStreamingPreviewMessages.length - 1}
                            isLoading
                            isHovered={false}
                            isCopied={false}
                            formatAssistantActions={formatAssistantActions}
                            isAssistantContinuation={index > 0}
                            showAssistantActions={false}
                            showBranchAction={false}
                            showMemoryIndicator={false}
                            showArchiveDivider={false}
                            memoryCharacterId={activeStreamingPreview.characterId}
                            characterIcon={streamingPreviewCharacter?.icon}
                            characterName={activeStreamingPreview.characterName ?? streamingPreviewCharacter?.name}
                            isGroupRoom={isGroupRoom}
                            onMouseEnter={NOOP}
                            onMouseLeave={NOOP}
                            onTouchStart={NOOP}
                            onEdit={NOOP}
                            onEditChange={NOOP}
                            onCancelEdit={NOOP}
                            onSubmitEdit={NOOP}
                            onCopy={NOOP}
                            onRegenerate={NOOP}
                            onBranch={NOOP}
                            onOpenMemoryList={NOOP}
                        />
                    ))}
                </>
            ) : activeStreamingPreview ? (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <Avatar
                        character={streamingPreviewCharacter}
                        name={activeStreamingPreview.characterName}
                    />
                    <div className="assistant-message-content">
                        {isGroupRoom && activeStreamingPreview.characterName && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.125rem', marginLeft: '0.25rem', fontWeight: 500 }}>
                                {activeStreamingPreview.characterName}
                            </div>
                        )}
                        <div
                            className="message-bubble assistant animate-slide-up streaming-preview-bubble"
                            role="status"
                            aria-live="polite"
                            style={{ whiteSpace: 'pre-wrap' }}
                        >
                            {activeStreamingPreview.content}
                        </div>
                    </div>
                </div>
            ) : null}
            {isLoading && !activeStreamingPreview && messages.at(-1)?.role !== 'assistant' && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <Avatar character={isGroupRoom ? null : character} />
                    <div className="message-bubble assistant animate-slide-up waiting-bubble">
                        <WaitingEllipsis />
                    </div>
                </div>
            )}
            {isSummarizing && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.5rem 0.75rem',
                    marginBottom: '0.5rem',
                    background: 'rgba(var(--accent-primary-rgb), 0.1)',
                    border: '1px solid rgba(var(--accent-primary-rgb), 0.25)',
                    borderRadius: '1rem',
                    fontSize: '0.75rem',
                    color: 'var(--accent-primary)',
                    alignSelf: 'flex-start',
                }}>
                    <div className="spinner" style={{ width: '12px', height: '12px', borderWidth: '2px' }} />
                    古い会話を整理中…
                </div>
            )}
        </div>
    );
}
