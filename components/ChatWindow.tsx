import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { ArrowUp, Sparkles, MessageSquare, MessagesSquare, Menu, Brain, Bug, Square, SquarePen, Gamepad2, Copy, Check, GitBranch, RefreshCw, ChevronsDown, Shirt, X, ChevronDown, HatGlasses, Undo2, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import {
    useStore,
    Room,
    Character,
    Message,
    Situation,
    SituationParticipant,
} from '@/lib/store';
import type { MemoryRecord, SituationPriorMessage } from '@/lib/store';
import type { VnTypingSpeed } from '@/lib/store';
import { getMessageMemories } from '@/lib/chatAssistantResponse';
import {
    ChatGenerationJobError,
    getChatErrorDebugInfo,
    getChatErrorMessage,
    getChatErrorNotice,
    isRetryableGenerationError,
    shouldOpenSettingsForChatError,
} from '@/lib/chatErrors';
import { getChatRegenerationCutIndex } from '@/lib/chatRegeneration';
import { removeSubmittedUserMessage, rollbackRestorableMessages } from '@/lib/chatTurnRollback';
import { isConversationResponseEnd } from '@/lib/conversationBranch';
import {
    cancelConversationJob,
    getConversationJob,
    listConversationJobs,
    submitConversationJob,
} from '@/lib/conversationJobClient';
import type { ConversationJobStatus } from '@/lib/conversationJobClient';
import type { RustTurnResponse } from '@/lib/conversationResult';
import { formatAssistantMarkdown } from '@/lib/markdownUtils';
import MessageBubble from './MessageBubble';
import StoredImage from './StoredImage';
import ChatNoticeBanner from './chat/ChatNoticeBanner';
import { applyConversationResult } from './chat/applyConversationResult';
import { useChatGenerationSessions } from './chat/useChatGenerationSessions';
import type { ChatGenerationSession } from './chat/useChatGenerationSessions';
import { useChatComposerKeyboard, useChatInputRedirect, useTypewriterAdvance } from './chat/useChatKeyboard';
import { useChatNotice } from './chat/useChatNotice';
import type { ChatNoticeAction } from './chat/useChatNotice';

interface ChatWindowProps {
    room: Room | null;
    character: Character | null;
    situation?: Situation | null;
    groupName?: string | null;
    groupCharacters?: SituationParticipant[] | null;
    onOpenSidebar: () => void;
    onOpenMemoryList: (character?: Character | null) => void;
    onCreateCharacter: () => void;
    onOpenSettings?: () => void;
}

const DEFAULT_COSTUME_NAME = 'default';
const NEUTRAL_EXPRESSION_NAME = 'neutral';
const MESSAGE_MODE_BUBBLE_DELAY_MS = 420;
const CONVERSATION_JOB_POLL_INTERVAL_MS = 750;
const CONVERSATION_STREAMING_POLL_INTERVAL_MS = 120;

type RoomViewMode = NonNullable<Room['viewMode']>;
type EditingMessageDraft = {
    roomId: string;
    messageId: string;
    content: string;
};
type TitleGenerationRequestMessage = {
    role: 'user' | 'assistant';
    content: string;
    name?: string;
};
type ReplySuggestionState = {
    roomId: string;
    sourceMessageId: string;
    suggestions: string[];
    loading: boolean;
};
type ConversationCharacter = {
    id: string;
    name: string;
    systemPrompt: string;
    speechStyle?: string;
    protagonistPrompt?: string;
    userConstraints?: string;
    model: string;
    maxTokens?: number;
    maxHistory?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    enableThinking?: boolean;
    enableMemory?: boolean;
    enableSummary?: boolean;
    expressions?: { name: string }[];
    costumes?: {
        name: string;
        expressions?: { name: string }[];
    }[];
};
type ConversationParticipant = ConversationCharacter & {
    actorId: string;
    actorType: SituationParticipant['actorType'];
    sourceCharacterId?: string;
    rolePrompt?: string;
    directorDescription?: string;
};

function toConversationCharacter(character: Character | null): ConversationCharacter | null {
    if (!character) return null;
    return {
        id: character.id,
        name: character.name,
        systemPrompt: character.systemPrompt,
        speechStyle: character.speechStyle,
        protagonistPrompt: character.protagonistPrompt,
        userConstraints: character.userConstraints,
        model: character.model,
        maxTokens: character.maxTokens,
        maxHistory: character.maxHistory,
        temperature: character.temperature,
        topP: character.topP,
        topK: character.topK,
        enableThinking: character.enableThinking,
        enableMemory: character.enableMemory,
        enableSummary: character.enableSummary,
        expressions: character.expressions?.map(({ name }) => ({ name })),
        costumes: character.costumes?.map(({ name, expressions }) => ({
            name,
            expressions: expressions?.map(({ name: expressionName }) => ({ name: expressionName })),
        })),
    };
}

function toConversationParticipant(participant: SituationParticipant): ConversationParticipant {
    return {
        ...toConversationCharacter(participant)!,
        actorId: participant.actorId,
        actorType: participant.actorType,
        sourceCharacterId: participant.sourceCharacterId,
        rolePrompt: participant.rolePrompt,
        directorDescription: participant.directorDescription,
    };
}

function toConversationSituation(situation: Situation | null | undefined) {
    if (!situation) return null;
    return {
        id: situation.id,
        name: situation.name,
        situationPrompt: situation.situationPrompt,
        priorMessages: situation.priorMessages,
        director: {
            model: situation.director.model,
            systemPrompt: situation.director.systemPrompt,
            maxAutoTurns: situation.director.maxAutoTurns,
            stopPolicy: situation.director.stopPolicy,
        },
        memoryMode: situation.memoryMode,
        maxHistory: situation.maxHistory,
    };
}

function toConversationRoom(room: Room) {
    return {
        id: room.id,
        characterId: room.characterId,
        groupId: room.groupId,
        name: room.name,
        viewMode: room.viewMode,
        summary: room.summary,
        summaryCheckpointUserMessageId: room.summaryCheckpointUserMessageId,
        maxMentionChain: room.maxMentionChain,
        costumeSelections: room.costumeSelections,
        secretMode: room.secretMode,
        lastMessagePreview: room.lastMessagePreview,
        lastMessageAt: room.lastMessageAt,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
    };
}

const CHAT_MODE_OPTIONS: { value: RoomViewMode; label: string; description: string }[] = [
    { value: 'chat', label: 'ベーシック', description: 'キャラクターと話す' },
    { value: 'message', label: 'メッセージ', description: 'メッセージアプリのような会話' },
    { value: 'vn', label: 'ゲーム', description: 'ノベルゲームのような体験' },
];

function resolveRoomViewMode(room: Room | null | undefined): RoomViewMode {
    if (room?.viewMode === 'message' || room?.viewMode === 'vn') return room.viewMode;
    return 'chat';
}

function getRoomViewModeLabel(viewMode: RoomViewMode): string {
    return CHAT_MODE_OPTIONS.find((option) => option.value === viewMode)?.label ?? 'ベーシック';
}

function buildTitleGenerationMessages(
    messages: Message[],
    groupCharacters?: SituationParticipant[] | null,
): TitleGenerationRequestMessage[] {
    const characterNameById = new Map(
        (groupCharacters ?? []).map((groupCharacter) => [groupCharacter.id, groupCharacter.name])
    );

    return messages
        .filter((message) => !message.archived)
        .map((message): TitleGenerationRequestMessage | null => {
            const content = message.content.trim();
            if (!content) return null;
            const name = message.role === 'assistant' && message.characterId
                ? characterNameById.get(message.characterId)
                : undefined;
            return {
                role: message.role,
                content,
                ...(name ? { name } : {}),
            };
        })
        .filter((message): message is TitleGenerationRequestMessage => message != null);
}

function renderRoomViewModeIcon(viewMode: RoomViewMode, size = 18) {
    if (viewMode === 'message') return <MessagesSquare size={size} />;
    if (viewMode === 'vn') return <Gamepad2 size={size} />;
    return <MessageSquare size={size} />;
}

function WaitingEllipsis({ className }: { className?: string }) {
    const classes = className ? `waiting-ellipsis ${className}` : 'waiting-ellipsis';

    return (
        <span className={classes} role="status" aria-live="polite" aria-label="返答中…">
            <span className="waiting-ellipsis-dots" aria-hidden="true">
                <span className="waiting-ellipsis-dot">.</span>
                <span className="waiting-ellipsis-dot">.</span>
                <span className="waiting-ellipsis-dot">.</span>
            </span>
        </span>
    );
}

const NOOP = () => undefined;

function SituationPriorMessageBubble({
    message,
    index,
    character,
    isAssistantContinuation,
    formatAssistantActions,
}: {
    message: SituationPriorMessage;
    index: number;
    character?: Pick<Character, 'name' | 'icon'>;
    isAssistantContinuation: boolean;
    formatAssistantActions: boolean;
}) {
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

function findCostume(character: Character | null | undefined, costumeName: string | null | undefined) {
    if (!character || !costumeName || costumeName === DEFAULT_COSTUME_NAME) return null;
    return (character.costumes ?? []).find((costume) => costume.name === costumeName) ?? null;
}

function findDefaultCostume(character: Character | null | undefined) {
    return (character?.costumes ?? []).find((costume) => costume.name.toLowerCase() === DEFAULT_COSTUME_NAME) ?? null;
}

function resolveSelectedCostumeName(room: Room | null | undefined, character: Character | null | undefined): string {
    if (!room || !character) return DEFAULT_COSTUME_NAME;
    const selectedName = room.costumeSelections?.[character.id];
    if (!selectedName || selectedName === DEFAULT_COSTUME_NAME) return DEFAULT_COSTUME_NAME;
    return findCostume(character, selectedName) ? selectedName : DEFAULT_COSTUME_NAME;
}

function resolveExpressionImage(character: Character | null | undefined, emotion: string | null, costumeName = DEFAULT_COSTUME_NAME): string | null {
    if (!character) return null;
    const selectedCostume = findCostume(character, costumeName);
    if (selectedCostume) {
        const costumeExpressions = selectedCostume.expressions ?? [];
        const requested = emotion && emotion.toLowerCase() !== NEUTRAL_EXPRESSION_NAME
            ? costumeExpressions.find((e) => e.name.toLowerCase() === emotion.toLowerCase())
            : undefined;
        return requested?.image ?? selectedCostume.image ?? character.icon ?? null;
    }

    const expressions = character.expressions ?? [];
    const findExpression = (name: string) => expressions.find((e) => e.name.toLowerCase() === name.toLowerCase());
    const requested = emotion ? findExpression(emotion) : undefined;
    const neutral = findExpression(NEUTRAL_EXPRESSION_NAME);
    return requested?.image ?? neutral?.image ?? expressions[0]?.image ?? character.icon ?? null;
}

const VN_TYPING_DEFAULT_DELAY_MS = 24;
const VN_TYPING_COMMA_DELAY_MS = 70;
const VN_TYPING_SENTENCE_DELAY_MS = 160;
const VN_TYPING_ITALIC_DELAY_MS = 90;
const VN_TYPING_SPEED_MULTIPLIER: Record<VnTypingSpeed, number> = {
    slow: 1.55,
    default: 1,
    fast: 0.55,
    streaming: 1,
};

function isEscapedMarker(content: string, index: number): boolean {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && content[i] === '\\'; i--) {
        slashCount++;
    }
    return slashCount % 2 === 1;
}

function isSingleItalicMarker(content: string, index: number): boolean {
    return content[index] === '*'
        && content[index - 1] !== '*'
        && content[index + 1] !== '*'
        && !isEscapedMarker(content, index);
}

function findClosingItalicMarker(content: string, start: number): number {
    for (let i = start + 1; i < content.length; i++) {
        if (isSingleItalicMarker(content, i)) return i;
    }
    return -1;
}

function buildVnTypingSegments(content: string): string[] {
    const segments: string[] = [];
    let i = 0;
    while (i < content.length) {
        if (isSingleItalicMarker(content, i)) {
            const closing = findClosingItalicMarker(content, i);
            if (closing > i + 1) {
                segments.push(content.slice(i, closing + 1));
                i = closing + 1;
                continue;
            }
        }

        const char = Array.from(content.slice(i))[0] ?? '';
        if (!char) break;
        segments.push(char);
        i += char.length;
    }
    return segments;
}

function getBaseVnTypingDelay(segment: string): number {
    if (segment === '\n') return VN_TYPING_SENTENCE_DELAY_MS;

    const isItalicSegment = segment.startsWith('*') && segment.endsWith('*') && segment.length > 2;
    const visibleSegment = isItalicSegment ? segment.slice(1, -1) : segment;
    const lastChar = Array.from(visibleSegment.trimEnd()).at(-1);

    if (lastChar && '。.!！？!?…'.includes(lastChar)) return VN_TYPING_SENTENCE_DELAY_MS;
    if (lastChar && '、,'.includes(lastChar)) return VN_TYPING_COMMA_DELAY_MS;
    if (isItalicSegment) return VN_TYPING_ITALIC_DELAY_MS;
    return VN_TYPING_DEFAULT_DELAY_MS;
}

function getVnTypingDelay(segment: string, speed: VnTypingSpeed): number {
    return Math.max(1, Math.round(getBaseVnTypingDelay(segment) * VN_TYPING_SPEED_MULTIPLIER[speed]));
}

function waitForMessageModeBubbleDelay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, MESSAGE_MODE_BUBBLE_DELAY_MS));
}

function getFullJsonDebugSourceLabel(source: string): string {
    switch (source) {
        case 'assistant-json':
            return '出力されたJSON';
        case 'chat-response-json':
            return '出力されたJSON';
        case 'chat-http-error':
            return 'HTTPエラー';
        case 'chat-response-parse-error':
            return '応答解析エラー';
        case 'chat-error':
            return '生成エラー';
        case 'director-json':
            return 'キャラクタールーターによる出力';
        case 'director-error':
            return 'キャラクタールーターのエラー';
        default:
            return source;
    }
}

type ChatRetryRequest = {
    roomId: string;
    input: string;
    editDraft?: EditingMessageDraft;
    suggestedReply?: string;
};

type ChatGenerationResult = {
    status: 'success' | 'aborted' | 'detached' | 'error';
    message?: string;
    toCharacterIds?: string[];
    error?: unknown;
};

type ChatConversationJobStatus = ConversationJobStatus<RustTurnResponse>;

type StreamingPreview = {
    roomId: string;
    jobId: string;
    content: string;
    characterId?: string;
    characterName?: string;
    formattedMessages?: string[];
    expression?: string;
};

function waitForConversationJobPoll(signal: AbortSignal, intervalMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException('Generation stopped', 'AbortError'));
            return;
        }
        const handleAbort = () => {
            clearTimeout(timeout);
            reject(new DOMException('Generation stopped', 'AbortError'));
        };
        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', handleAbort);
            resolve();
        }, intervalMs);
        signal.addEventListener('abort', handleAbort, { once: true });
    });
}

export default function ChatWindow({ room, character, situation, groupName, groupCharacters, onOpenSidebar, onOpenMemoryList, onCreateCharacter, onOpenSettings }: ChatWindowProps) {
    const {
        addMessage,
        addMemory,
        deleteMessagesFrom,
        restoreMessagesAt,
        attachMemoriesToMessage,
        getCurrentRoom,
        refreshConversationRoom,
        updateRoomSummary,
        compressRoomHistory,
        updateRoomSettings,
        updateRoomName,
        setRoomReplySuggestions,
        setRoomSecretMode,
        createRoom,
        createRoomForSituation,
        branchRoomFromMessage,
        vnTypingSpeed,
        summaryModel: globalSummaryModel,
        memoryExtractionModel,
        memoryEmbeddingModel,
        generateTitleOnFirstReply,
        titleGenerationModel,
        replySuggestionsEnabled,
        replySuggestionModel,
        fullJsonDebugEnabled,
        detailedErrorLoggingEnabled,
        fullJsonDebugLogs,
        addFullJsonDebugLog,
        clearFullJsonDebugLogs,
        listMemoriesForCharacter,
        markMemoriesUsed,
        getAiApiConfig,
    } = useStore();
    const isGroupRoom = situation != null || (groupCharacters != null && groupCharacters.length > 1);
    const rawRoomViewMode = resolveRoomViewMode(room);
    const availableChatModeOptions = isGroupRoom
        ? CHAT_MODE_OPTIONS.filter((option) => option.value !== 'vn')
        : CHAT_MODE_OPTIONS;
    const currentRoomViewMode = isGroupRoom && rawRoomViewMode === 'vn' ? 'chat' : rawRoomViewMode;
    const isMessageMode = currentRoomViewMode === 'message';
    const isVisualNovelMode = currentRoomViewMode === 'vn' && !isGroupRoom;
    const currentRoomViewModeLabel = getRoomViewModeLabel(currentRoomViewMode);
    const isRoomEmpty = (room?.messages.length ?? 0) === 0;
    const isSecretMode = room?.secretMode === true;
    const showHeaderMemoryButton = !isSecretMode && !isGroupRoom && character != null && character.enableMemory !== false;
    const [input, setInput] = useState('');
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const [mentionStartIndex, setMentionStartIndex] = useState(0);
    const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
    const [touchedMessageId, setTouchedMessageId] = useState<string | null>(null);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const [branchingMessageId, setBranchingMessageId] = useState<string | null>(null);
    const [editingMessage, setEditingMessage] = useState<EditingMessageDraft | null>(null);
    const [vnBounceActive, setVnBounceActive] = useState(false);
    const [typingMessageId, setTypingMessageId] = useState<string | null>(null);
    const [typedContent, setTypedContent] = useState('');
    const [isTypewriterActive, setIsTypewriterActive] = useState(false);
    const [chatModeMenuOpen, setChatModeMenuOpen] = useState(false);
    const [vnCostumeMenuOpen, setVnCostumeMenuOpen] = useState(false);
    const [debugLogOpen, setDebugLogOpen] = useState(false);
    const [replySuggestionState, setReplySuggestionState] = useState<ReplySuggestionState | null>(null);
    const [streamingPreview, setStreamingPreview] = useState<StreamingPreview | null>(null);
    const [streamedFinalMessageIds, setStreamedFinalMessageIds] = useState<Set<string>>(() => new Set());
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const vnDialogueBodyRef = useRef<HTMLDivElement>(null);
    const chatModeMenuRef = useRef<HTMLDivElement>(null);
    const vnCostumeMenuRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const resumedJobsRef = useRef<Set<string>>(new Set());
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const vnBounceStartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const vnBounceStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const vnTypewriterRef = useRef<{ messageId: string; fullContent: string } | null>(null);
    const vnTypeDelayRef = useRef<{ timeout: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);
    const retrySubmissionRef = useRef<ChatRetryRequest | null>(null);
    const chatNoticeActionRunningRef = useRef(false);
    const replySuggestionRequestKeyRef = useRef<string | null>(null);
    const replySuggestionControllerRef = useRef<AbortController | null>(null);
    const vnTypingSpeedRef = useRef(vnTypingSpeed);
    const messagePointerDragRef = useRef(false);
    const {
        notice: chatNotice,
        showNotice: showChatNotice,
        dismissNotice: dismissChatNotice,
        handleMouseEnter: handleChatNoticeMouseEnter,
        handleMouseLeave: handleChatNoticeMouseLeave,
    } = useChatNotice({
        onClearAction: () => {
            retrySubmissionRef.current = null;
        },
    });
    const {
        activeRoomIds: activeGenerationRoomIds,
        startSession: startGenerationSession,
        finishSession: finishGenerationSession,
        cancelSession: cancelGenerationSession,
        isSessionActive: isGenerationSessionActive,
        hasSession: hasGenerationSession,
        attachController: attachGenerationController,
        clearController: clearGenerationController,
    } = useChatGenerationSessions({
        cancelRemote: cancelConversationJob,
        onCancelError: (error) => {
            console.warn('Conversation job cancellation failed:', error);
            showChatNotice('生成を停止できませんでした。もう一度お試しください。');
        },
    });
    const currentRoomId = room?.id;
    const isLoading = currentRoomId ? activeGenerationRoomIds.has(currentRoomId) : false;
    const isEditingMessage = editingMessage?.roomId === currentRoomId;
    const isInlineVnEditing = isVisualNovelMode && isEditingMessage;
    const debugPanelEnabled = fullJsonDebugEnabled;
    const visibleDebugLogCount = fullJsonDebugLogs.length;
    const replySuggestionRoomId = room?.id;
    const replySuggestionMessages = room?.messages;
    const savedReplySuggestions = room?.replySuggestions;
    const latestReplySuggestionMessage = useMemo(() => {
        const visibleMessages = replySuggestionMessages?.filter((message) => !message.archived) ?? [];
        return visibleMessages[visibleMessages.length - 1];
    }, [replySuggestionMessages]);
    const savedReplySuggestionState = useMemo<ReplySuggestionState | null>(() => {
        const saved = savedReplySuggestions;
        if (
            !saved
            || !replySuggestionRoomId
            || latestReplySuggestionMessage?.role !== 'assistant'
            || saved.sourceMessageId !== latestReplySuggestionMessage.id
            || !Array.isArray(saved.suggestions)
        ) return null;
        const suggestions = saved.suggestions
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map((value) => value.trim());
        if (suggestions.length !== 3) return null;
        return {
            roomId: replySuggestionRoomId,
            sourceMessageId: saved.sourceMessageId,
            suggestions,
            loading: false,
        };
    }, [latestReplySuggestionMessage, replySuggestionRoomId, savedReplySuggestions]);
    const replySuggestionMessagesJson = useMemo(
        () => JSON.stringify(
            buildTitleGenerationMessages(replySuggestionMessages ?? [], groupCharacters).slice(-20)
        ),
        [groupCharacters, replySuggestionMessages],
    );
    const protagonistPromptForSuggestions = useMemo(() => {
        const participants = isGroupRoom ? groupCharacters ?? [] : character ? [character] : [];
        const seen = new Set<string>();
        return participants
            .flatMap((participant) => {
                const prompt = participant.protagonistPrompt?.trim();
                if (!prompt || seen.has(prompt)) return [];
                seen.add(prompt);
                return [`${participant.name}から見た主人公:\n${prompt}`];
            })
            .join('\n\n');
    }, [character, groupCharacters, isGroupRoom]);

    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, []);

    const showChatErrorNotice = useCallback((error: unknown, action?: ChatNoticeAction) => {
        const inferredAction = action ?? (
            onOpenSettings && shouldOpenSettingsForChatError(error)
                ? { type: 'open-settings' as const, label: '設定を確認' as const }
                : undefined
        );
        showChatNotice(getChatErrorNotice(error, detailedErrorLoggingEnabled), inferredAction);
    }, [detailedErrorLoggingEnabled, onOpenSettings, showChatNotice]);

    const logChatError = useCallback((context: string, error: unknown) => {
        if (detailedErrorLoggingEnabled) {
            console.error(context, getChatErrorDebugInfo(error));
            return;
        }
        console.error(context, getChatErrorMessage(error));
    }, [detailedErrorLoggingEnabled]);

    const generateInitialRoomTitle = useCallback(async (roomId: string, originalRoomName: string) => {
        const latestRoom = getCurrentRoom();
        if (latestRoom?.id !== roomId || latestRoom.secretMode === true || latestRoom.name !== originalRoomName) return;

        const titleMessages = buildTitleGenerationMessages(latestRoom.messages, groupCharacters);
        if (!titleMessages.some((message) => message.role === 'assistant')) return;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60_000);
        try {
            const response = await fetch('/api/generate-title', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: titleMessages,
                    model: titleGenerationModel.trim(),
                    aiApiConfig: getAiApiConfig(),
                }),
                signal: controller.signal,
            });
            if (!response.ok) return;

            const data = await response.json();
            const title = typeof data?.title === 'string' ? data.title.trim() : '';
            if (!title || title === originalRoomName) return;

            const roomBeforeUpdate = getCurrentRoom();
            if (roomBeforeUpdate?.id !== roomId || roomBeforeUpdate.secretMode === true || roomBeforeUpdate.name !== originalRoomName) return;
            updateRoomName(roomId, title);
        } catch (error) {
            if (!(error instanceof Error && error.name === 'AbortError')) {
                console.warn('Room title generation failed:', error);
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }, [getAiApiConfig, getCurrentRoom, groupCharacters, titleGenerationModel, updateRoomName]);

    const clearStreamingPreview = useCallback((jobId: string) => {
        setStreamingPreview((current) => current?.jobId === jobId ? null : current);
    }, []);

    const rememberStreamedFinalMessageIds = useCallback((messageIds: string[]) => {
        if (messageIds.length === 0) return;
        setStreamedFinalMessageIds((current) => {
            const remembered = new Set(current);
            let changed = false;
            for (const messageId of messageIds) {
                if (!remembered.has(messageId)) changed = true;
                remembered.add(messageId);
            }
            return changed ? remembered : current;
        });
    }, []);

    const pollConversationJob = useCallback(async (
        session: ChatGenerationSession,
        controller: AbortController,
    ): Promise<ChatConversationJobStatus> => {
        while (isGenerationSessionActive(session) && !controller.signal.aborted) {
            const pollInterval = vnTypingSpeedRef.current === 'streaming'
                ? CONVERSATION_STREAMING_POLL_INTERVAL_MS
                : CONVERSATION_JOB_POLL_INTERVAL_MS;
            await waitForConversationJobPoll(controller.signal, pollInterval);
            const job = await getConversationJob<RustTurnResponse>(session.jobId, controller.signal);
            if (
                vnTypingSpeedRef.current === 'streaming'
                && job.preview?.content?.trim()
                && getCurrentRoom()?.id === job.roomId
            ) {
                setStreamingPreview({
                    roomId: job.roomId,
                    jobId: job.jobId,
                    content: job.preview.content,
                    characterId: job.preview.characterId,
                    characterName: job.preview.characterName,
                    formattedMessages: job.preview.formattedMessages,
                    expression: job.preview.expression,
                });
            }
            if (job.status !== 'running') return job;
        }
        throw new DOMException('Generation stopped', 'AbortError');
    }, [getCurrentRoom, isGenerationSessionActive]);

    const resumeConversationJob = useCallback(async (job: ChatConversationJobStatus) => {
        if (resumedJobsRef.current.has(job.jobId) || hasGenerationSession(job.roomId)) {
            return;
        }
        resumedJobsRef.current.add(job.jobId);
        if (job.status === 'completed') {
            await refreshConversationRoom(job.roomId);
            return;
        }
        if (job.status !== 'running') return;

        const session = startGenerationSession(job.roomId, job.jobId);
        const controller = new AbortController();
        if (!attachGenerationController(session, controller)) return;
        try {
            const completed = await pollConversationJob(session, controller);
            if (completed.status === 'completed') {
                if (vnTypingSpeedRef.current === 'streaming') {
                    rememberStreamedFinalMessageIds(
                        completed.result?.messages
                            ?.map((message) => message.id)
                            .filter(Boolean)
                        ?? [],
                    );
                }
                await refreshConversationRoom(job.roomId);
            } else if (completed.status === 'failed' && getCurrentRoom()?.id === job.roomId) {
                const error = completed.error || 'バックグラウンド生成に失敗しました。';
                logChatError('Conversation job failed:', error);
                showChatErrorNotice(error);
            }
        } catch (error) {
            if (!(error instanceof Error && error.name === 'AbortError')) {
                logChatError('Conversation job recovery failed:', error);
                if (getCurrentRoom()?.id === job.roomId) {
                    showChatErrorNotice(error);
                }
            }
        } finally {
            clearStreamingPreview(session.jobId);
            clearGenerationController(session, controller);
            finishGenerationSession(session);
        }
    }, [
        attachGenerationController,
        clearStreamingPreview,
        clearGenerationController,
        finishGenerationSession,
        getCurrentRoom,
        hasGenerationSession,
        logChatError,
        pollConversationJob,
        refreshConversationRoom,
        rememberStreamedFinalMessageIds,
        showChatErrorNotice,
        startGenerationSession,
    ]);

    useEffect(() => {
        let disposed = false;
        void listConversationJobs<RustTurnResponse>()
            .then((jobs) => {
                if (disposed) return;
                for (const job of jobs) {
                    void resumeConversationJob(job).catch((error) => {
                        console.warn('Conversation job synchronization failed:', error);
                    });
                }
            })
            .catch((error) => {
                if (!disposed) {
                    console.warn('Conversation job discovery failed:', error);
                }
            });
        return () => {
            disposed = true;
        };
    }, [resumeConversationJob]);

    useEffect(() => {
        vnTypingSpeedRef.current = vnTypingSpeed;
    }, [vnTypingSpeed]);

    useEffect(() => {
        dismissChatNotice();
    }, [currentRoomId, dismissChatNotice]);

    useEffect(() => {
        setEditingMessage(null);
    }, [currentRoomId]);

    useEffect(() => {
        const canGenerate = replySuggestionsEnabled
            && replySuggestionRoomId != null
            && latestReplySuggestionMessage?.role === 'assistant'
            && !isLoading
            && !isSummarizing
            && !isTypewriterActive;

        if (!canGenerate || !replySuggestionRoomId || !latestReplySuggestionMessage) {
            if (!replySuggestionsEnabled || latestReplySuggestionMessage?.role !== 'assistant') {
                replySuggestionRequestKeyRef.current = null;
                setReplySuggestionState((current) => current ? null : current);
            }
            return;
        }

        const sourceMessageId = latestReplySuggestionMessage.id;
        const requestKey = `${replySuggestionRoomId}:${sourceMessageId}`;
        if (savedReplySuggestionState) {
            replySuggestionRequestKeyRef.current = requestKey;
            setReplySuggestionState((current) => {
                if (
                    current?.roomId === savedReplySuggestionState.roomId
                    && current.sourceMessageId === savedReplySuggestionState.sourceMessageId
                    && !current.loading
                    && current.suggestions.length === savedReplySuggestionState.suggestions.length
                    && current.suggestions.every((suggestion, index) =>
                        suggestion === savedReplySuggestionState.suggestions[index]
                    )
                ) return current;
                return savedReplySuggestionState;
            });
            return;
        }
        if (replySuggestionRequestKeyRef.current === requestKey) return;
        replySuggestionRequestKeyRef.current = requestKey;
        const controller = new AbortController();
        replySuggestionControllerRef.current = controller;
        const timeoutId = setTimeout(() => {
            controller.abort();
            if (replySuggestionControllerRef.current === controller) {
                setReplySuggestionState((current) =>
                    current?.roomId === replySuggestionRoomId && current.sourceMessageId === sourceMessageId
                        ? null
                        : current
                );
            }
        }, 60_000);
        let settled = false;
        setReplySuggestionState({
            roomId: replySuggestionRoomId,
            sourceMessageId,
            suggestions: [],
            loading: true,
        });

        void fetch('/api/generate-reply-suggestions', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: JSON.parse(replySuggestionMessagesJson),
                model: replySuggestionModel.trim(),
                protagonistPrompt: protagonistPromptForSuggestions,
                situationPrompt: situation?.situationPrompt,
                aiApiConfig: getAiApiConfig(),
            }),
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) throw new Error(`Reply suggestion request failed (${response.status})`);
                return response.json();
            })
            .then((data) => {
                const suggestions = Array.isArray(data?.suggestions)
                    ? data.suggestions
                        .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
                        .map((value: string) => value.trim())
                    : [];
                if (
                    controller.signal.aborted
                    || replySuggestionControllerRef.current !== controller
                    || suggestions.length !== 3
                ) return;
                setRoomReplySuggestions(replySuggestionRoomId, { sourceMessageId, suggestions });
                setReplySuggestionState((current) =>
                    current?.roomId === replySuggestionRoomId && current.sourceMessageId === sourceMessageId
                        ? { ...current, suggestions, loading: false }
                        : current
                );
            })
            .catch((error) => {
                if (error instanceof Error && error.name === 'AbortError') return;
                if (replySuggestionControllerRef.current !== controller) return;
                console.warn('Reply suggestion generation failed:', error);
                setReplySuggestionState((current) =>
                    current?.roomId === replySuggestionRoomId && current.sourceMessageId === sourceMessageId
                        ? null
                        : current
                );
            })
            .finally(() => {
                settled = true;
                clearTimeout(timeoutId);
                if (replySuggestionControllerRef.current === controller) {
                    replySuggestionControllerRef.current = null;
                }
            });

        return () => {
            clearTimeout(timeoutId);
            controller.abort();
            if (replySuggestionControllerRef.current === controller) {
                replySuggestionControllerRef.current = null;
            }
            if (!settled && replySuggestionRequestKeyRef.current === requestKey) {
                replySuggestionRequestKeyRef.current = null;
            }
        };
    }, [
        getAiApiConfig,
        isLoading,
        isSummarizing,
        isTypewriterActive,
        latestReplySuggestionMessage,
        protagonistPromptForSuggestions,
        replySuggestionModel,
        replySuggestionMessagesJson,
        replySuggestionsEnabled,
        replySuggestionRoomId,
        savedReplySuggestionState,
        setRoomReplySuggestions,
        situation?.situationPrompt,
    ]);

    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth <= 768);
        };
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // Clear touched/hovered message when tapping outside any message
    useEffect(() => {
        const handleGlobalTouch = (e: TouchEvent) => {
            const target = e.target as Element;
            if (!target.closest('.message-hover-zone')) {
                setTouchedMessageId(null);
                setHoveredMessageId(null);
            }
        };
        document.addEventListener('touchstart', handleGlobalTouch);
        return () => document.removeEventListener('touchstart', handleGlobalTouch);
    }, []);

    useEffect(() => {
        const handlePointerDown = (e: PointerEvent) => {
            const target = e.target as Element | null;
            messagePointerDragRef.current = Boolean(target?.closest('.message-hover-zone'));
        };
        const handlePointerUp = (e: PointerEvent) => {
            if (!messagePointerDragRef.current) return;
            messagePointerDragRef.current = false;
            const target = document.elementFromPoint(e.clientX, e.clientY);
            if (!target?.closest('.message-hover-zone')) {
                setHoveredMessageId(null);
            }
        };
        const handlePointerCancel = () => {
            messagePointerDragRef.current = false;
            setHoveredMessageId(null);
        };

        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('pointerup', handlePointerUp, true);
        document.addEventListener('pointercancel', handlePointerCancel, true);
        window.addEventListener('blur', handlePointerCancel);

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('pointerup', handlePointerUp, true);
            document.removeEventListener('pointercancel', handlePointerCancel, true);
            window.removeEventListener('blur', handlePointerCancel);
        };
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [room?.messages, typedContent, scrollToBottom]);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
        }
    }, [input, editingMessage?.content, isInlineVnEditing]);

    useEffect(() => {
        if (room?.id && window.innerWidth > 768) {
            textareaRef.current?.focus();
        }
    }, [room?.id]);

    const triggerVnBounce = useCallback(() => {
        if (vnBounceStartRef.current) {
            clearTimeout(vnBounceStartRef.current);
            vnBounceStartRef.current = null;
        }
        if (vnBounceStopRef.current) {
            clearTimeout(vnBounceStopRef.current);
            vnBounceStopRef.current = null;
        }
        setVnBounceActive(false);
        vnBounceStartRef.current = setTimeout(() => {
            setVnBounceActive(true);
            vnBounceStopRef.current = setTimeout(() => {
                setVnBounceActive(false);
                vnBounceStopRef.current = null;
            }, 620);
            vnBounceStartRef.current = null;
        }, 20);
    }, []);

    const releaseVnTypeDelay = useCallback(() => {
        const pendingDelay = vnTypeDelayRef.current;
        if (!pendingDelay) return;
        clearTimeout(pendingDelay.timeout);
        vnTypeDelayRef.current = null;
        pendingDelay.resolve();
    }, []);

    const stopTypewriter = useCallback((revealFull: boolean) => {
        const activeRun = vnTypewriterRef.current;
        if (!activeRun) return false;

        vnTypewriterRef.current = null;
        releaseVnTypeDelay();
        setTypedContent(revealFull ? activeRun.fullContent : '');
        setTypingMessageId(null);
        setIsTypewriterActive(false);
        return true;
    }, [releaseVnTypeDelay]);

    const playTypewriter = useCallback(async (messageId: string, fullContent: string) => {
        stopTypewriter(false);

        const segments = buildVnTypingSegments(fullContent);
        if (segments.length === 0) {
            setTypingMessageId(null);
            setTypedContent('');
            setIsTypewriterActive(false);
            return;
        }

        const run = { messageId, fullContent };
        vnTypewriterRef.current = run;
        setTypingMessageId(messageId);
        setTypedContent('');
        setIsTypewriterActive(true);

        let typedContent = '';
        for (const segment of segments) {
            if (vnTypewriterRef.current !== run) return;

            typedContent += segment;
            setTypedContent(typedContent);

            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (vnTypeDelayRef.current?.timeout === timeout) {
                        vnTypeDelayRef.current = null;
                    }
                    resolve();
                }, getVnTypingDelay(segment, vnTypingSpeedRef.current));
                vnTypeDelayRef.current = { timeout, resolve };
            });
        }

        if (vnTypewriterRef.current !== run) return;
        vnTypewriterRef.current = null;
        setTypedContent(fullContent);
        setTypingMessageId(null);
        setIsTypewriterActive(false);
    }, [stopTypewriter]);

    useEffect(() => {
        return () => {
            if (vnBounceStartRef.current) clearTimeout(vnBounceStartRef.current);
            if (vnBounceStopRef.current) clearTimeout(vnBounceStopRef.current);
        };
    }, []);

    // Room switches only stop room-local presentation. Server-side generation continues.
    useEffect(() => {
        return () => {
            stopTypewriter(false);
            setIsSummarizing(false);
        };
    }, [room?.id, stopTypewriter]);

    useEffect(() => {
        if (!isVisualNovelMode) {
            setVnCostumeMenuOpen(false);
        }
    }, [isVisualNovelMode]);

    useEffect(() => {
        if (!debugPanelEnabled) {
            setDebugLogOpen(false);
        }
    }, [debugPanelEnabled]);

    useEffect(() => {
        if (isMessageMode) {
            stopTypewriter(true);
        }
    }, [isMessageMode, stopTypewriter]);

    useEffect(() => {
        if (isGroupRoom) {
            setChatModeMenuOpen(false);
        }
    }, [isGroupRoom]);

    useEffect(() => {
        setChatModeMenuOpen(false);
    }, [room?.id]);

    useEffect(() => {
        if (!chatModeMenuOpen) return;
        const handlePointerDown = (e: PointerEvent) => {
            const target = e.target as Node | null;
            if (target && chatModeMenuRef.current?.contains(target)) return;
            setChatModeMenuOpen(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [chatModeMenuOpen]);

    useEffect(() => {
        if (!vnCostumeMenuOpen) return;
        const handlePointerDown = (e: PointerEvent) => {
            const target = e.target as Node | null;
            if (target && vnCostumeMenuRef.current?.contains(target)) return;
            setVnCostumeMenuOpen(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [vnCostumeMenuOpen]);

    useEffect(() => {
        setVnCostumeMenuOpen(false);
    }, [room?.id, character?.id]);

    // キーボード入力を常にテキストエリアにリダイレクト（モーダル等は除外）
    useChatInputRedirect({
        inputRef: textareaRef,
        disabled: isLoading || (isEditingMessage && !isInlineVnEditing),
        isMobile,
    });

    // Build a map of characterId -> Character for group rooms
    const characterMap = useMemo(() => {
        if (!isGroupRoom || !groupCharacters) return null;
        const map = new Map<string, Character>();
        for (const c of groupCharacters) map.set(c.id, c);
        return map;
    }, [isGroupRoom, groupCharacters]);

    // @mention candidates filtered by current query
    const mentionCandidates = useMemo(() => {
        if (!isGroupRoom || !groupCharacters || mentionQuery === null) return [];
        const q = mentionQuery.toLowerCase();
        if (q === '') return groupCharacters;
        return groupCharacters.filter((c) => c.name.toLowerCase().startsWith(q));
    }, [isGroupRoom, groupCharacters, mentionQuery]);

    const priorMessagesForDisplay = useMemo(() => {
        const messages = situation?.priorMessages ?? [];
        return messages.map((message, index) => {
            const previousMessage = messages[index - 1];
            const isAssistantContinuation = message.role === 'assistant' &&
                previousMessage?.role === 'assistant' &&
                previousMessage.actorId === message.actorId;
            return {
                message,
                character: message.role === 'assistant' ? characterMap?.get(message.actorId) : undefined,
                isAssistantContinuation,
            };
        });
    }, [characterMap, situation?.priorMessages]);

    // Memoize processed messages for rendering
    const processedMessages = useMemo(() => {
        if (!room) return [];
        return room.messages.map((message, index) => {
            const isArchived = !!message.archived;
            const showArchiveDivider = isArchived && (index === 0 || !room.messages[index - 1].archived)
                ? false
                : !isArchived && index > 0 && !!room.messages[index - 1].archived;
            const previousMessage = room.messages[index - 1];
            const nextMessage = room.messages[index + 1];
            const messageCharacterKey = message.characterId ?? (!isGroupRoom ? character?.id : undefined);
            const previousCharacterKey = previousMessage?.characterId ?? (!isGroupRoom ? character?.id : undefined);
            const nextCharacterKey = nextMessage?.characterId ?? (!isGroupRoom ? character?.id : undefined);
            const isAssistantContinuation = message.role === 'assistant' &&
                previousMessage?.role === 'assistant' &&
                messageCharacterKey === previousCharacterKey &&
                !showArchiveDivider;
            const hasNextAssistantContinuation = message.role === 'assistant' &&
                nextMessage?.role === 'assistant' &&
                messageCharacterKey === nextCharacterKey &&
                !nextMessage.archived;
            const showAssistantActions = !hasNextAssistantContinuation;
            const showBranchAction = !isSecretMode && isConversationResponseEnd(room.messages, index);
            const memories = message.role === 'assistant' ? getMessageMemories(message) : [];
            const displayContent = message.role === 'assistant' && message.id === typingMessageId
                ? typedContent
                : message.content;

            // Resolve per-message character for group rooms
            const msgCharacter = message.characterId && characterMap
                ? characterMap.get(message.characterId)
                : null;

            return {
                ...message,
                displayContent,
                emotion: message.expression,
                isArchived,
                isAssistantContinuation,
                showAssistantActions,
                showBranchAction,
                showArchiveDivider,
                showMemoryIndicator: memories.length > 0,
                msgCharacterIcon: msgCharacter?.icon ?? (isGroupRoom ? undefined : character?.icon),
                msgCharacterName: msgCharacter?.name ?? (isGroupRoom ? undefined : character?.name),
            };
        });
    }, [room, characterMap, character, isGroupRoom, isSecretMode, typingMessageId, typedContent]);

    const currentReplyAssistantMessages = useMemo(() => {
        if (!room) return [];
        let latestUserIndex = -1;
        for (let index = room.messages.length - 1; index >= 0; index--) {
            if (room.messages[index].role === 'user') {
                latestUserIndex = index;
                break;
            }
        }
        return room.messages
            .slice(latestUserIndex + 1)
            .filter((message) => message.role === 'assistant');
    }, [room]);
    const availableFormattedStreamingMessages = streamingPreview?.formattedMessages
        ?.filter((content) => content.trim())
        ?? [];
    const streamingPreviewAlreadyPersisted = availableFormattedStreamingMessages.length > 0
        && availableFormattedStreamingMessages.every((content) =>
            currentReplyAssistantMessages.some((message) =>
                message.content === content
                && (!streamingPreview?.characterId || message.characterId === streamingPreview.characterId)
            )
        );
    const activeStreamingPreview = streamingPreview
        && streamingPreview.roomId === room?.id
        && isLoading
        && streamingPreview.content.trim()
        && !streamingPreviewAlreadyPersisted
        ? streamingPreview
        : null;
    const streamingPreviewCharacter = activeStreamingPreview?.characterId && characterMap
        ? characterMap.get(activeStreamingPreview.characterId)
        : character;
    const formattedStreamingPreviewMessages = activeStreamingPreview
        ? availableFormattedStreamingMessages
        : [];

    const handleStop = () => {
        if (stopTypewriter(true)) {
            return;
        }

        if (room) {
            cancelGenerationSession(room.id);
        }
        setIsSummarizing(false);
    };

    const generateRustTurn = async (
        session: ChatGenerationSession,
        sourceRoom: Room,
    ): Promise<ChatGenerationResult> => {
        if (!isGenerationSessionActive(session)) return { status: 'aborted' };
        const shouldStreamPreview = vnTypingSpeedRef.current === 'streaming';
        if (shouldStreamPreview) {
            setStreamingPreview((current) => current?.roomId === sourceRoom.id ? null : current);
        }

        const controller = new AbortController();
        if (!attachGenerationController(session, controller)) {
            return { status: 'aborted' };
        }

        try {
            const accepted = await submitConversationJob<RustTurnResponse>({
                    jobId: session.jobId,
                    room: toConversationRoom(sourceRoom),
                    character: toConversationCharacter(character),
                    situation: toConversationSituation(situation),
                    groupCharacters: groupCharacters?.map(toConversationParticipant),
                    messages: sourceRoom.messages,
                    secretMode: isSecretMode,
                    summaryModel: globalSummaryModel,
                    memoryExtractionModel,
                    memoryEmbeddingModel,
                    aiApiConfig: getAiApiConfig(),
                    streamingPreview: shouldStreamPreview,
                }, controller.signal);
            if (!isGenerationSessionActive(session) || controller.signal.aborted) {
                throw new DOMException('Generation stopped', 'AbortError');
            }
            session.jobId = accepted.jobId;
            const job = accepted.status === 'running'
                ? await pollConversationJob(session, controller)
                : accepted;
            if (job.status === 'cancelled') {
                return { status: 'aborted' };
            }
            if (job.status === 'failed') {
                throw new ChatGenerationJobError(job.error);
            }
            if (job.status !== 'completed' || !job.result) {
                throw new ChatGenerationJobError('バックグラウンド生成の結果を取得できませんでした。');
            }
            const appliedResult = await applyConversationResult(
                {
                    data: job.result,
                    sourceRoom,
                    jobId: session.jobId,
                    character,
                    isSecretMode,
                    isMessageMode,
                    shouldStreamPreview,
                    typingSpeed: vnTypingSpeed,
                    debugEnabled: fullJsonDebugEnabled,
                },
                {
                    updateRoomSummary,
                    compressRoomHistory,
                    isGenerationActive: () =>
                        isGenerationSessionActive(session) && !controller.signal.aborted,
                    waitForMessageModeBubbleDelay,
                    addMessage,
                    rememberStreamedFinalMessageIds,
                    refreshConversationRoom,
                    clearStreamingPreview,
                    addFullJsonDebugLog,
                    getCurrentRoom,
                    markMemoriesUsed,
                    listMemoriesForCharacter,
                    addMemory,
                    attachMemoriesToMessage,
                    playTypewriter,
                },
            );
            return {
                status: 'success',
                message: appliedResult.message,
            };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return { status: session.detached ? 'detached' : 'aborted' };
            }
            logChatError('Rust conversation turn failed:', error);
            return { status: 'error', error };
        } finally {
            clearStreamingPreview(session.jobId);
            clearGenerationController(session, controller);
        }
    };

    const handleSubmit = async (
        e?: React.FormEvent,
        editDraft?: EditingMessageDraft,
        suggestedReply?: string,
        inputOverride?: string,
    ) => {
        e?.preventDefault();
        const submittedInput = suggestedReply ?? editDraft?.content ?? inputOverride ?? input;
        if (!submittedInput.trim() || !room || isLoading || isSummarizing) return;
        if (!isGroupRoom && !character) return;
        if (isGroupRoom && (!groupCharacters || groupCharacters.length === 0)) return;

        const userMessage = submittedInput.trim();
        const shouldGenerateTitleAfterFirstReply = generateTitleOnFirstReply
            && !editDraft
            && room.isDraft === true
            && !isSecretMode;
        const originalRoomName = room.name;
        const previousReplySuggestionState = replySuggestionState;
        let editCutIndex = -1;
        let editDeletedMessages: Message[] = [];
        let editDeletedMemories: MemoryRecord[] = [];

        if (editDraft) {
            const latestRoom = getCurrentRoom();
            if (latestRoom?.id !== room.id) return;
            editCutIndex = latestRoom.messages.findIndex((message) =>
                message.id === editDraft.messageId &&
                message.role === 'user' &&
                !message.archived
            );
            if (editCutIndex < 0) {
                showChatNotice('編集対象のメッセージが見つかりませんでした。');
                setEditingMessage(null);
                return;
            }
            editDeletedMessages = latestRoom.messages.slice(editCutIndex);
        }

        dismissChatNotice();
        setReplySuggestionState(null);
        if (editDraft) {
            editDeletedMemories = await deleteMessagesFrom(room.id, editCutIndex);
            setEditingMessage(null);
        } else {
            setInput('');
        }
        const session = startGenerationSession(room.id);

        const userMessageId = addMessage(room.id, 'user', userMessage);

        const roomAfterUserMessage = getCurrentRoom();
        if (!roomAfterUserMessage) {
            finishGenerationSession(session);
            return;
        }

        const rollbackSubmittedTurn = async () => {
            if (editDraft && editCutIndex >= 0) {
                const isCurrentRoomActive = await rollbackRestorableMessages(
                    {
                        roomId: room.id,
                        fromIndex: editCutIndex,
                        messages: editDeletedMessages,
                        memories: editDeletedMemories,
                    },
                    { getCurrentRoom, deleteMessagesFrom, restoreMessagesAt },
                );
                if (isCurrentRoomActive) {
                    setEditingMessage({ ...editDraft, content: submittedInput });
                }
                return;
            }

            const isCurrentRoomActive = await removeSubmittedUserMessage(
                { roomId: room.id, messageId: userMessageId },
                { getCurrentRoom, deleteMessagesFrom },
            );
            if (isCurrentRoomActive) {
                setInput(submittedInput);
                if (suggestedReply && previousReplySuggestionState?.roomId === room.id) {
                    setInput('');
                    setReplySuggestionState(previousReplySuggestionState);
                }
            }
        };

        const generationResult = await generateRustTurn(session, roomAfterUserMessage);

        if (generationResult.status === 'error' || generationResult.status === 'aborted') {
            await rollbackSubmittedTurn();
            if (!editDraft) {
                setTimeout(() => textareaRef.current?.focus(), 50);
            }

            finishGenerationSession(session);
            setIsSummarizing(false);

            if (generationResult.status === 'error' && generationResult.error && getCurrentRoom()?.id === room.id) {
                if (isRetryableGenerationError(generationResult.error)) {
                    retrySubmissionRef.current = {
                        roomId: room.id,
                        input: userMessage,
                        editDraft: editDraft ? { ...editDraft, content: submittedInput } : undefined,
                        suggestedReply,
                    };
                    showChatErrorNotice(generationResult.error, { type: 'retry', label: '再試行' });
                } else {
                    showChatErrorNotice(generationResult.error);
                }
            }
            return;
        } else if (generationResult.status === 'success' && shouldGenerateTitleAfterFirstReply) {
            void generateInitialRoomTitle(room.id, originalRoomName);
        }
        finishGenerationSession(session);
        setIsSummarizing(false);
    };

    const handleChatNoticeAction = () => {
        const action = chatNotice?.action;
        if (!action) return;

        if (action.type === 'open-settings') {
            dismissChatNotice();
            onOpenSettings?.();
            return;
        }

        if (isLoading || isSummarizing || chatNoticeActionRunningRef.current) return;
        const retry = retrySubmissionRef.current;
        if (!retry || retry.roomId !== currentRoomId) return;

        chatNoticeActionRunningRef.current = true;
        retrySubmissionRef.current = null;
        dismissChatNotice();
        void handleSubmit(undefined, retry.editDraft, retry.suggestedReply, retry.input)
            .catch((error) => {
                logChatError('Chat retry failed:', error);
                showChatNotice('再試行の準備中にエラーが発生しました。');
            })
            .finally(() => {
                chatNoticeActionRunningRef.current = false;
            });
    };

    const handleRegenerate = async () => {
        if (!room || isLoading) return;
        setReplySuggestionState(null);

        const regenerateAsGroup = isGroupRoom && groupCharacters != null;
        if (!regenerateAsGroup && !character) return;

        const cutFrom = getChatRegenerationCutIndex(room.messages, {
            allowEmptyReplyRound: regenerateAsGroup,
        });
        if (cutFrom == null) return;
        const messagesToDelete = room.messages.slice(cutFrom);

        const removedMemoryRecords = await deleteMessagesFrom(room.id, cutFrom);
        const session = startGenerationSession(room.id);
        try {
            const latestRoom = getCurrentRoom();
            const result = latestRoom
                ? await generateRustTurn(session, latestRoom)
                : { status: 'aborted' as const };
            if (result.status === 'error' || result.status === 'aborted') {
                await rollbackRestorableMessages(
                    {
                        roomId: room.id,
                        fromIndex: cutFrom,
                        messages: messagesToDelete,
                        memories: removedMemoryRecords,
                    },
                    { getCurrentRoom, deleteMessagesFrom, restoreMessagesAt },
                );
                if (result.status === 'error' && result.error && getCurrentRoom()?.id === room.id) {
                    showChatErrorNotice(result.error);
                }
            }
        } finally {
            finishGenerationSession(session);
            setIsSummarizing(false);
        }
    };

    const handleBranch = async (messageId: string) => {
        if (!room || isLoading || isSummarizing || branchingMessageId) return;
        setBranchingMessageId(messageId);
        setReplySuggestionState(null);
        try {
            await branchRoomFromMessage(room.id, messageId);
        } catch (error) {
            console.error('[branch-room]', error);
            showChatNotice(error instanceof Error ? error.message : '会話を分岐できませんでした。');
        } finally {
            setBranchingMessageId(null);
        }
    };

    const handleEditMessage = useCallback((messageId: string, _messageIndex: number, messageContent: string) => {
        if (isLoading || isSummarizing || !room) return;
        const latestRoom = getCurrentRoom();
        const latestMessage = latestRoom?.id === room.id
            ? latestRoom.messages.find((message) => message.id === messageId)
            : null;
        setEditingMessage({
            roomId: room.id,
            messageId,
            content: latestMessage?.content ?? messageContent,
        });
        setMentionQuery(null);
        setTouchedMessageId(null);
    }, [getCurrentRoom, isLoading, isSummarizing, room]);

    const handleEditMessageChange = useCallback((content: string) => {
        setEditingMessage((draft) => draft ? { ...draft, content } : draft);
    }, []);

    const handleCancelEditMessage = useCallback(() => {
        setEditingMessage(null);
    }, []);

    const handleSubmitEditMessage = () => {
        if (!editingMessage || editingMessage.roomId !== room?.id) return;
        void handleSubmit(undefined, editingMessage);
    };

    const handleReplySuggestionSelect = (suggestion: string) => {
        if (isLoading || isSummarizing || isEditingMessage || !suggestion.trim()) return;
        void handleSubmit(undefined, undefined, suggestion);
    };

    const handleCopyMessage = useCallback((messageId: string, content: string) => {
        // Clear previous copy timeout to avoid stale state
        if (copyTimeoutRef.current) {
            clearTimeout(copyTimeoutRef.current);
        }
        navigator.clipboard.writeText(content).then(() => {
            setCopiedMessageId(messageId);
            copyTimeoutRef.current = setTimeout(() => {
                setCopiedMessageId(null);
                copyTimeoutRef.current = null;
            }, 2000);
        });
    }, []);

    const handleMouseEnter = useCallback((id: string) => setHoveredMessageId(id), []);
    const handleMouseLeave = useCallback((e: React.MouseEvent) => {
        if (messagePointerDragRef.current) return;
        if (e.buttons !== 0) return;
        setHoveredMessageId(null);
    }, []);
    const handleTouchStart = useCallback((id: string) => {
        setTouchedMessageId(prev => prev === id ? null : id);
    }, []);

    const handleOpenMessageMemoryList = useCallback((characterId?: string) => {
        if (!characterId) {
            onOpenMemoryList(character);
            return;
        }
        const targetCharacter = groupCharacters?.find((c) => c.id === characterId)
            ?? (character?.id === characterId ? character : null);
        onOpenMemoryList(targetCharacter);
    }, [character, groupCharacters, onOpenMemoryList]);

    const applyMention = (character: Character) => {
        const before = input.slice(0, mentionStartIndex);
        const after = input.slice(mentionStartIndex + 1 + (mentionQuery?.length ?? 0));
        const newInput = `${before}@${character.name} ${after}`;
        setInput(newInput);
        setMentionQuery(null);
        // Restore focus and move cursor after inserted name
        setTimeout(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.focus();
            const pos = before.length + character.name.length + 2; // @name + space
            el.setSelectionRange(pos, pos);
        }, 0);
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setInput(value);
        if (!isGroupRoom) return;
        const cursorPos = e.target.selectionStart ?? value.length;
        const textBeforeCursor = value.slice(0, cursorPos);
        const match = textBeforeCursor.match(/@([\w\u3000-\u9FFF\u30A0-\u30FF\u3040-\u309F\uFF65-\uFF9F]*)$/);
        if (match) {
            setMentionQuery(match[1]);
            setMentionStartIndex(match.index!);
            setSelectedMentionIdx(0);
        } else {
            setMentionQuery(null);
        }
    };

    const handleKeyDown = useChatComposerKeyboard({
        mentionOpen: mentionQuery !== null,
        mentionCandidates,
        selectedMentionIndex: selectedMentionIdx,
        setSelectedMentionIndex: setSelectedMentionIdx,
        onApplyMention: applyMention,
        onCloseMention: () => setMentionQuery(null),
        isMobile,
        isInlineEditing: isInlineVnEditing,
        onSubmit: () => {
            void handleSubmit();
        },
        onSubmitEdit: handleSubmitEditMessage,
    });

    const latestAssistantMessage = useMemo(() => {
        for (let i = processedMessages.length - 1; i >= 0; i--) {
            const message = processedMessages[i];
            if (message.role === 'assistant' && !message.isArchived) return message;
        }
        return null;
    }, [processedMessages]);

    const latestResolvedAssistantEmotion = useMemo(() => {
        for (let i = processedMessages.length - 1; i >= 0; i--) {
            const message = processedMessages[i];
            if (message.role !== 'assistant' || message.isArchived || !message.emotion) continue;
            return message.emotion;
        }
        return null;
    }, [processedMessages]);

    const latestEditableUserMessage = useMemo(() => {
        if (!room) return null;
        for (let i = room.messages.length - 1; i >= 0; i--) {
            const message = room.messages[i];
            if (message.role === 'user' && !message.archived) return message;
        }
        return null;
    }, [room]);

    const vnCharacter = useMemo(() => {
        if (latestAssistantMessage?.characterId && characterMap) {
            return characterMap.get(latestAssistantMessage.characterId) ?? character;
        }
        return character;
    }, [latestAssistantMessage, characterMap, character]);

    const vnSelectedCostumeName = useMemo(
        () => resolveSelectedCostumeName(room, vnCharacter),
        [room, vnCharacter],
    );
    const vnCostumeOptions = useMemo(() => {
        if (!vnCharacter) return [];
        const defaultImage = findDefaultCostume(vnCharacter)?.image
            ?? resolveExpressionImage(vnCharacter, null, DEFAULT_COSTUME_NAME);
        return [
            { name: DEFAULT_COSTUME_NAME, image: defaultImage, expressionCount: vnCharacter.expressions?.length ?? 0 },
            ...(vnCharacter.costumes ?? [])
                .filter((costume) => costume.name.toLowerCase() !== DEFAULT_COSTUME_NAME)
                .map((costume) => ({
                    name: costume.name,
                    image: costume.image,
                    expressionCount: costume.expressions?.length ?? 0,
                })),
        ];
    }, [vnCharacter]);

    const vnExpressionImage = useMemo(
        () => resolveExpressionImage(
            vnCharacter,
            activeStreamingPreview?.expression ?? latestAssistantMessage?.emotion ?? latestResolvedAssistantEmotion,
            vnSelectedCostumeName,
        ),
        [activeStreamingPreview?.expression, vnCharacter, latestAssistantMessage, latestResolvedAssistantEmotion, vnSelectedCostumeName],
    );
    const latestAssistantMessageId = latestAssistantMessage?.id;
    const latestAssistantEmotion = latestAssistantMessage?.emotion;
    const latestAssistantHasText = !!latestAssistantMessage?.displayContent.trim();

    useEffect(() => {
        if (!isVisualNovelMode || !latestAssistantMessageId || !latestAssistantHasText) return;
        triggerVnBounce();
    }, [isVisualNovelMode, latestAssistantMessageId, latestAssistantEmotion, latestAssistantHasText, triggerVnBounce]);

    const lastRoomMessage = room ? room.messages[room.messages.length - 1] : undefined;
    const isWaitingForAssistant = isLoading
        && lastRoomMessage?.role !== 'assistant'
        && !activeStreamingPreview;
    const isTypingLatestMessage = latestAssistantMessage?.id === typingMessageId;
    const vnDialogueContent = activeStreamingPreview?.content
        ?? (isTypingLatestMessage
            ? typedContent
            : latestAssistantMessage?.displayContent || (isWaitingForAssistant ? '...' : '...（話しかけてみましょう）'));
    const vnProcessedDialogueContent = useMemo(() => formatAssistantMarkdown(vnDialogueContent), [vnDialogueContent]);
    const canRegenerateVN = !!latestAssistantMessage && lastRoomMessage?.id === latestAssistantMessage.id && !isLoading && !isInlineVnEditing;
    const canEditLatestUserMessageInVn = !!latestEditableUserMessage && !isLoading && !isSummarizing && !isInlineVnEditing;

    const handleEditLatestUserMessageInVn = useCallback(() => {
        if (!room || !latestEditableUserMessage || isLoading || isSummarizing) return;
        setEditingMessage({
            roomId: room.id,
            messageId: latestEditableUserMessage.id,
            content: latestEditableUserMessage.content,
        });
        setMentionQuery(null);
        setTouchedMessageId(null);
        setTimeout(() => textareaRef.current?.focus(), 0);
    }, [isLoading, isSummarizing, latestEditableUserMessage, room]);

    const handleSelectVnCostume = (costumeName: string) => {
        if (!room || !vnCharacter) return;
        const nextSelections = { ...(room.costumeSelections ?? {}) };
        if (costumeName === DEFAULT_COSTUME_NAME) {
            delete nextSelections[vnCharacter.id];
        } else {
            nextSelections[vnCharacter.id] = costumeName;
        }
        updateRoomSettings(room.id, {
            costumeSelections: Object.keys(nextSelections).length > 0 ? nextSelections : undefined,
        });
        setVnCostumeMenuOpen(false);
    };

    const handleToggleSecretMode = () => {
        if (!room || !isRoomEmpty || isLoading || isSummarizing) return;
        setRoomSecretMode(room.id, !isSecretMode);
    };

    useEffect(() => {
        if (!isVisualNovelMode) return;
        const dialogueBody = vnDialogueBodyRef.current;
        if (!dialogueBody) return;

        const frameId = requestAnimationFrame(() => {
            dialogueBody.scrollTop = dialogueBody.scrollHeight;
        });
        return () => cancelAnimationFrame(frameId);
    }, [isVisualNovelMode, vnDialogueContent]);

    useTypewriterAdvance({
        activeRef: vnTypewriterRef,
        onAdvance: () => stopTypewriter(true),
    });

    const handleClearActiveDebugLogs = () => {
        clearFullJsonDebugLogs();
    };

    const chatInputValue = isInlineVnEditing ? editingMessage?.content ?? '' : input;
    const chatInputPlaceholder = isInlineVnEditing
        ? '直前の入力を編集中'
        : isEditingMessage
            ? '編集中のメッセージで送信してください'
            : '返信を入力';
    const chatInputDisabled = isLoading || isSummarizing || (isEditingMessage && !isInlineVnEditing);
    const chatInputSubmitDisabled = isInlineVnEditing
        ? !editingMessage?.content.trim()
        : !input.trim() || isEditingMessage;
    const showReplySuggestions = replySuggestionsEnabled
        && replySuggestionState != null
        && replySuggestionState.roomId === room?.id
        && !isEditingMessage
        && !input.trim()
        && (replySuggestionState.loading || replySuggestionState.suggestions.length === 3);
    const handleChatInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (isInlineVnEditing) {
            handleEditMessageChange(e.target.value);
        } else {
            handleInputChange(e);
        }
    };
    const handleChatInputSubmit = (e: React.FormEvent) => {
        if (isInlineVnEditing) {
            e.preventDefault();
            handleSubmitEditMessage();
            return;
        }
        void handleSubmit(e);
    };

    if (!room) {
        return (
            <div className="chat-container">
                <div className="chat-header mobile-only">
                    {isMobile && (
                        <button type="button" className="btn btn-ghost mobile-sidebar-trigger" onClick={onOpenSidebar} title="サイドバーを開く" aria-label="サイドバーを開く">
                            <Menu size={20} />
                        </button>
                    )}
                    <span style={{ fontWeight: 500 }}>Kataru</span>
                    <div style={{ width: 36 }} />
                </div>
                <div className="empty-state">
                    <Sparkles size={64} className="empty-state-icon" />
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                        Kataruで会話をはじめましょう
                    </h2>
                    <p className="empty-state-description" style={{ marginBottom: '1rem' }}>
                        まずは、話す相手を作ります。
                    </p>
                    <button type="button" className="btn btn-primary" onClick={onCreateCharacter}>
                        話す相手を作る
                    </button>
                </div>
            </div>
        );
    }

    const displayedRoomName = room.isDraft ? '' : room.name;
    const replySuggestions = showReplySuggestions && replySuggestionState && (
        <div
            className={`reply-suggestions${isVisualNovelMode ? ' vn-reply-suggestions' : ''}`}
            aria-label="主人公の返答候補"
        >
            {replySuggestionState.loading && (
                <div className="reply-suggestions-heading">
                    <Sparkles size={14} aria-hidden="true" />
                    <span>返答を考えています…</span>
                </div>
            )}
            {!replySuggestionState.loading && (
                <div className="reply-suggestions-list">
                    {replySuggestionState.suggestions.map((suggestion, index) => (
                        <button
                            key={`${index}:${suggestion}`}
                            type="button"
                            className="reply-suggestion-button"
                            onClick={() => handleReplySuggestionSelect(suggestion)}
                            disabled={chatInputDisabled}
                            title={`${suggestion}（選択して送信）`}
                        >
                            <span className="reply-suggestion-text">{suggestion}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    return (
        <div className={`chat-container ${isVisualNovelMode ? 'vn-mode' : ''} ${isMessageMode ? 'message-mode' : ''}`}>
            <div className="chat-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
                    {isMobile && (
                        <button type="button" className="btn btn-ghost mobile-sidebar-trigger" onClick={onOpenSidebar} style={{ padding: '0.5rem', flexShrink: 0 }} title="サイドバーを開く" aria-label="サイドバーを開く">
                            <Menu size={20} />
                        </button>
                    )}
                    <div style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
                        <h2 style={{ fontSize: '1rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayedRoomName}</h2>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {isGroupRoom && groupCharacters
                                ? `${groupName ?? 'シチュエーション'}`
                                : `${character?.name}`}
                        </p>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
                    {debugPanelEnabled && (
                        <button type="button" className="btn btn-ghost" onClick={() => setDebugLogOpen(true)} title="デバッグログを表示">
                            <Bug size={18} />
                            <span className="desktop-only" style={{ fontSize: '0.75rem' }}>
                                {visibleDebugLogCount}
                            </span>
                        </button>
                    )}
                    {showHeaderMemoryButton && (
                        <button type="button" className="btn btn-ghost" onClick={() => onOpenMemoryList(character)} title="メモリを表示">
                            <Brain size={18} />
                        </button>
                    )}
                    {(character || isGroupRoom) && (isRoomEmpty || isSecretMode) && (
                        <button
                            type="button"
                            className={`btn btn-ghost secret-mode-button ${isSecretMode ? 'active' : ''}`}
                            onClick={handleToggleSecretMode}
                            disabled={isLoading || isSummarizing}
                            aria-pressed={isSecretMode}
                            title={
                                isSecretMode
                                    ? (isRoomEmpty ? 'シークレットモードを解除' : 'シークレットモードで会話中です。会話履歴とメモリには保存されません')
                                    : 'シークレットモードでチャットを開始'
                            }
                            aria-label={
                                isSecretMode
                                    ? (isRoomEmpty ? 'シークレットモードを解除' : 'シークレットモードで会話中')
                                    : 'シークレットモードでチャットを開始'
                            }
                        >
                            <HatGlasses size={18} />
                        </button>
                    )}
                    {!isGroupRoom && character && !isRoomEmpty && (
                        <button
                            type="button"
                            className="btn btn-ghost mobile-only"
                            onClick={() => createRoom(character.id, undefined, { viewMode: currentRoomViewMode })}
                            disabled={isLoading || isSummarizing}
                            title={`${currentRoomViewModeLabel}モードで新しいチャットを開始`}
                        >
                            <SquarePen size={18} />
                        </button>
                    )}
                    {isGroupRoom && room.groupId && !isRoomEmpty && (
                        <button
                            type="button"
                            className="btn btn-ghost mobile-only"
                            onClick={() => createRoomForSituation(room.groupId!, undefined, { viewMode: currentRoomViewMode })}
                            disabled={isLoading || isSummarizing}
                            title={`${groupName ?? 'シチュエーション'}の新しいチャットを開始`}
                        >
                            <SquarePen size={18} />
                        </button>
                    )}
                    {(character || isGroupRoom) && (
                        <div ref={chatModeMenuRef} className="chat-mode-selector">
                            <button
                                type="button"
                                className="btn btn-ghost chat-mode-trigger"
                                onClick={() => setChatModeMenuOpen((v) => !v)}
                                disabled={isLoading || isSummarizing}
                                title={`表示モード: ${currentRoomViewModeLabel}`}
                                aria-haspopup="menu"
                                aria-expanded={chatModeMenuOpen}
                                style={{ color: currentRoomViewMode !== 'chat' ? 'var(--accent-primary)' : undefined }}
                            >
                                {renderRoomViewModeIcon(currentRoomViewMode)}
                                <span className="desktop-only">{currentRoomViewModeLabel}</span>
                                <ChevronDown size={14} />
                            </button>
                            {chatModeMenuOpen && (
                                <div className="chat-mode-menu" role="menu" aria-label="表示モード">
                                    {availableChatModeOptions.map((option) => {
                                        const active = option.value === currentRoomViewMode;
                                        return (
                                            <button
                                                key={option.value}
                                                type="button"
                                                role="menuitemradio"
                                                aria-checked={active}
                                                className={`chat-mode-menu-item ${active ? 'active' : ''}`}
                                                onClick={() => {
                                                    updateRoomSettings(room.id, { viewMode: option.value });
                                                    setChatModeMenuOpen(false);
                                                }}
                                            >
                                                {renderRoomViewModeIcon(option.value, 16)}
                                                <span className="chat-mode-menu-copy">
                                                    <span className="chat-mode-menu-label">{option.label}</span>
                                                    <span className="chat-mode-menu-description">{option.description}</span>
                                                </span>
                                                {active && <Check size={14} className="chat-mode-menu-check" />}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {isVisualNovelMode ? (
                <div className={`vn-stage${showReplySuggestions ? ' has-reply-suggestions' : ''}`}>
                    <div className="vn-scene">
                        <div className={`vn-character-wrap ${vnBounceActive ? 'vn-character-bounce' : ''}`}>
                            {vnExpressionImage ? (
                                <StoredImage
                                    src={vnExpressionImage}
                                    alt={vnCharacter?.name ?? 'character'}
                                    className="vn-character-image"
                                    onLoad={isVisualNovelMode ? triggerVnBounce : undefined}
                                />
                            ) : (
                                <div className="vn-character-placeholder">
                                    {vnCharacter?.icon ? (
                                        <StoredImage src={vnCharacter.icon} alt={vnCharacter.name} />
                                    ) : (
                                        <span>{vnCharacter?.name?.charAt(0) ?? '?'}</span>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {isVisualNovelMode && replySuggestions}
                    <div className="vn-dialogue">
                        <div className="vn-dialogue-topline">
                            <div className="vn-speaker">
                                {vnCharacter?.name ?? character?.name ?? 'Character'}
                            </div>
                            <div className="vn-actions">
                                {isSummarizing && (
                                    <div className="vn-status" title="古い会話を要約中">
                                        <div className="spinner" />
                                    </div>
                                )}
                                {vnCharacter && (
                                    <div ref={vnCostumeMenuRef} style={{ position: 'relative' }}>
                                        <button
                                            type="button"
                                            className="btn btn-ghost"
                                            onClick={() => setVnCostumeMenuOpen((v) => !v)}
                                            title={`衣装変更: ${vnSelectedCostumeName}`}
                                            style={{ color: vnSelectedCostumeName !== DEFAULT_COSTUME_NAME ? 'var(--accent-primary)' : undefined }}
                                        >
                                            <Shirt size={15} />
                                        </button>
                                        {vnCostumeMenuOpen && (
                                            <div
                                                role="menu"
                                                style={{
                                                    position: 'absolute',
                                                    right: 0,
                                                    bottom: 'calc(100% + 0.5rem)',
                                                    width: 240,
                                                    maxHeight: 320,
                                                    overflowY: 'auto',
                                                    padding: 6,
                                                    border: '1px solid var(--border-color)',
                                                    borderRadius: 8,
                                                    background: 'var(--bg-primary)',
                                                    boxShadow: '0 12px 28px rgba(0,0,0,0.28)',
                                                    zIndex: 20,
                                                }}
                                            >
                                                {vnCostumeOptions.map((option) => {
                                                    const active = option.name === vnSelectedCostumeName;
                                                    return (
                                                        <button
                                                            key={option.name}
                                                            type="button"
                                                            role="menuitem"
                                                            onClick={() => handleSelectVnCostume(option.name)}
                                                            style={{
                                                                width: '100%',
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                gap: 8,
                                                                padding: '6px 8px',
                                                                border: 'none',
                                                                borderRadius: 6,
                                                                background: active ? 'var(--bg-tertiary)' : 'transparent',
                                                                color: 'var(--text-primary)',
                                                                cursor: 'pointer',
                                                                textAlign: 'left',
                                                            }}
                                                        >
                                                            <span style={{
                                                                width: 30,
                                                                height: 42,
                                                                flexShrink: 0,
                                                                overflow: 'hidden',
                                                                borderRadius: 4,
                                                                border: '1px solid var(--border-color)',
                                                                background: 'var(--bg-secondary)',
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                            }}>
                                                                {option.image ? (
                                                                    <StoredImage src={option.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                                ) : (
                                                                    <Shirt size={14} style={{ color: 'var(--text-muted)' }} />
                                                                )}
                                                            </span>
                                                            <span style={{ minWidth: 0, flex: 1 }}>
                                                                <span style={{ display: 'block', fontSize: '0.8125rem', fontWeight: active ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                    {option.name}
                                                                </span>
                                                                <span style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                                                    表情 {option.expressionCount}件
                                                                </span>
                                                            </span>
                                                            {active && <Check size={14} style={{ flexShrink: 0, color: 'var(--accent-primary)' }} />}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={handleEditLatestUserMessageInVn}
                                    disabled={!canEditLatestUserMessageInVn}
                                    title="直前の入力を編集"
                                >
                                    <Undo2 size={15} />
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={() => latestAssistantMessage && handleCopyMessage(latestAssistantMessage.id, latestAssistantMessage.displayContent)}
                                    disabled={!latestAssistantMessage}
                                    title="コピー"
                                >
                                    {latestAssistantMessage && copiedMessageId === latestAssistantMessage.id ? <Check size={15} /> : <Copy size={15} />}
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={handleRegenerate}
                                    disabled={!canRegenerateVN}
                                    title="回答を再生成"
                                >
                                    <RefreshCw size={15} />
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={() => latestAssistantMessage && handleBranch(latestAssistantMessage.id)}
                                    disabled={!latestAssistantMessage || isLoading || isSummarizing || !!branchingMessageId || isSecretMode}
                                    title="ここから会話を分岐"
                                >
                                    <GitBranch size={15} />
                                </button>
                            </div>
                        </div>
                        <div className="vn-dialogue-rule" aria-hidden="true" />
                        <div
                            ref={vnDialogueBodyRef}
                            className="vn-dialogue-body"
                            onClick={isTypewriterActive ? () => stopTypewriter(true) : undefined}
                            title={isTypewriterActive ? '全文表示' : undefined}
                            style={{ cursor: isTypewriterActive ? 'pointer' : undefined }}
                        >
                            {isWaitingForAssistant ? (
                                <WaitingEllipsis className="vn-waiting-ellipsis" />
                            ) : formattedStreamingPreviewMessages.length > 0 ? (
                                <ReactMarkdown>{vnProcessedDialogueContent}</ReactMarkdown>
                            ) : activeStreamingPreview ? (
                                <div
                                    className="vn-streaming-preview"
                                    role="status"
                                    aria-live="polite"
                                    style={{ whiteSpace: 'pre-wrap' }}
                                >
                                    {activeStreamingPreview.content}
                                </div>
                            ) : (
                                <ReactMarkdown>{vnProcessedDialogueContent}</ReactMarkdown>
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="chat-messages">
                    {priorMessagesForDisplay.length === 0 && processedMessages.length === 0 ? (
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
                            {priorMessagesForDisplay.map(({ message, character: priorCharacter, isAssistantContinuation }, index) => (
                                <SituationPriorMessageBubble
                                    key={`prior-display:${message.id}`}
                                    message={message}
                                    index={index}
                                    character={priorCharacter}
                                    isAssistantContinuation={isAssistantContinuation}
                                    formatAssistantActions={!isMessageMode}
                                />
                            ))}
                            {processedMessages.map((message, index) => (
                                <MessageBubble
                                    key={message.id}
                                    messageId={message.id}
                                    role={message.role}
                                    content={message.content}
                                    displayContent={message.displayContent}
                                    index={index}
                                    isArchived={message.isArchived}
                                    isLastMessage={index === processedMessages.length - 1}
                                    isLoading={isLoading || isSummarizing || !!branchingMessageId}
                                    isHovered={hoveredMessageId === message.id || touchedMessageId === message.id}
                                    isCopied={copiedMessageId === message.id}
                                    disableEntranceAnimation={streamedFinalMessageIds.has(message.id)}
                                    isTypewriterActive={isTypewriterActive && message.id === typingMessageId}
                                    formatAssistantActions={!isMessageMode}
                                    isAssistantContinuation={message.isAssistantContinuation}
                                    showAssistantActions={message.showAssistantActions}
                                    showBranchAction={message.showBranchAction}
                                    showMemoryIndicator={message.showMemoryIndicator}
                                    showArchiveDivider={message.showArchiveDivider}
                                    memoryCharacterId={message.characterId}
                                    characterIcon={message.msgCharacterIcon}
                                    characterName={message.msgCharacterName}
                                    isGroupRoom={isGroupRoom}
                                    onMouseEnter={handleMouseEnter}
                                    onMouseLeave={handleMouseLeave}
                                    onTouchStart={handleTouchStart}
                                    onEdit={handleEditMessage}
                                    isEditing={editingMessage?.roomId === room.id && editingMessage.messageId === message.id}
                                    editContent={editingMessage?.roomId === room.id && editingMessage.messageId === message.id ? editingMessage.content : ''}
                                    onEditChange={handleEditMessageChange}
                                    onCancelEdit={handleCancelEditMessage}
                                    onSubmitEdit={handleSubmitEditMessage}
                                    onCopy={handleCopyMessage}
                                    onRegenerate={handleRegenerate}
                                    onBranch={() => handleBranch(message.id)}
                                    onOpenMemoryList={handleOpenMessageMemoryList}
                                    onRevealTypewriter={() => stopTypewriter(true)}
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
                                    index={processedMessages.length + index}
                                    isArchived={false}
                                    isLastMessage={index === formattedStreamingPreviewMessages.length - 1}
                                    isLoading={true}
                                    isHovered={false}
                                    isCopied={false}
                                    formatAssistantActions={!isMessageMode}
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
                            <div style={{ flexShrink: 0, width: '2rem', height: '2rem', borderRadius: '50%', overflow: 'hidden', marginTop: '0.25rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                                {streamingPreviewCharacter?.icon ? (
                                    <StoredImage
                                        src={streamingPreviewCharacter.icon}
                                        alt={activeStreamingPreview.characterName ?? streamingPreviewCharacter.name}
                                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                    />
                                ) : (
                                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                                        {(activeStreamingPreview.characterName ?? streamingPreviewCharacter?.name ?? '?').charAt(0)}
                                    </div>
                                )}
                            </div>
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
                    {isLoading && !activeStreamingPreview && room.messages[room.messages.length - 1]?.role !== 'assistant' && (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                            <div style={{ flexShrink: 0, width: '2rem', height: '2rem', borderRadius: '50%', overflow: 'hidden', marginTop: '0.25rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                                {!isGroupRoom && character?.icon ? (
                                    <StoredImage src={character.icon} alt={character.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                ) : (
                                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                                        {!isGroupRoom && character?.name ? character.name.charAt(0) : '?'}
                                    </div>
                                )}
                            </div>
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
            )}

            <div className="chat-input-area" style={{ position: 'relative' }}>
                {chatNotice && (
                    <ChatNoticeBanner
                        key={chatNotice.id}
                        notice={chatNotice}
                        retryDisabled={isLoading || isSummarizing}
                        onAction={handleChatNoticeAction}
                        onDismiss={dismissChatNotice}
                        onInteractionStart={handleChatNoticeMouseEnter}
                        onInteractionEnd={handleChatNoticeMouseLeave}
                    />
                )}
                {!isVisualNovelMode && replySuggestions}
                {mentionQuery !== null && mentionCandidates.length > 0 && (
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
                        {mentionCandidates.map((c, i) => (
                            <button
                                key={c.id}
                                type="button"
                                onMouseDown={(e) => { e.preventDefault(); applyMention(c); }}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    width: '100%',
                                    padding: '0.5rem 0.75rem',
                                    background: i === selectedMentionIdx ? 'var(--bg-hover)' : 'transparent',
                                    border: 'none',
                                    cursor: 'pointer',
                                    textAlign: 'left',
                                    color: 'var(--text-primary)',
                                    fontSize: '0.875rem',
                                }}
                                onMouseEnter={() => setSelectedMentionIdx(i)}
                            >
                                <div style={{ flexShrink: 0, width: '1.5rem', height: '1.5rem', borderRadius: '50%', overflow: 'hidden', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                                    {c.icon
                                        ? <StoredImage src={c.icon} alt={c.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                        : c.name.charAt(0)
                                    }
                                </div>
                                <span>{c.name}</span>
                            </button>
                        ))}
                    </div>
                )}
                <form onSubmit={handleChatInputSubmit} className={`chat-input-wrapper ${isInlineVnEditing ? 'editing' : ''}`}>
                    <textarea
                        ref={textareaRef}
                        className="input chat-input"
                        value={chatInputValue}
                        onChange={handleChatInputChange}
                        onKeyDown={handleKeyDown}
                        placeholder={chatInputPlaceholder}
                        disabled={chatInputDisabled}
                        rows={1}
                    />
                    {isLoading || isSummarizing ? (
                        <button
                            type="button"
                            className="btn btn-primary chat-input-send"
                            onClick={handleStop}
                            style={isTypewriterActive ? undefined : { backgroundColor: '#ef4444' }}
                            title={isTypewriterActive ? '全文表示' : '生成を中断'}
                        >
                            {isTypewriterActive ? <ChevronsDown size={16} /> : <Square size={16} fill="currentColor" />}
                        </button>
                    ) : (
                        <>
                            {isInlineVnEditing && (
                                <button
                                    type="button"
                                    className="btn btn-ghost chat-input-cancel"
                                    onClick={handleCancelEditMessage}
                                    title="編集をキャンセル"
                                    aria-label="編集をキャンセル"
                                >
                                    <X size={15} />
                                </button>
                            )}
                            <button
                                type="submit"
                                className="btn btn-primary chat-input-send"
                                disabled={chatInputSubmitDisabled}
                                title={isInlineVnEditing ? '編集して送信' : '送信'}
                            >
                                <ArrowUp size={16} />
                            </button>
                        </>
                    )}
                </form>
            </div>
            {debugLogOpen && debugPanelEnabled && (
                <div
                    className="modal-overlay"
                    onPointerDown={(e) => {
                        if (e.target === e.currentTarget) setDebugLogOpen(false);
                    }}
                >
                    <div
                        className="modal-content settings-form-modal"
                        onClick={(e) => e.stopPropagation()}
                        style={{ maxWidth: 820 }}
                        role="dialog"
                        aria-modal="true"
                        aria-label="デバッグログ"
                    >
                        <div className="settings-form-modal-actions">
                            <button
                                className="btn btn-ghost"
                                onClick={() => setDebugLogOpen(false)}
                                aria-label="閉じる"
                                title="閉じる"
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            {fullJsonDebugLogs.length === 0 ? (
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                                    まだJSONログはありません。
                                </p>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                        {fullJsonDebugLogs.map((log) => (
                                            <div
                                                key={log.id}
                                                style={{
                                                    padding: '0.875rem',
                                                    borderRadius: '0.5rem',
                                                    border: '1px solid var(--border-color)',
                                                    background: 'var(--bg-secondary)',
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.5rem' }}>
                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                                                            <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                {log.characterName}
                                                            </div>
                                                            <span style={{
                                                                flexShrink: 0,
                                                                fontSize: '0.6875rem',
                                                                fontWeight: 600,
                                                                color: log.status === 'error' ? 'var(--error)' : 'var(--success)',
                                                                border: `1px solid ${log.status === 'error' ? 'var(--error)' : 'var(--success)'}`,
                                                                borderRadius: '999px',
                                                                padding: '0.125rem 0.375rem',
                                                            }}>
                                                                {log.status === 'error' ? 'エラー' : '成功'}
                                                            </span>
                                                        </div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '0.125rem' }}>
                                                            {log.roomName} / {getFullJsonDebugSourceLabel(log.source)}
                                                            {log.httpStatus ? ` / HTTP ${log.httpStatus}` : ''}
                                                            {log.elapsedMs != null ? ` / ${log.elapsedMs}ms` : ''}
                                                        </div>
                                                    </div>
                                                    <time style={{ flexShrink: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                        {new Date(log.createdAt).toLocaleString()}
                                                    </time>
                                                </div>
                                                {log.prompt && (
                                                    <div style={{ marginBottom: '0.75rem' }}>
                                                        <div style={{ marginBottom: '0.375rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                                                            プロンプト
                                                        </div>
                                                        <pre style={{
                                                            margin: 0,
                                                            maxHeight: '420px',
                                                            overflow: 'auto',
                                                            whiteSpace: 'pre-wrap',
                                                            wordBreak: 'break-word',
                                                            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                                                            fontSize: '0.8125rem',
                                                            lineHeight: 1.55,
                                                            color: 'var(--text-secondary)',
                                                        }}>{log.prompt}</pre>
                                                    </div>
                                                )}
                                                <div style={{ marginBottom: '0.375rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                                                    出力
                                                </div>
                                                <pre style={{
                                                    margin: 0,
                                                    maxHeight: '420px',
                                                    overflow: 'auto',
                                                    whiteSpace: 'pre-wrap',
                                                    wordBreak: 'break-word',
                                                    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                                                    fontSize: '0.8125rem',
                                                    lineHeight: 1.55,
                                                    color: 'var(--text-secondary)',
                                                }}>{log.json}</pre>
                                            </div>
                                        ))}
                                </div>
                            )}
                        </div>
                        {fullJsonDebugLogs.length > 0 && (
                            <div className="modal-footer">
                                <button className="btn btn-secondary" onClick={handleClearActiveDebugLogs}>
                                    <Trash2 size={15} />
                                    ログを消去
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
