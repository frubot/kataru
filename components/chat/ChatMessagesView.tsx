import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { HatGlasses, MessageSquare } from 'lucide-react';
import type { Character } from '@/lib/store';
import type {
    ChatMessagePresentation,
    ChatStreamingPreview,
    PriorMessagePresentation,
} from '@/lib/chatMessagePresentation';
import MessageBubble from '../MessageBubble';
import StoredImage from '../StoredImage';
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
    const messagesEndRef: RefObject<HTMLDivElement | null> = useRef<HTMLDivElement>(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const formatAssistantActions = !isMessageMode;
    const interactionsDisabled = isLoading || isSummarizing || !!branchingMessageId;

    return (
        <div className="chat-messages">
            {priorMessages.length === 0 && messages.length === 0 ? (
                <div className="empty-state" style={{ opacity: 0.7 }}>
                    {isSecretMode ? (
                        <>
                            <HatGlasses size={48} style={{ marginBottom: '0.75rem', opacity: 0.72 }} />
                            <h2 className="empty-state-title">シークレットモード</h2>
                            <p className="empty-state-description">
                                メモリ機能は無効になり、会話は保存されません
                            </p>
                        </>
                    ) : (
                        <>
                            <MessageSquare size={48} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
                            <h2 className="empty-state-title">まずは一言、話しかけてみましょう</h2>
                            <p className="empty-state-description">
                                例：「こんにちは。今日は何をしていたの？」
                            </p>
                        </>
                    )}
                </div>
            ) : (
                <>
                    {priorMessages.map((presentation, index) => (
                        <SituationPriorMessageBubble
                            key={`prior-display:${presentation.message.id}`}
                            presentation={presentation}
                            index={index}
                            formatAssistantActions={formatAssistantActions}
                        />
                    ))}
                    {messages.map((message, index) => (
                        <MessageBubble
                            key={message.id}
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
                    ))}
                </>
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
                    古い会話を要約中...
                </div>
            )}
            <div ref={messagesEndRef} />
        </div>
    );
}
