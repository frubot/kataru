import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import {
    useStore,
    Room,
    Character,
    Message,
    Situation,
    SituationParticipant,
} from '@/lib/store';
import type { MemoryRecord, SituationPriorMessage } from '@/lib/store';
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
import {
    buildChatCharacterMap,
    buildChatMessagePresentations,
    buildPriorMessagePresentations,
    resolveChatStreamingPresentation,
} from '@/lib/chatMessagePresentation';
import type { ChatStreamingPreview } from '@/lib/chatMessagePresentation';
import {
    cancelConversationJob,
    getConversationJob,
    listConversationJobs,
    submitConversationJob,
} from '@/lib/conversationJobClient';
import type { ConversationJobStatus } from '@/lib/conversationJobClient';
import type { RustTurnResponse } from '@/lib/conversationResult';
import { formatAssistantMarkdown } from '@/lib/markdownUtils';
import { resolveSituationVisualNovelInitialCharacterId } from '@/lib/situationVisualNovelPresentation';
import {
    DEFAULT_COSTUME_NAME,
    getVisualNovelCostumeOptions,
    resolveVisualNovelCostumeName,
    resolveVisualNovelExpressionImage,
} from '@/lib/visualNovelPresentation';
import ChatComposer from './chat/ChatComposer';
import ChatHeader from './chat/ChatHeader';
import ChatMessagesView from './chat/ChatMessagesView';
import ChatWelcome from './chat/ChatWelcome';
import DebugLogModal from './chat/DebugLogModal';
import DeveloperInspectorsModal from './chat/DeveloperInspectorsModal';
import ReplySuggestions from './chat/ReplySuggestions';
import { applyConversationResult, recordConversationDebugLogs } from './chat/applyConversationResult';
import { useChatGenerationSessions } from './chat/useChatGenerationSessions';
import type { ChatGenerationSession } from './chat/useChatGenerationSessions';
import { useChatMentions } from './chat/useChatMentions';
import { useChatNotice } from './chat/useChatNotice';
import type { ChatNoticeAction } from './chat/useChatNotice';
import { useReplySuggestions } from './chat/useReplySuggestions';
import { useRoomTitleGeneration } from './chat/useRoomTitleGeneration';
import { useVisualNovelPresentation } from './chat/useVisualNovelPresentation';
import { useSituationVisualNovelPresentation } from './chat/useSituationVisualNovelPresentation';
import VisualNovelLogView from './chat/VisualNovelLogView';
import VisualNovelView from './chat/VisualNovelView';
import StoredImage from './StoredImage';

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

const MESSAGE_MODE_BUBBLE_DELAY_MS = 420;
const CONVERSATION_JOB_POLL_INTERVAL_MS = 750;
const CONVERSATION_STREAMING_POLL_INTERVAL_MS = 120;
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_SITUATION_PRIOR_MESSAGES: SituationPriorMessage[] = [];

type RoomViewMode = NonNullable<Room['viewMode']>;
type EditingMessageDraft = {
    roomId: string;
    messageId: string;
    content: string;
};
type ConversationCharacter = {
    id: string;
    name: string;
    systemPrompt: string;
    speechStyle?: string;
    protagonistPrompt?: string;
    userConstraints?: string;
    model: string;
    maxCharacters?: number;
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
        maxCharacters: character.maxCharacters,
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

function resolveRoomViewMode(room: Room | null | undefined): RoomViewMode {
    if (room?.viewMode === 'message' || room?.viewMode === 'vn') return room.viewMode;
    return 'chat';
}

function waitForMessageModeBubbleDelay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, MESSAGE_MODE_BUBBLE_DELAY_MS));
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
        memoryInspectorEnabled,
        summaryInspectorEnabled,
        fullJsonDebugLogs,
        addFullJsonDebugLog,
        clearFullJsonDebugLogs,
        listMemoriesForCharacter,
        markMemoriesUsed,
        getAiApiConfig,
    } = useStore();
    const isGroupRoom = situation != null || (groupCharacters != null && groupCharacters.length > 1);
    const rawRoomViewMode = resolveRoomViewMode(room);
    const currentRoomViewMode = rawRoomViewMode;
    const isMessageMode = currentRoomViewMode === 'message';
    const isVisualNovelMode = currentRoomViewMode === 'vn';
    const isSituationVisualNovelMode = isVisualNovelMode && isGroupRoom;
    const situationPriorMessages = situation?.priorMessages ?? EMPTY_SITUATION_PRIOR_MESSAGES;
    const isRoomEmpty = (room?.messages.length ?? 0) === 0;
    const isSecretMode = room?.secretMode === true;
    const showHeaderMemoryButton = !isSecretMode && !isGroupRoom && character != null && character.enableMemory !== false;
    const [input, setInput] = useState('');
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
    const [touchedMessageId, setTouchedMessageId] = useState<string | null>(null);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const [branchingMessageId, setBranchingMessageId] = useState<string | null>(null);
    const [editingMessage, setEditingMessage] = useState<EditingMessageDraft | null>(null);
    const [debugLogOpen, setDebugLogOpen] = useState(false);
    const [developerInspectorOpen, setDeveloperInspectorOpen] = useState(false);
    const [vnLogOpen, setVnLogOpen] = useState(false);
    const [streamingPreview, setStreamingPreview] = useState<ChatStreamingPreview | null>(null);
    const [streamedFinalMessageIds, setStreamedFinalMessageIds] = useState<Set<string>>(() => new Set());
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const resumedJobsRef = useRef<Set<string>>(new Set());
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retrySubmissionRef = useRef<ChatRetryRequest | null>(null);
    const chatNoticeActionRunningRef = useRef(false);
    const messagePointerDragRef = useRef(false);
    const {
        bounceActive: vnBounceActive,
        typingMessageId,
        typedContent,
        isTypewriterActive,
        typingSpeedRef: vnTypingSpeedRef,
        triggerBounce: triggerVnBounce,
        stopTypewriter,
        playTypewriter,
    } = useVisualNovelPresentation({ typingSpeed: vnTypingSpeed });
    const openVisualNovelLog = useCallback(() => {
        stopTypewriter(true);
        setVnLogOpen(true);
    }, [stopTypewriter]);
    const closeVisualNovelLog = useCallback(() => {
        setVnLogOpen(false);
    }, []);
    const clearStreamingPreview = useCallback((jobId: string) => {
        setStreamingPreview((current) => current?.jobId === jobId ? null : current);
    }, []);
    const {
        query: mentionQuery,
        candidates: mentionCandidates,
        selectedIndex: selectedMentionIdx,
        setSelectedIndex: setSelectedMentionIdx,
        apply: applyMention,
        close: closeMention,
        handleInputChange,
    } = useChatMentions({
        enabled: isGroupRoom,
        candidates: groupCharacters,
        input,
        setInput,
        inputRef: textareaRef,
    });
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
    const isVisualNovelLogOpen = isVisualNovelMode && vnLogOpen;
    const situationVnPresentation = useSituationVisualNovelPresentation({
        active: isVisualNovelMode,
        roomId: room?.id,
        situationId: situation?.id,
        messages: room?.messages ?? EMPTY_MESSAGES,
        priorMessages: situationPriorMessages,
        streamingPreview: isSituationVisualNovelMode ? streamingPreview : null,
        isLoading,
        isTypewriterActive,
        playTypewriter,
        stopTypewriter,
        onStreamingPreviewConsumed: clearStreamingPreview,
    });
    useEffect(() => {
        if (!streamingPreview) return;
        if (streamingPreview.roomId !== currentRoomId) {
            clearStreamingPreview(streamingPreview.jobId);
            return;
        }
        if (
            !isLoading
            && !isSituationVisualNovelMode
            && (streamingPreview.turns?.length ?? 0) > 0
        ) {
            clearStreamingPreview(streamingPreview.jobId);
        }
    }, [
        clearStreamingPreview,
        currentRoomId,
        isLoading,
        isSituationVisualNovelMode,
        streamingPreview,
    ]);
    const isEditingMessage = editingMessage?.roomId === currentRoomId;
    const isInlineVnEditing = isVisualNovelMode && isEditingMessage;
    const debugPanelEnabled = fullJsonDebugEnabled;
    const developerInspectorEnabled = memoryInspectorEnabled || summaryInspectorEnabled;
    const visibleDebugLogCount = fullJsonDebugLogs.length;
    const {
        state: replySuggestionState,
        setState: setReplySuggestionState,
    } = useReplySuggestions({
        room,
        character,
        groupCharacters,
        isGroupRoom,
        enabled: replySuggestionsEnabled,
        model: replySuggestionModel,
        situationPrompt: situation?.situationPrompt,
        isLoading,
        isSummarizing,
        isTypewriterActive: isTypewriterActive || situationVnPresentation.locked,
        getAiApiConfig,
        setRoomReplySuggestions,
    });
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

    const recordJobDebugLogs = useCallback((
        data: RustTurnResponse | undefined,
        sourceRoom: Room | undefined,
        secretMode?: boolean,
    ) => {
        if (!data || !sourceRoom) return;
        recordConversationDebugLogs(
            {
                data,
                sourceRoom,
                isSecretMode: secretMode ?? sourceRoom.secretMode === true,
                debugEnabled: fullJsonDebugEnabled,
            },
            { addFullJsonDebugLog, getCurrentRoom },
        );
    }, [addFullJsonDebugLog, fullJsonDebugEnabled, getCurrentRoom]);

    const generateInitialRoomTitle = useRoomTitleGeneration({
        groupCharacters,
        model: titleGenerationModel,
        getAiApiConfig,
        getRoom: (roomId) => useStore.getState().rooms.find((candidate) => candidate.id === roomId),
        updateRoomName,
    });

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
                    turns: job.preview.turns,
                });
            }
            if (job.status !== 'running') return job;
        }
        throw new DOMException('Generation stopped', 'AbortError');
    }, [getCurrentRoom, isGenerationSessionActive, vnTypingSpeedRef]);

    const resumeConversationJob = useCallback(async (job: ChatConversationJobStatus) => {
        if (resumedJobsRef.current.has(job.jobId) || hasGenerationSession(job.roomId)) {
            return;
        }
        resumedJobsRef.current.add(job.jobId);
        const sourceRoom = useStore.getState().rooms.find((candidate) => candidate.id === job.roomId);
        if (job.status === 'completed') {
            try {
                recordJobDebugLogs(job.result, sourceRoom);
                await refreshConversationRoom(job.roomId);
            } catch (error) {
                resumedJobsRef.current.delete(job.jobId);
                throw error;
            }
            return;
        }
        if (job.status === 'failed') {
            recordJobDebugLogs(job.partialResult, sourceRoom);
            return;
        }
        if (job.status !== 'running') return;

        const session = startGenerationSession(job.roomId, job.jobId);
        const controller = new AbortController();
        if (!attachGenerationController(session, controller)) {
            resumedJobsRef.current.delete(job.jobId);
            return;
        }
        let keepStreamingPreview = false;
        try {
            const completed = await pollConversationJob(session, controller);
            if (completed.status === 'completed') {
                recordJobDebugLogs(completed.result, sourceRoom);
                if (vnTypingSpeedRef.current === 'streaming') {
                    rememberStreamedFinalMessageIds(
                        completed.result?.messages
                            ?.map((message) => message.id)
                            .filter(Boolean)
                        ?? [],
                    );
                }
                await refreshConversationRoom(job.roomId);
                keepStreamingPreview = vnTypingSpeedRef.current === 'streaming'
                    && isSituationVisualNovelMode
                    && (completed.result?.messages?.length ?? 0) > 0;
            } else if (completed.status === 'failed') {
                recordJobDebugLogs(completed.partialResult, sourceRoom);
                if (getCurrentRoom()?.id === job.roomId) {
                    const error = completed.error || 'バックグラウンド生成に失敗しました。';
                    logChatError('Conversation job failed:', error);
                    showChatErrorNotice(error);
                }
            }
        } catch (error) {
            resumedJobsRef.current.delete(job.jobId);
            if (!(error instanceof Error && error.name === 'AbortError')) {
                logChatError('Conversation job recovery failed:', error);
                if (getCurrentRoom()?.id === job.roomId) {
                    showChatErrorNotice(error);
                }
            }
        } finally {
            if (!keepStreamingPreview) clearStreamingPreview(session.jobId);
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
        isSituationVisualNovelMode,
        logChatError,
        pollConversationJob,
        recordJobDebugLogs,
        refreshConversationRoom,
        rememberStreamedFinalMessageIds,
        showChatErrorNotice,
        startGenerationSession,
        vnTypingSpeedRef,
    ]);

    useEffect(() => {
        let disposed = false;
        const synchronizeJobs = (refreshActiveRoom = false) => {
            if (refreshActiveRoom) {
                const activeRoom = useStore.getState().getCurrentRoom();
                if (activeRoom && activeRoom.secretMode !== true && activeRoom.isDraft !== true) {
                    void refreshConversationRoom(activeRoom.id).catch((error) => {
                        if (!disposed) console.warn('Conversation room synchronization failed:', error);
                    });
                }
            }
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
        };
        const handlePageShow = () => synchronizeJobs(true);
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') synchronizeJobs(true);
        };

        synchronizeJobs();
        window.addEventListener('pageshow', handlePageShow);
        window.addEventListener('online', handlePageShow);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            disposed = true;
            window.removeEventListener('pageshow', handlePageShow);
            window.removeEventListener('online', handlePageShow);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [refreshConversationRoom, resumeConversationJob]);

    useEffect(() => {
        dismissChatNotice();
    }, [currentRoomId, dismissChatNotice]);

    useEffect(() => {
        setEditingMessage(null);
    }, [currentRoomId]);

    useEffect(() => {
        setVnLogOpen(false);
    }, [currentRoomId, currentRoomViewMode]);

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

    // Room switches only stop room-local presentation. Server-side generation continues.
    useEffect(() => {
        return () => {
            stopTypewriter(false);
            setIsSummarizing(false);
        };
    }, [room?.id, stopTypewriter]);

    useEffect(() => {
        if (!debugPanelEnabled) {
            setDebugLogOpen(false);
        }
    }, [debugPanelEnabled]);

    useEffect(() => {
        if (!developerInspectorEnabled) setDeveloperInspectorOpen(false);
    }, [developerInspectorEnabled]);

    useEffect(() => {
        if (isMessageMode) {
            stopTypewriter(true);
        }
    }, [isMessageMode, stopTypewriter]);

    const characterMap = useMemo(
        () => buildChatCharacterMap(isGroupRoom, groupCharacters),
        [groupCharacters, isGroupRoom],
    );
    const priorMessagesForDisplay = useMemo(
        () => buildPriorMessagePresentations(situation?.priorMessages ?? [], characterMap),
        [characterMap, situation?.priorMessages],
    );
    const processedMessages = useMemo(
        () => buildChatMessagePresentations({
            room,
            characterMap,
            character,
            isGroupRoom,
            isSecretMode,
            typingMessageId,
            typedContent,
        }),
        [character, characterMap, isGroupRoom, isSecretMode, room, typedContent, typingMessageId],
    );
    const {
        activePreview: activeStreamingPreview,
        previewCharacter: streamingPreviewCharacter,
        formattedMessages: formattedStreamingPreviewMessages,
    } = useMemo(
        () => resolveChatStreamingPresentation({
            streamingPreview,
            room,
            isLoading,
            characterMap,
            character,
        }),
        [character, characterMap, isLoading, room, streamingPreview],
    );

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
        const retainSituationStreamingPreview = shouldStreamPreview
            && isSituationVisualNovelMode;
        let keepStreamingPreview = false;
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
                recordJobDebugLogs(job.partialResult, sourceRoom, isSecretMode);
                resumedJobsRef.current.add(session.jobId);
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
                    deferTypewriter: isVisualNovelMode,
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
                    clearStreamingPreview: retainSituationStreamingPreview
                        ? () => undefined
                        : clearStreamingPreview,
                    addFullJsonDebugLog,
                    getCurrentRoom,
                    markMemoriesUsed,
                    listMemoriesForCharacter,
                    addMemory,
                    attachMemoriesToMessage,
                    playTypewriter,
                },
            );
            keepStreamingPreview = retainSituationStreamingPreview
                && appliedResult.assistantMessageIds.length > 0;
            resumedJobsRef.current.add(session.jobId);
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
            if (!keepStreamingPreview) clearStreamingPreview(session.jobId);
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
        if (
            !submittedInput.trim()
            || !room
            || isLoading
            || isSummarizing
            || (isVisualNovelMode && situationVnPresentation.locked)
        ) return;
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
        if (!room || isLoading || (isVisualNovelMode && situationVnPresentation.locked)) return;
        setReplySuggestionState(null);

        const regenerateAsGroup = isGroupRoom && groupCharacters != null;
        if (!regenerateAsGroup && !character) return;

        const cutFrom = getChatRegenerationCutIndex(room.messages, {
            allowEmptyReplyRound: regenerateAsGroup,
        });
        if (cutFrom == null) return;
        const messagesToDelete = room.messages.slice(cutFrom);

        const session = startGenerationSession(room.id);
        try {
            const removedMemoryRecords = await deleteMessagesFrom(room.id, cutFrom);
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
        closeMention();
        setTouchedMessageId(null);
    }, [closeMention, getCurrentRoom, isLoading, isSummarizing, room]);

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
        if (
            isLoading
            || isSummarizing
            || isEditingMessage
            || (isVisualNovelMode && situationVnPresentation.locked)
            || !suggestion.trim()
        ) return;
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

    const soloVnCharacter = useMemo(() => {
        if (latestAssistantMessage?.characterId && characterMap) {
            return characterMap.get(latestAssistantMessage.characterId) ?? character;
        }
        return character;
    }, [latestAssistantMessage, characterMap, character]);

    const situationVnInitialCharacterId = useMemo(
        () => resolveSituationVisualNovelInitialCharacterId(
            situationPriorMessages,
            groupCharacters ?? [],
        ),
        [groupCharacters, situationPriorMessages],
    );
    const situationVnInitialCharacter = situationVnInitialCharacterId && characterMap
        ? characterMap.get(situationVnInitialCharacterId) ?? null
        : null;

    const situationVnCurrentItem = situationVnPresentation.current;
    const situationVnSceneCharacter = situationVnPresentation.sceneCharacterId && characterMap
        ? characterMap.get(situationVnPresentation.sceneCharacterId) ?? null
        : null;
    const vnCharacter = isSituationVisualNovelMode
        ? situationVnSceneCharacter ?? situationVnInitialCharacter
        : soloVnCharacter;

    const vnSelectedCostumeName = useMemo(
        () => resolveVisualNovelCostumeName(room, vnCharacter),
        [room, vnCharacter],
    );
    const vnCostumeOptions = useMemo(
        () => getVisualNovelCostumeOptions(vnCharacter),
        [vnCharacter],
    );

    const vnExpressionImage = useMemo(
        () => resolveVisualNovelExpressionImage(
            vnCharacter,
            isSituationVisualNovelMode
                ? situationVnPresentation.sceneExpression ?? null
                : activeStreamingPreview?.expression ?? latestAssistantMessage?.emotion ?? latestResolvedAssistantEmotion,
            vnSelectedCostumeName,
        ),
        [
            activeStreamingPreview?.expression,
            isSituationVisualNovelMode,
            latestAssistantMessage,
            latestResolvedAssistantEmotion,
            situationVnPresentation.sceneExpression,
            vnCharacter,
            vnSelectedCostumeName,
        ],
    );
    const latestAssistantMessageId = latestAssistantMessage?.id;
    const latestAssistantEmotion = latestAssistantMessage?.emotion;
    const latestAssistantHasText = !!latestAssistantMessage?.displayContent.trim();
    const situationVnAssistantBounceKey = situationVnCurrentItem?.role === 'assistant'
        ? `${situationVnCurrentItem.key}:${situationVnCurrentItem.expression ?? ''}`
        : null;

    useEffect(() => {
        const bounceKey = isSituationVisualNovelMode
            ? situationVnAssistantBounceKey
            : latestAssistantMessageId;
        if (!isVisualNovelMode || !bounceKey || (!isSituationVisualNovelMode && !latestAssistantHasText)) return;
        triggerVnBounce();
    }, [
        isSituationVisualNovelMode,
        isVisualNovelMode,
        latestAssistantEmotion,
        latestAssistantHasText,
        latestAssistantMessageId,
        situationVnAssistantBounceKey,
        triggerVnBounce,
    ]);

    const lastRoomMessage = room ? room.messages[room.messages.length - 1] : undefined;
    const isWaitingForAssistant = isVisualNovelMode
        ? situationVnPresentation.isWaitingForResponse
            && !(activeStreamingPreview && !isSituationVisualNovelMode)
        : isLoading && lastRoomMessage?.role !== 'assistant' && !activeStreamingPreview;
    const situationVnDialogueContent = situationVnCurrentItem
        ? situationVnCurrentItem.key === typingMessageId
            ? typedContent
            : situationVnCurrentItem.source === 'preview'
                ? situationVnCurrentItem.content
                : situationVnPresentation.currentComplete
                    ? situationVnCurrentItem.content
                    : ''
        : isWaitingForAssistant
            ? '...'
            : '...（話しかけてみましょう）';
    const vnDialogueContent = activeStreamingPreview && !isSituationVisualNovelMode
        ? activeStreamingPreview.content
        : situationVnDialogueContent;
    const vnProcessedDialogueContent = useMemo(() => formatAssistantMarkdown(vnDialogueContent), [vnDialogueContent]);
    const situationVnShowsLatestAssistant = situationVnCurrentItem?.source === 'room'
        && situationVnCurrentItem.role === 'assistant'
        && situationVnCurrentItem.id === latestAssistantMessage?.id;
    const showSituationVnAdvanceIndicator = isVisualNovelMode
        && !isTypewriterActive
        && situationVnPresentation.current != null
        && situationVnPresentation.currentComplete
        && situationVnPresentation.pending.length > 0;
    const canRegenerateVN = !!latestAssistantMessage
        && lastRoomMessage?.id === latestAssistantMessage.id
        && !isLoading
        && !isInlineVnEditing
        && (!isVisualNovelMode || (
            !situationVnPresentation.locked
            && situationVnShowsLatestAssistant
        ));
    const canEditLatestUserMessageInVn = !!latestEditableUserMessage
        && !isLoading
        && !isSummarizing
        && !isInlineVnEditing
        && (!isVisualNovelMode || !situationVnPresentation.locked);
    const vnSpeakerName = isSituationVisualNovelMode
        ? situationVnCurrentItem?.role === 'user'
            ? 'あなた'
            : situationVnCurrentItem?.role === 'assistant'
                ? (situationVnCurrentItem.characterId && characterMap?.get(situationVnCurrentItem.characterId)?.name)
                    ?? situationVnCurrentItem.characterName
                    ?? '不明な話者'
                : groupName ?? 'シチュエーション'
        : undefined;
    const vnDisplayedMessageId = situationVnCurrentItem?.key;
    const vnDisplayedMessageContent = situationVnCurrentItem?.content;
    const situationVnCastCharacters = isSituationVisualNovelMode
        && !vnCharacter
        && situationVnCurrentItem?.role !== 'assistant'
        ? groupCharacters ?? []
        : undefined;

    const handleEditLatestUserMessageInVn = useCallback(() => {
        if (!room || !latestEditableUserMessage || isLoading || isSummarizing) return;
        setEditingMessage({
            roomId: room.id,
            messageId: latestEditableUserMessage.id,
            content: latestEditableUserMessage.content,
        });
        closeMention();
        setTouchedMessageId(null);
        setTimeout(() => textareaRef.current?.focus(), 0);
    }, [closeMention, isLoading, isSummarizing, latestEditableUserMessage, room]);

    const handleSelectVnCostume = (costumeName: string) => {
        if (!room || !vnCharacter || isSituationVisualNovelMode) return;
        const nextSelections = { ...(room.costumeSelections ?? {}) };
        if (costumeName === DEFAULT_COSTUME_NAME) {
            delete nextSelections[vnCharacter.id];
        } else {
            nextSelections[vnCharacter.id] = costumeName;
        }
        updateRoomSettings(room.id, {
            costumeSelections: Object.keys(nextSelections).length > 0 ? nextSelections : undefined,
        });
    };

    const handleToggleSecretMode = () => {
        if (!room || !isRoomEmpty || isLoading || isSummarizing) return;
        setRoomSecretMode(room.id, !isSecretMode);
    };

    const handleClearActiveDebugLogs = () => {
        clearFullJsonDebugLogs();
    };

    const chatInputValue = isInlineVnEditing ? editingMessage?.content ?? '' : input;
    const chatInputPlaceholder = isInlineVnEditing
        ? '直前の入力を編集中'
        : isEditingMessage
            ? '編集中のメッセージで送信してください'
            : '返信を入力';
    const situationVnInputLocked = isVisualNovelMode && situationVnPresentation.locked;
    const previousSituationVnInputLockedRef = useRef(situationVnInputLocked);
    const chatInputDisabled = isLoading
        || isSummarizing
        || situationVnInputLocked
        || (isEditingMessage && !isInlineVnEditing);
    const chatInputSubmitDisabled = chatInputDisabled || (isInlineVnEditing
        ? !editingMessage?.content.trim()
        : !input.trim() || isEditingMessage);

    useEffect(() => {
        const wasLocked = previousSituationVnInputLockedRef.current;
        previousSituationVnInputLockedRef.current = situationVnInputLocked;
        if (!isVisualNovelMode || !wasLocked || situationVnInputLocked) return;
        const timeout = setTimeout(() => textareaRef.current?.focus(), 0);
        return () => clearTimeout(timeout);
    }, [isVisualNovelMode, situationVnInputLocked]);

    const showReplySuggestions = replySuggestionsEnabled
        && replySuggestionState != null
        && replySuggestionState.roomId === room?.id
        && !isEditingMessage
        && !situationVnInputLocked
        && !input.trim()
        && (replySuggestionState.loading || replySuggestionState.suggestions.length === 3);
    const handleChatInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (isInlineVnEditing) {
            handleEditMessageChange(e.target.value);
        } else {
            handleInputChange(e);
        }
    };
    const handleInsertAsterisk = () => {
        if (chatInputDisabled) return;
        const textarea = textareaRef.current;
        const selectionStart = textarea?.selectionStart ?? chatInputValue.length;
        const selectionEnd = textarea?.selectionEnd ?? selectionStart;
        const nextValue = `${chatInputValue.slice(0, selectionStart)}*${chatInputValue.slice(selectionEnd)}`;
        if (isInlineVnEditing) {
            handleEditMessageChange(nextValue);
        } else {
            setInput(nextValue);
            closeMention();
        }
        setTimeout(() => {
            const inputElement = textareaRef.current;
            if (!inputElement) return;
            const nextCursorPosition = selectionStart + 1;
            inputElement.focus();
            inputElement.setSelectionRange(nextCursorPosition, nextCursorPosition);
        }, 0);
    };
    if (!room) {
        return (
            <ChatWelcome
                isMobile={isMobile}
                onOpenSidebar={onOpenSidebar}
                onCreateCharacter={onCreateCharacter}
            />
        );
    }

    const displayedRoomName = room.isDraft ? '' : room.name;
    const replySuggestions = showReplySuggestions && replySuggestionState && (
        <ReplySuggestions
            state={replySuggestionState}
            visualNovelMode={isVisualNovelMode}
            disabled={chatInputDisabled}
            onSelect={handleReplySuggestionSelect}
        />
    );

    return (
        <div className={`chat-container ${isVisualNovelMode ? 'vn-mode' : ''} ${isMessageMode ? 'message-mode' : ''}`}>
            {isVisualNovelMode && situation?.backgroundImage && (
                <div className="vn-background" aria-hidden="true">
                    <StoredImage
                        src={situation.backgroundImage}
                        alt=""
                        className="vn-background-image"
                        loading="eager"
                    />
                </div>
            )}
            {!isVisualNovelLogOpen && (
                <ChatHeader
                    roomId={room.id}
                    roomName={displayedRoomName}
                    subtitle={
                        isGroupRoom && groupCharacters
                            ? groupName ?? 'シチュエーション'
                            : character?.name
                    }
                    isMobile={isMobile}
                    onOpenSidebar={onOpenSidebar}
                    debugEnabled={debugPanelEnabled}
                    debugLogCount={visibleDebugLogCount}
                    onOpenDebug={() => setDebugLogOpen(true)}
                    inspectorEnabled={developerInspectorEnabled}
                    onOpenInspector={() => setDeveloperInspectorOpen(true)}
                    showMemoryButton={showHeaderMemoryButton}
                    onOpenMemory={() => onOpenMemoryList(character)}
                    showSecretModeButton={
                        !!(character || isGroupRoom) && (isRoomEmpty || isSecretMode)
                    }
                    isSecretMode={isSecretMode}
                    isRoomEmpty={isRoomEmpty}
                    onToggleSecretMode={handleToggleSecretMode}
                    onStartNewChat={
                        !isRoomEmpty && !isGroupRoom && character
                            ? () => createRoom(
                                character.id,
                                undefined,
                                { viewMode: currentRoomViewMode },
                            )
                            : !isRoomEmpty && isGroupRoom && room.groupId
                                ? () => createRoomForSituation(
                                    room.groupId!,
                                    undefined,
                                    { viewMode: currentRoomViewMode },
                                )
                                : undefined
                    }
                    newChatTitle={
                        isGroupRoom
                            ? `${groupName ?? 'シチュエーション'}の新しいチャットを開始`
                            : undefined
                    }
                    showViewModeSelector={!!(character || isGroupRoom)}
                    allowVisualNovelMode
                    currentViewMode={currentRoomViewMode}
                    onChangeViewMode={(viewMode) => {
                        setVnLogOpen(false);
                        updateRoomSettings(room.id, { viewMode });
                    }}
                    disabled={isLoading || isSummarizing}
                />
            )}

            {isVisualNovelLogOpen ? (
                <VisualNovelLogView
                    character={character}
                    priorMessages={priorMessagesForDisplay}
                    messages={processedMessages}
                    activeStreamingPreview={activeStreamingPreview}
                    streamingPreviewCharacter={streamingPreviewCharacter}
                    formattedStreamingPreviewMessages={formattedStreamingPreviewMessages}
                    isLoading={isLoading}
                    isSummarizing={isSummarizing}
                    onClose={closeVisualNovelLog}
                />
            ) : isVisualNovelMode ? (
                <VisualNovelView
                    character={vnCharacter}
                    fallbackCharacterName={character?.name}
                    speakerName={vnSpeakerName}
                    castCharacters={situationVnCastCharacters}
                    expressionImage={vnExpressionImage}
                    bounceActive={vnBounceActive}
                    onCharacterImageLoad={triggerVnBounce}
                    replySuggestions={replySuggestions}
                    hasReplySuggestions={showReplySuggestions}
                    isSummarizing={isSummarizing}
                    selectedCostumeName={vnSelectedCostumeName}
                    costumeOptions={vnCostumeOptions}
                    onSelectCostume={handleSelectVnCostume}
                    showCostumeSelector={!isSituationVisualNovelMode}
                    onOpenLog={openVisualNovelLog}
                    canEditLatestUserMessage={canEditLatestUserMessageInVn}
                    onEditLatestUserMessage={handleEditLatestUserMessageInVn}
                    displayedMessageId={vnDisplayedMessageId}
                    displayedMessageContent={vnDisplayedMessageContent}
                    isDisplayedMessageCopied={
                        !!vnDisplayedMessageId && copiedMessageId === vnDisplayedMessageId
                    }
                    onCopyDisplayedMessage={() => {
                        if (vnDisplayedMessageId && vnDisplayedMessageContent != null) {
                            void handleCopyMessage(vnDisplayedMessageId, vnDisplayedMessageContent);
                        }
                    }}
                    canRegenerate={canRegenerateVN}
                    onRegenerate={handleRegenerate}
                    canBranch={
                        !!latestAssistantMessage
                        && !isLoading
                        && !isSummarizing
                        && !branchingMessageId
                        && !isSecretMode
                        && (!isVisualNovelMode || (
                            !situationVnPresentation.locked
                            && situationVnShowsLatestAssistant
                        ))
                    }
                    onBranch={() => {
                        if (latestAssistantMessage) {
                            void handleBranch(latestAssistantMessage.id);
                        }
                    }}
                    isWaitingForAssistant={isWaitingForAssistant}
                    dialogueContent={vnProcessedDialogueContent}
                    plainStreamingContent={
                        !isSituationVisualNovelMode
                        && activeStreamingPreview
                        && formattedStreamingPreviewMessages.length === 0
                            ? activeStreamingPreview.content
                            : undefined
                    }
                    isTypewriterActive={isTypewriterActive}
                    dialogueAdvanceAvailable={
                        isTypewriterActive
                        || (isVisualNovelMode && situationVnPresentation.canAdvance)
                    }
                    showDialogueAdvanceIndicator={showSituationVnAdvanceIndicator}
                    onAdvanceDialogue={situationVnPresentation.advanceDialogue}
                />
            ) : (
                <ChatMessagesView
                    key={room.id}
                    priorMessages={priorMessagesForDisplay}
                    messages={processedMessages}
                    isSecretMode={isSecretMode}
                    isMessageMode={isMessageMode}
                    isGroupRoom={isGroupRoom}
                    character={character}
                    activeStreamingPreview={activeStreamingPreview}
                    streamingPreviewCharacter={streamingPreviewCharacter}
                    formattedStreamingPreviewMessages={formattedStreamingPreviewMessages}
                    isLoading={isLoading}
                    isSummarizing={isSummarizing}
                    branchingMessageId={branchingMessageId}
                    hoveredMessageId={hoveredMessageId}
                    touchedMessageId={touchedMessageId}
                    copiedMessageId={copiedMessageId}
                    streamedFinalMessageIds={streamedFinalMessageIds}
                    typingMessageId={typingMessageId}
                    isTypewriterActive={isTypewriterActive}
                    editingMessage={
                        editingMessage?.roomId === room.id
                            ? {
                                messageId: editingMessage.messageId,
                                content: editingMessage.content,
                            }
                            : null
                    }
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                    onTouchStart={handleTouchStart}
                    onEdit={handleEditMessage}
                    onEditChange={handleEditMessageChange}
                    onCancelEdit={handleCancelEditMessage}
                    onSubmitEdit={handleSubmitEditMessage}
                    onCopy={handleCopyMessage}
                    onRegenerate={handleRegenerate}
                    onBranch={handleBranch}
                    onOpenMemoryList={handleOpenMessageMemoryList}
                    onRevealTypewriter={() => stopTypewriter(true)}
                />
            )}

            {!isVisualNovelLogOpen && (
                <ChatComposer
                    inputRef={textareaRef}
                    focusKey={room.id}
                    value={chatInputValue}
                    onChange={handleChatInputChange}
                    onInsertAsterisk={handleInsertAsterisk}
                    placeholder={chatInputPlaceholder}
                    disabled={chatInputDisabled}
                    redirectDisabled={
                        isLoading
                        || situationVnInputLocked
                        || (isEditingMessage && !isInlineVnEditing)
                    }
                    submitDisabled={chatInputSubmitDisabled}
                    isMobile={isMobile}
                    isInlineEditing={isInlineVnEditing}
                    isBusy={
                        isLoading
                        || isSummarizing
                        || (situationVnInputLocked && isTypewriterActive)
                    }
                    isTypewriterActive={isTypewriterActive}
                    onSubmit={() => {
                        void handleSubmit();
                    }}
                    onSubmitEdit={handleSubmitEditMessage}
                    onCancelEdit={handleCancelEditMessage}
                    onStop={handleStop}
                    notice={chatNotice}
                    noticeActionDisabled={isLoading || isSummarizing || situationVnInputLocked}
                    onNoticeAction={handleChatNoticeAction}
                    onDismissNotice={dismissChatNotice}
                    onNoticeInteractionStart={handleChatNoticeMouseEnter}
                    onNoticeInteractionEnd={handleChatNoticeMouseLeave}
                    replySuggestions={replySuggestions}
                    visualNovelMode={isVisualNovelMode}
                    mentionOpen={mentionQuery !== null}
                    mentionCandidates={mentionCandidates}
                    selectedMentionIndex={selectedMentionIdx}
                    setSelectedMentionIndex={setSelectedMentionIdx}
                    onApplyMention={applyMention}
                    onCloseMention={closeMention}
                />
            )}
            {debugLogOpen && debugPanelEnabled && (
                <DebugLogModal
                    logs={fullJsonDebugLogs}
                    onClose={() => setDebugLogOpen(false)}
                    onClear={handleClearActiveDebugLogs}
                />
            )}
            {developerInspectorOpen && developerInspectorEnabled && (
                <DeveloperInspectorsModal
                    room={room}
                    memoryEnabled={memoryInspectorEnabled}
                    summaryEnabled={summaryInspectorEnabled}
                    onClose={() => setDeveloperInspectorOpen(false)}
                />
            )}
        </div>
    );
}
