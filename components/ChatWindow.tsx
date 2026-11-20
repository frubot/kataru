import { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo } from 'react';
import {
    useStore,
    Room,
    Character,
    Message,
    Situation,
    SituationParticipant,
    RoomCompressionSnapshot,
} from '@/lib/store';
import type { MemoryRecord, MessageAttachment, SituationPriorMessage } from '@/lib/store';
import { capMessageAttachmentData, readChatAttachmentFiles } from '@/lib/chatAttachments';
import {
    isNarrationMessage,
    isNarratorCharacterId,
    NARRATOR_DISPLAY_NAME,
    wrapNarrationForDialogue,
} from '@/lib/narration';
import { serializeModelRef } from '@/lib/modelDefaults';
import { activeWordReplacements } from '@/lib/wordReplacements';
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
    clearPendingReplyMarker,
    collectRetainedPreviewBubbles,
    getPendingReplyMarker,
    getReadUserMessageIds,
    getTrailingUserMessageIds,
    getUserMessageRunRange,
    hasUnansweredUserMessages,
    replyDelayMilliseconds,
    resolvePendingReplyWaitMs,
    savePendingReplyMarker,
} from '@/lib/chatReplyQueue';
import {
    clearPendingTurnRestore,
    getPendingTurnRestore,
    getPendingTurnRestores,
    recoverOrphanedPendingTurnRestore,
    savePendingTurnRestore,
} from '@/lib/pendingTurnRestore';
import {
    buildChatCharacterMap,
    buildChatMessagePresentations,
    buildPriorMessagePresentations,
    resolveChatStreamingPresentation,
} from '@/lib/chatMessagePresentation';
import type { ChatStreamingAwaitingStatus, ChatStreamingPreview } from '@/lib/chatMessagePresentation';
import {
    cancelConversationJob,
    getConversationJob,
    listConversationJobs,
    requestMemoryFlush,
    submitConversationJob,
} from '@/lib/conversationJobClient';
import type { ConversationJobStatus } from '@/lib/conversationJobClient';
import type { RustTurnResponse } from '@/lib/conversationResult';
import {
    getLatestActiveChatMessage,
    isChatContinuationAvailable,
} from '@/lib/chatContinuation';
import { formatAssistantMarkdown, hideAssistantDialogueBrackets } from '@/lib/markdownUtils';
import {
    EMPTY_SITUATION_VISUAL_NOVEL_STAGE_ROSTER,
    getSituationVisualNovelTypingKey,
    resolveSituationVisualNovelInitialCharacterId,
    updateSituationVisualNovelStageRoster,
} from '@/lib/situationVisualNovelPresentation';
import type { SituationVisualNovelStageRoster } from '@/lib/situationVisualNovelPresentation';
import { resolveDefaultCostume } from '@/lib/costumes';
import { buildNarrationSpeechSegments, buildSpeechText } from '@/lib/tts';
import { useTtsEntry } from '@/lib/ttsPlayer';
import {
    findVisualNovelCostume,
    getVisualNovelCostumeOptions,
    getVisualNovelExpressionNames,
    getVisualNovelMotionNames,
    getVisualNovelPreloadCandidates,
    resolveVisualNovelCostumeId,
    resolveVisualNovelExpressionImage,
    shouldTriggerVisualNovelBounce,
} from '@/lib/visualNovelPresentation';
import type { VisualNovelBounceSnapshot } from '@/lib/visualNovelPresentation';
import AttachmentImageModal, { type PreviewedAttachmentImage } from './chat/AttachmentImageModal';
import ChatComposer from './chat/ChatComposer';
import ChatHeader from './chat/ChatHeader';
import ChatMessagesView from './chat/ChatMessagesView';
import ChatWelcome from './chat/ChatWelcome';
import DebugLogModal from './chat/DebugLogModal';
import DeveloperInspectorsModal from './chat/DeveloperInspectorsModal';
import ReplySuggestions from './chat/ReplySuggestions';
import { applyConversationResult, applySecretConversationMessages, recordConversationDebugLogs } from './chat/applyConversationResult';
import { useBackgroundTasks } from './chat/useBackgroundTasks';
import { useChatGenerationSessions } from './chat/useChatGenerationSessions';
import type { ChatGenerationSession } from './chat/useChatGenerationSessions';
import { useChatMentions } from './chat/useChatMentions';
import { useChatNotice } from './chat/useChatNotice';
import type { ChatNoticeAction } from './chat/useChatNotice';
import { useReplySuggestions } from './chat/useReplySuggestions';
import { useRoomTitleGeneration } from './chat/useRoomTitleGeneration';
import { useVisualNovelPresentation } from './chat/useVisualNovelPresentation';
import { useSituationVisualNovelPresentation } from './chat/useSituationVisualNovelPresentation';
import { useVisualNovelAutoPlay } from './chat/useVisualNovelAutoPlay';
import { useTtsPlayback } from './chat/useTtsPlayback';
import { useMessageReplyPacing } from './chat/useMessageReplyPacing';
import { buildMessageTimeLabels } from '@/lib/messageTimeLabels';
import type { VisualNovelTtsItem } from './chat/useTtsPlayback';
import VisualNovelLogView from './chat/VisualNovelLogView';
import VisualNovelView from './chat/VisualNovelView';
import type { VisualNovelStageSprite } from './chat/VisualNovelView';
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

const CONVERSATION_JOB_POLL_INTERVAL_MS = 120;
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_SITUATION_PRIOR_MESSAGES: SituationPriorMessage[] = [];

type RoomViewMode = NonNullable<Room['viewMode']>;
type EditingMessageDraft = {
    roomId: string;
    messageId: string;
    /** ユーザー発言は巻き戻して送り直し、キャラ側の発言はその場で書き換える。 */
    role: 'user' | 'assistant';
    content: string;
    attachments?: MessageAttachment[];
};
type ConversationCharacter = {
    id: string;
    name: string;
    systemPrompt: string;
    speechStyle?: string;
    protagonistPrompt?: string;
    userConstraints?: string;
    maxCharacters?: number;
    maxHistory?: number;
    enableMemory?: boolean;
    realTimeMode?: Character['realTimeMode'];
    /** 会話で使う衣装の id。部屋の衣装選択が無いときはこの衣装を使う。 */
    defaultCostumeId?: string;
    costumes?: {
        id: string;
        name: string;
        description?: string;
        expressions?: { name: string }[];
        motions?: { name: string }[];
    }[];
};
type ConversationParticipant = ConversationCharacter & {
    actorId: string;
    actorType: SituationParticipant['actorType'];
    sourceCharacterId?: string;
    rolePrompt?: string;
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
        maxCharacters: character.maxCharacters,
        maxHistory: character.maxHistory,
        enableMemory: character.enableMemory,
        realTimeMode: character.realTimeMode,
        defaultCostumeId: resolveDefaultCostume(character)?.id,
        // Names are resolved per costume so a VRM avatar exposes its mapped names.
        costumes: character.costumes?.map((costume) => ({
            id: costume.id,
            name: costume.name,
            description: costume.description,
            expressions: getVisualNovelExpressionNames(character, costume.id).map((name) => ({ name })),
            motions: getVisualNovelMotionNames(character, costume.id).map((name) => ({ name })),
        })),
    };
}

/** ルームを離れるときの記憶の反映に使う設定。最新の設定をストアから読む。 */
function buildMemoryFlushPayload(roomId: string, character: Character) {
    const state = useStore.getState();
    return {
        room: { id: roomId },
        character: toConversationCharacter(character),
        memoryExtractionModel: serializeModelRef(state.memoryExtractionModel),
        memoryEmbeddingModel: serializeModelRef(state.memoryEmbeddingModel),
        aiApiConfig: state.getAiApiConfig(),
    };
}

function toConversationParticipant(participant: SituationParticipant): ConversationParticipant {
    return {
        ...toConversationCharacter(participant)!,
        actorId: participant.actorId,
        actorType: participant.actorType,
        sourceCharacterId: participant.sourceCharacterId,
        rolePrompt: participant.rolePrompt,
    };
}

function toConversationSituation(situation: Situation | null | undefined) {
    if (!situation) return null;
    return {
        id: situation.id,
        name: situation.name,
        situationPrompt: situation.situationPrompt,
        priorMessages: situation.priorMessages,
        maxTurns: situation.maxTurns,
        limitTurns: situation.limitTurns === true,
        memoryMode: situation.memoryMode,
        separateNarration: situation.separateNarration === true,
        realTimeMode: situation.realTimeMode ?? 'off',
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

const VN_BACKGROUND_CROSSFADE_MS = 620;

function VisualNovelBackground({ src }: { src: string }) {
    const [layers, setLayers] = useState(() => [{ key: 0, src }]);
    const nextLayerKey = useRef(1);

    useEffect(() => {
        setLayers((current) => (
            current[current.length - 1]?.src === src
                ? current
                : [...current.slice(-1), { key: nextLayerKey.current++, src }]
        ));
    }, [src]);

    useEffect(() => {
        if (layers.length <= 1) return;
        const timer = setTimeout(() => {
            setLayers((current) => current.slice(-1));
        }, VN_BACKGROUND_CROSSFADE_MS);
        return () => clearTimeout(timer);
    }, [layers.length]);

    return (
        <div className="vn-background" aria-hidden="true">
            {layers.map((layer, index) => (
                <StoredImage
                    key={layer.key}
                    src={layer.src}
                    alt=""
                    className={`vn-background-image${index === layers.length - 1 ? ' vn-bg-fade-in' : ''}`}
                    loading="eager"
                    fetchPriority="high"
                />
            ))}
        </div>
    );
}

type ChatRetryRequest =
    | {
        kind: 'submit';
        roomId: string;
        input: string;
        attachments?: MessageAttachment[];
        editDraft?: EditingMessageDraft;
        suggestedReply?: string;
    }
    | {
        kind: 'continue';
        roomId: string;
    }
    | {
        /** 連投への返信生成の再試行。送信済みのメッセージはそのまま残っている。 */
        kind: 'reply';
        roomId: string;
    };

/** 生成リクエストに載せる会話相手。部屋を離れた後に生成する場合は送信時の値を使う。 */
type ChatGenerationContext = {
    character: Character | null;
    situation: Situation | null | undefined;
    groupCharacters: SituationParticipant[] | null | undefined;
    isSecretMode: boolean;
};

/** 待ち時間中の返信。タイマーが切れるか部屋を離れたときに生成を始める。 */
type PendingReplyEntry = {
    timer: ReturnType<typeof setTimeout> | null;
    /** 最後の送信直後の部屋。部屋を離れるとストアのメッセージが消えるため保持する。 */
    room: Room;
    context: ChatGenerationContext;
    generateTitle: boolean;
    originalRoomName: string;
};

const INTERRUPT_IDLE_POLL_MS = 50;
const INTERRUPT_IDLE_TIMEOUT_MS = 15_000;

type ChatGenerationMode = 'reply' | 'continue';

type ChatGenerationResult = {
    status: 'success' | 'aborted' | 'detached' | 'error';
    message?: string;
    toCharacterIds?: string[];
    error?: unknown;
    /** True when the cancelled job retained generated turns that were kept. */
    retainedMessages?: boolean;
};

type ChatConversationJobStatus = ConversationJobStatus<RustTurnResponse>;

function hasRetainedCancelledMessages(result: RustTurnResponse | undefined): boolean {
    return (result?.messages?.filter((message) => message?.content?.trim()).length ?? 0) > 0;
}

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
        loadingRoomHistoryId,
        addMessage,
        deleteMessagesFrom,
        restoreMessagesAt,
        updateAssistantMessageContent,
        rewindRoomCompression,
        restoreRoomCompression,
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
        vnMaxStageSprites,
        summaryModel: globalSummaryModel,
        conversationCompressionEnabled,
        memoryGateModel,
        memoryGateEnabled,
        memoryBatchUserTurns,
        memoryExtractionModel,
        memoryEmbeddingModel,
        reasoningEffort,
        chatSampling,
        wordReplacements,
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
        getAiApiConfig,
        chatWallpaper,
        ttsEnabled,
        ttsNarrationEnabled,
        replyDelaySeconds,
    } = useStore();
    const isGroupRoom = situation != null || (groupCharacters != null && groupCharacters.length > 1);
    const rawRoomViewMode = resolveRoomViewMode(room);
    const currentRoomViewMode = rawRoomViewMode;
    const isBasicMode = currentRoomViewMode === 'chat';
    const isMessageMode = currentRoomViewMode === 'message';
    const isVisualNovelMode = currentRoomViewMode === 'vn';
    const isSituationVisualNovelMode = isVisualNovelMode && isGroupRoom;
    const situationPriorMessages = situation?.priorMessages ?? EMPTY_SITUATION_PRIOR_MESSAGES;
    const isRoomEmpty = (room?.messages.length ?? 0) === 0;
    const isSecretMode = room?.secretMode === true;
    const showHeaderMemoryButton = !isGroupRoom && character != null && character.enableMemory !== false;
    const [input, setInput] = useState('');
    const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
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
    const [vnAutoPlay, setVnAutoPlay] = useState(false);
    const [previewAttachmentImage, setPreviewAttachmentImage] = useState<PreviewedAttachmentImage | null>(null);
    const [streamingPreview, setStreamingPreview] = useState<ChatStreamingPreview | null>(null);
    const [streamedFinalMessageIds, setStreamedFinalMessageIds] = useState<Set<string>>(() => new Set());
    // 割り込み時に、画面に見えていた確定済みの吹き出しを残すために参照する。
    const streamingPreviewRef = useRef(streamingPreview);
    useEffect(() => {
        streamingPreviewRef.current = streamingPreview;
    }, [streamingPreview]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const resumedJobsRef = useRef<Set<string>>(new Set());
    const cancelledJobResultsRef = useRef<Map<string, RustTurnResponse | undefined>>(new Map());
    // ユーザー停止で走るキャンセル適用を部屋単位で追跡する。ロールバックは
    // この適用が終わるまで待たないと、古い履歴読込が復元結果を上書きする。
    const pendingCancelledAppliesRef = useRef<Map<string, Promise<void>>>(new Map());
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retrySubmissionRef = useRef<ChatRetryRequest | null>(null);
    const chatNoticeActionRunningRef = useRef(false);
    const messagePointerDragRef = useRef(false);
    // 添付の読み込み完了時に入力コンテキストが変わっていたら結果を捨てるための世代。
    // ルーム切替・表示モード変更・送信でインクリメントする。
    const attachmentReadSessionRef = useRef(0);
    const previousVnBounceSnapshotRef = useRef<VisualNovelBounceSnapshot | null>(null);
    const {
        bounceActive: vnBounceActive,
        typingMessageId,
        typedContent,
        isTypewriterActive,
        triggerBounce: triggerVnBounce,
        stopBounce: stopVnBounce,
        stopTypewriter,
        playTypewriter,
    } = useVisualNovelPresentation({ typingSpeed: vnTypingSpeed });
    const openVisualNovelLog = useCallback(() => {
        stopTypewriter(true);
        stopVnBounce();
        setEditingMessage(null);
        setVnLogOpen(true);
    }, [stopTypewriter, stopVnBounce]);
    const closeVisualNovelLog = useCallback(() => {
        setEditingMessage(null);
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
        onCancelled: (roomId, job) => {
            const targetRoom = useStore.getState().rooms.find((candidate) => candidate.id === roomId);
            if (!targetRoom) return;
            const applied = handleCancelledJobResult(
                job.jobId,
                job.partialResult as RustTurnResponse | undefined,
                targetRoom,
            ).catch((error) => {
                console.warn('Cancelled conversation result handling failed:', error);
            });
            const previous = pendingCancelledAppliesRef.current.get(roomId) ?? Promise.resolve();
            const tracked = previous.then(() => applied);
            pendingCancelledAppliesRef.current.set(roomId, tracked);
            void tracked.finally(() => {
                if (pendingCancelledAppliesRef.current.get(roomId) === tracked) {
                    pendingCancelledAppliesRef.current.delete(roomId);
                }
            });
        },
    });
    const currentRoomId = room?.id;
    // ルームを離れるとき（別のルームを開く・ページを閉じる）に、未反映の発言を記憶へまとめて反映する。
    const memoryFlushCharacter = !isGroupRoom && !isSecretMode && character != null && character.enableMemory !== false
        ? character
        : null;
    const memoryFlushCharacterRef = useRef(memoryFlushCharacter);
    useEffect(() => {
        memoryFlushCharacterRef.current = memoryFlushCharacter;
    });
    useEffect(() => {
        if (!currentRoomId) return;
        const flush = () => {
            const flushCharacter = memoryFlushCharacterRef.current;
            if (!flushCharacter) return;
            requestMemoryFlush(buildMemoryFlushPayload(currentRoomId, flushCharacter));
        };
        window.addEventListener('pagehide', flush);
        return () => {
            window.removeEventListener('pagehide', flush);
            flush();
        };
    }, [currentRoomId]);
    const isLoading = currentRoomId ? activeGenerationRoomIds.has(currentRoomId) : false;
    // メッセージ・ベーシックモードでは、送信後の待ち時間でまとめて返信し、
    // 生成中の送信は割り込みとして扱う。ゲームモードは従来どおり1送信1返信。
    const usesReplyQueue = isBasicMode || isMessageMode;
    const replyDelayMs = replyDelayMilliseconds(replyDelaySeconds);
    const replyDelayMsRef = useRef(replyDelayMs);
    // 入力欄に下書き（文字・添付）があるか。設定した待ち時間は入力中にだけ使う。
    const hasComposerDraft = input.trim() !== '' || (isBasicMode && attachments.length > 0);
    const hasComposerDraftRef = useRef(hasComposerDraft);
    const currentGenerationContext: ChatGenerationContext = {
        character,
        situation,
        groupCharacters,
        isSecretMode,
    };
    const currentGenerationContextRef = useRef(currentGenerationContext);
    useEffect(() => {
        replyDelayMsRef.current = replyDelayMs;
        hasComposerDraftRef.current = hasComposerDraft;
        currentGenerationContextRef.current = {
            character,
            situation,
            groupCharacters,
            isSecretMode,
        };
    });
    // AIが読んだ（そのメッセージを含む返信生成が始まった）ユーザー発言。
    const [readMessageIds, setReadMessageIds] = useState<ReadonlySet<string>>(() => new Set());
    const markMessagesRead = useCallback((messageIds: readonly string[]) => {
        if (messageIds.length === 0) return;
        setReadMessageIds((current) => {
            if (messageIds.every((id) => current.has(id))) return current;
            const next = new Set(current);
            for (const id of messageIds) next.add(id);
            return next;
        });
    }, []);
    const pendingRepliesRef = useRef<Map<string, PendingReplyEntry>>(new Map());
    const [pendingReplyRoomIds, setPendingReplyRoomIds] = useState<ReadonlySet<string>>(() => new Set());
    const runPendingReplyRef = useRef<(roomId: string) => void>(() => undefined);
    const setPendingReplyRoomActive = useCallback((roomId: string, active: boolean) => {
        setPendingReplyRoomIds((current) => {
            if (current.has(roomId) === active) return current;
            const next = new Set(current);
            if (active) {
                next.add(roomId);
            } else {
                next.delete(roomId);
            }
            return next;
        });
    }, []);
    /**
     * 返信待ちのタイマーを（掛け直して）始める。入力欄に下書きがあれば設定した
     * 待ち時間、空なら次の連投を打ち始めるための短い猶予だけ待つ。
     */
    const startPendingReplyTimer = useCallback((
        roomId: string,
        entry: PendingReplyEntry,
        hasDraft: boolean = hasComposerDraftRef.current,
    ) => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            entry.timer = null;
            runPendingReplyRef.current(roomId);
        }, resolvePendingReplyWaitMs(replyDelayMsRef.current, hasDraft));
    }, []);
    /** 返信待ちを登録（または延長）する。待ち時間が切れると返信を生成する。 */
    const schedulePendingReply = useCallback((
        roomId: string,
        snapshot: Omit<PendingReplyEntry, 'timer'>,
        hasDraft?: boolean,
    ) => {
        const existing = pendingRepliesRef.current.get(roomId);
        const entry: PendingReplyEntry = {
            ...snapshot,
            timer: existing?.timer ?? null,
            generateTitle: snapshot.generateTitle || existing?.generateTitle === true,
            originalRoomName: existing?.originalRoomName ?? snapshot.originalRoomName,
        };
        pendingRepliesRef.current.set(roomId, entry);
        setPendingReplyRoomActive(roomId, true);
        if (snapshot.room.secretMode !== true) {
            void savePendingReplyMarker(roomId).catch((error) => {
                console.warn('Pending reply marker save failed:', error);
            });
        }
        startPendingReplyTimer(roomId, entry, hasDraft);
    }, [setPendingReplyRoomActive, startPendingReplyTimer]);
    /**
     * 入力欄が変わったら返信待ちのタイマーを掛け直す。打っている間は設定した
     * 待ち時間を待ち、全部消して空になったら短い猶予で返信する。
     * 返信待ちが無ければ何もしない。
     */
    const updatePendingReplyForDraft = useCallback((roomId: string, hasDraft: boolean) => {
        const entry = pendingRepliesRef.current.get(roomId);
        if (entry?.timer) startPendingReplyTimer(roomId, entry, hasDraft);
    }, [startPendingReplyTimer]);
    /** 返信待ちを取り消す。送信済みのメッセージはそのまま残る。 */
    const takePendingReply = useCallback((
        roomId: string,
        { clearMarker = true }: { clearMarker?: boolean } = {},
    ): PendingReplyEntry | undefined => {
        const entry = pendingRepliesRef.current.get(roomId);
        if (entry?.timer) clearTimeout(entry.timer);
        if (entry) entry.timer = null;
        pendingRepliesRef.current.delete(roomId);
        setPendingReplyRoomActive(roomId, false);
        if (clearMarker) {
            void clearPendingReplyMarker(roomId).catch((error) => {
                console.warn('Pending reply marker cleanup failed:', error);
            });
        }
        return entry;
    }, [setPendingReplyRoomActive]);
    // 生成を伴う操作（送信・再生成・続き・返信待ちの生成）が部屋ごとに
    // いくつ進行中か。割り込みは、止めた操作の後始末（ロールバック等）が
    // 終わってから新しい発言を追加する。
    const turnFlowsRef = useRef<Map<string, number>>(new Map());
    const beginTurnFlow = useCallback((roomId: string) => {
        turnFlowsRef.current.set(roomId, (turnFlowsRef.current.get(roomId) ?? 0) + 1);
        let ended = false;
        return () => {
            if (ended) return;
            ended = true;
            const remaining = (turnFlowsRef.current.get(roomId) ?? 1) - 1;
            if (remaining > 0) {
                turnFlowsRef.current.set(roomId, remaining);
            } else {
                turnFlowsRef.current.delete(roomId);
            }
        };
    }, []);
    // 割り込み送信の処理順。同じ部屋の送信は前の割り込みが終わってから行う。
    const interruptChainsRef = useRef<Map<string, Promise<void>>>(new Map());
    const isVisualNovelLogOpen = isVisualNovelMode && vnLogOpen;
    const situationVnPresentation = useSituationVisualNovelPresentation({
        active: isVisualNovelMode && loadingRoomHistoryId !== room?.id,
        roomId: room?.id,
        situationId: situation?.id,
        messages: room?.messages ?? EMPTY_MESSAGES,
        priorMessages: situationPriorMessages,
        fallbackCharacterId: isGroupRoom ? undefined : character?.id,
        streamingPreview,
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
            && !isVisualNovelMode
            && (streamingPreview.turns?.length ?? 0) > 0
        ) {
            clearStreamingPreview(streamingPreview.jobId);
        }
    }, [
        clearStreamingPreview,
        currentRoomId,
        isLoading,
        isVisualNovelMode,
        streamingPreview,
    ]);
    const isEditingMessage = editingMessage?.roomId === currentRoomId;
    // ゲームモードでは、会話ログを閉じている間だけ入力欄でユーザー発言を編集する。
    const isInlineVnEditing = isVisualNovelMode
        && isEditingMessage
        && !vnLogOpen
        && editingMessage?.role === 'user';
    const debugPanelEnabled = fullJsonDebugEnabled;
    const developerInspectorEnabled = memoryInspectorEnabled || summaryInspectorEnabled;
    const visibleDebugLogCount = fullJsonDebugLogs.length;
    const getAllRooms = useCallback(() => useStore.getState().rooms, []);
    const { tasks: backgroundTasks, checkedAt: backgroundTasksCheckedAt } = useBackgroundTasks({
        enabled: debugPanelEnabled,
        addFullJsonDebugLog,
        getRooms: getAllRooms,
    });
    const runningBackgroundTaskCount = backgroundTasks.filter((task) => task.status === 'running').length;
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

    // 編集・再生成が保存した復元スナップショットを適用する。リロードで
    // 実行中の関数が消えても、永続化しておいたデータから削除前の状態へ
    // 戻せる。スナップショットが無い部屋では何もしない。
    const restorePendingTurnForRoom = useCallback(async (
        roomId: string,
        expectedJobId?: string,
        canRestore?: () => boolean,
    ) => {
        const pending = await getPendingTurnRestore(roomId);
        if (!pending || canRestore?.() === false) return;
        // 同じ部屋で別の生成が始まっている場合、そのスナップショットは
        // 新しいジョブのもの。古いジョブの完了で巻き戻さない。
        if (expectedJobId !== undefined && pending.jobId !== expectedJobId) return;
        await rollbackRestorableMessages(
            {
                roomId,
                fromIndex: pending.fromIndex,
                messages: pending.messages,
                memories: pending.memories,
            },
            { getCurrentRoom, deleteMessagesFrom, restoreMessagesAt },
        );
        if (pending.compressionSnapshot) {
            await restoreRoomCompression(roomId, pending.compressionSnapshot);
        }
        await clearPendingTurnRestore(roomId, pending.jobId);
        await refreshConversationRoom(roomId).catch((error) => {
            console.warn('Pending turn restore refresh failed:', error);
        });
    }, [
        deleteMessagesFrom,
        getCurrentRoom,
        refreshConversationRoom,
        restoreMessagesAt,
        restoreRoomCompression,
    ]);

    const handleCancelledJobResult = useCallback(async (
        jobId: string,
        partialResult: RustTurnResponse | undefined,
        sourceRoom: Room | undefined,
    ) => {
        // A cancelled job is observable from several paths at once — the
        // generation poll, the DELETE response, and the resume listing — so
        // each job's retained result is applied exactly once.
        if (cancelledJobResultsRef.current.has(jobId)) return;
        cancelledJobResultsRef.current.set(jobId, partialResult);
        recordJobDebugLogs(partialResult, sourceRoom, sourceRoom?.secretMode === true);
        if (!sourceRoom) return;
        if (sourceRoom.secretMode === true) {
            if (partialResult) {
                applySecretConversationMessages(
                    partialResult,
                    sourceRoom.id,
                    () => true,
                    {
                        updateRoomSummary,
                        compressRoomHistory,
                        addMessage,
                        rememberStreamedFinalMessageIds,
                    },
                );
            }
            return;
        }
        await refreshConversationRoom(sourceRoom.id);
        // キャンセル時に残ったターンはそのまま採用する。1件も残らなかった
        // 場合だけ、編集・再生成が消した直前のメッセージを復元する。
        if (hasRetainedCancelledMessages(partialResult)) {
            await clearPendingTurnRestore(sourceRoom.id, jobId).catch((error) => {
                console.warn('Pending turn restore cleanup failed:', error);
            });
        } else {
            await restorePendingTurnForRoom(sourceRoom.id, jobId);
        }
    }, [
        addMessage,
        compressRoomHistory,
        recordJobDebugLogs,
        refreshConversationRoom,
        rememberStreamedFinalMessageIds,
        restorePendingTurnForRoom,
        updateRoomSummary,
    ]);

    const pollConversationJob = useCallback(async (
        session: ChatGenerationSession,
        controller: AbortController,
    ): Promise<ChatConversationJobStatus> => {
        while (isGenerationSessionActive(session) && !controller.signal.aborted) {
            await waitForConversationJobPoll(controller.signal, CONVERSATION_JOB_POLL_INTERVAL_MS);
            const job = await getConversationJob<RustTurnResponse>(session.jobId, controller.signal);
            if (
                job.preview && (job.preview.content.trim() || job.preview.expression || job.preview.motion)
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
                    motion: job.preview.motion,
                    turns: job.preview.turns,
                    generationBaselineMessageIds: session.generationBaselineMessageIds,
                    continuationOfMessageId: session.continuationBaseMessageId,
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
        const sourceRoom = useStore.getState().rooms.find((candidate) => candidate.id === job.roomId);
        if (job.status === 'completed') {
            try {
                recordJobDebugLogs(job.result, sourceRoom);
                await refreshConversationRoom(job.roomId);
                if (hasRetainedCancelledMessages(job.result)) {
                    await clearPendingTurnRestore(job.roomId, job.jobId).catch((error) => {
                        console.warn('Pending turn restore cleanup failed:', error);
                    });
                } else {
                    await restorePendingTurnForRoom(job.roomId, job.jobId);
                }
            } catch (error) {
                resumedJobsRef.current.delete(job.jobId);
                throw error;
            }
            return;
        }
        if (job.status === 'failed') {
            recordJobDebugLogs(job.partialResult, sourceRoom);
            try {
                await restorePendingTurnForRoom(job.roomId, job.jobId);
            } catch (error) {
                resumedJobsRef.current.delete(job.jobId);
                throw error;
            }
            return;
        }
        if (job.status === 'cancelled') {
            await handleCancelledJobResult(job.jobId, job.partialResult, sourceRoom).catch((error) => {
                console.warn('Cancelled conversation result handling failed:', error);
            });
            return;
        }
        if (job.status !== 'running') return;

        const session = startGenerationSession(job.roomId, job.jobId);
        session.generationBaselineMessageIds = sourceRoom?.messages.map((message) => message.id);
        session.continuationBaseMessageId = job.generationMode === 'continue'
            ? getLatestActiveChatMessage(sourceRoom?.messages ?? [])?.id
            : undefined;
        if (job.generationMode !== 'continue') {
            markMessagesRead(getTrailingUserMessageIds(sourceRoom?.messages ?? []));
        }
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
                rememberStreamedFinalMessageIds(
                    completed.result?.messages
                        ?.map((message) => message.id)
                        .filter(Boolean)
                    ?? [],
                );
                await refreshConversationRoom(job.roomId);
                if (hasRetainedCancelledMessages(completed.result)) {
                    await clearPendingTurnRestore(job.roomId, job.jobId).catch((error) => {
                        console.warn('Pending turn restore cleanup failed:', error);
                    });
                } else {
                    await restorePendingTurnForRoom(job.roomId, job.jobId);
                }
                keepStreamingPreview = isVisualNovelMode
                    && (completed.result?.messages?.length ?? 0) > 0;
            } else if (completed.status === 'cancelled') {
                // The job was cancelled while being monitored (e.g. stopped
                // from another tab): apply the turns it retained.
                await handleCancelledJobResult(
                    completed.jobId,
                    completed.partialResult,
                    sourceRoom,
                ).catch((error) => {
                    console.warn('Cancelled conversation result handling failed:', error);
                });
            } else if (completed.status === 'failed') {
                recordJobDebugLogs(completed.partialResult, sourceRoom);
                await restorePendingTurnForRoom(job.roomId, job.jobId);
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
        handleCancelledJobResult,
        hasGenerationSession,
        isVisualNovelMode,
        logChatError,
        markMessagesRead,
        pollConversationJob,
        recordJobDebugLogs,
        refreshConversationRoom,
        rememberStreamedFinalMessageIds,
        restorePendingTurnForRoom,
        showChatErrorNotice,
        startGenerationSession,
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
                .then(async (jobs) => {
                    if (disposed) return;
                    // 一覧に残っていないジョブの復元データは、サーバー再起動や
                    // 保持期限切れで行方不明になった分。ジョブ由来のメッセージが
                    // 永続化済みなら破棄し、無ければ削除前の状態へ戻す。
                    const listedJobIds = new Set(jobs.map((job) => job.jobId));
                    const pendingRestores = await getPendingTurnRestores().catch((error) => {
                        console.warn('Pending turn restore discovery failed:', error);
                        return [];
                    });
                    for (const pending of pendingRestores) {
                        if (disposed || listedJobIds.has(pending.jobId)) continue;
                        await recoverOrphanedPendingTurnRestore(pending, {
                            canRecover: () => !disposed && !hasGenerationSession(pending.roomId),
                            restore: restorePendingTurnForRoom,
                        }).catch((error) => {
                            console.warn('Pending turn recovery failed:', error);
                        });
                    }
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
    }, [hasGenerationSession, refreshConversationRoom, restorePendingTurnForRoom, resumeConversationJob]);

    useEffect(() => {
        dismissChatNotice();
    }, [currentRoomId, dismissChatNotice]);

    useEffect(() => {
        attachmentReadSessionRef.current += 1;
        setEditingMessage(null);
        setAttachments([]);
    }, [currentRoomId]);

    // アンマウント時は返信待ちを生成せず、永続化した印で次回に再開する。
    // この effect は下の部屋切替 effect より先に宣言し、後始末が先に走るようにする。
    const unmountingRef = useRef(false);
    useEffect(() => {
        unmountingRef.current = false;
        const pendingReplies = pendingRepliesRef.current;
        return () => {
            unmountingRef.current = true;
            for (const entry of pendingReplies.values()) {
                if (entry.timer) clearTimeout(entry.timer);
                entry.timer = null;
            }
            pendingReplies.clear();
        };
    }, []);

    // 待ち時間中に部屋を離れたら、その部屋の連投へすぐに返信を始める。
    // 離れた部屋のメッセージはストアから外れるので、送信時のスナップショットで生成する。
    useEffect(() => {
        const roomId = currentRoomId;
        if (!roomId) return;
        const pendingReplies = pendingRepliesRef.current;
        return () => {
            if (unmountingRef.current || !pendingReplies.has(roomId)) return;
            runPendingReplyRef.current(roomId);
        };
    }, [currentRoomId]);

    // リロードなどで待ち時間のタイマーが消えた返信待ちを、部屋を開いたときに再開する。
    const roomHistoryReady = !!currentRoomId && loadingRoomHistoryId !== currentRoomId;
    useEffect(() => {
        if (!currentRoomId || !roomHistoryReady || !usesReplyQueue) return;
        let cancelled = false;
        void getPendingReplyMarker(currentRoomId)
            .then((marker) => {
                if (cancelled || !marker) return;
                const latestRoom = useStore.getState().getCurrentRoom();
                if (
                    latestRoom?.id !== currentRoomId
                    || pendingRepliesRef.current.has(currentRoomId)
                    || hasGenerationSession(currentRoomId)
                ) return;
                if (!hasUnansweredUserMessages(latestRoom.messages)) {
                    void clearPendingReplyMarker(currentRoomId);
                    return;
                }
                schedulePendingReply(currentRoomId, {
                    room: latestRoom,
                    context: currentGenerationContextRef.current,
                    generateTitle: false,
                    originalRoomName: latestRoom.name,
                });
            })
            .catch((error) => {
                console.warn('Pending reply recovery failed:', error);
            });
        return () => {
            cancelled = true;
        };
    }, [currentRoomId, hasGenerationSession, roomHistoryReady, schedulePendingReply, usesReplyQueue]);

    useEffect(() => {
        if (!isBasicMode) {
            attachmentReadSessionRef.current += 1;
            setAttachments([]);
        }
    }, [isBasicMode]);

    useEffect(() => {
        setVnLogOpen(false);
        setPreviewAttachmentImage(null);
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
        bubbles: streamingPreviewBubbles,
        awaiting: streamingAwaiting,
        continuationAppend,
        continuationAppendKey,
    } = useMemo(
        () => resolveChatStreamingPresentation({
            streamingPreview,
            room,
            isLoading,
            isMessageMode,
            characterMap,
            character,
        }),
        [character, characterMap, isMessageMode, isLoading, room, streamingPreview],
    );
    // A 「続きを生成」bubble that continues the same character renders as an
    // extension of the previous bubble rather than a separate one.
    const displayMessages = useMemo(() => {
        if (!continuationAppend) return processedMessages;
        const baseId = streamingPreview?.continuationOfMessageId;
        let targetIndex = baseId
            ? processedMessages.findLastIndex(
                (message) => message.id === baseId && !message.mergedIntoPrevious,
            )
            : -1;
        if (targetIndex < 0) {
            targetIndex = processedMessages.findLastIndex(
                (message) => message.role === 'assistant' && !message.isArchived && !message.mergedIntoPrevious,
            );
        }
        if (targetIndex < 0) return processedMessages;
        return processedMessages.map((message, index) => (
            index === targetIndex
                ? { ...message, displayContent: `${message.displayContent}\n\n${continuationAppend}` }
                : message
        ));
    }, [continuationAppend, processedMessages, streamingPreview?.continuationOfMessageId]);

    // メッセージモードでは、今回の返信の吹き出しを人が打つような間で1つずつ見せる。
    const replyPacingEnabled = isMessageMode && !isVisualNovelMode;
    const replyBubbles = useMemo(() => {
        if (!replyPacingEnabled) return [];
        const lastUserIndex = displayMessages.findLastIndex((message) => message.role === 'user');
        const persisted = displayMessages
            .slice(lastUserIndex + 1)
            .filter((message) => message.role === 'assistant' && !message.isArchived && !message.mergedIntoPrevious)
            .map((message) => ({
                key: message.id,
                length: message.displayContent.length,
                awaiting: {
                    characterId: message.characterId,
                    characterName: message.msgCharacterName,
                    character: message.characterId && characterMap
                        ? characterMap.get(message.characterId) ?? null
                        : (isGroupRoom ? null : character),
                } satisfies ChatStreamingAwaitingStatus,
            }));
        const previews = streamingPreviewBubbles.map((bubble) => ({
            key: bubble.key,
            length: bubble.content.length,
            awaiting: {
                characterId: bubble.characterId,
                characterName: bubble.characterName,
                character: bubble.character ?? null,
            } satisfies ChatStreamingAwaitingStatus,
        }));
        return [...persisted, ...previews];
    }, [character, characterMap, displayMessages, isGroupRoom, replyPacingEnabled, streamingPreviewBubbles]);
    const replyBubbleLengths = useMemo(() => replyBubbles.map((bubble) => bubble.length), [replyBubbles]);
    const replyEpochKey = useMemo(() => {
        const lastUserMessage = room?.messages.findLast((message) => message.role === 'user');
        return `${room?.id ?? ''}:${lastUserMessage?.id ?? ''}`;
    }, [room]);
    const replyPacing = useMessageReplyPacing({
        enabled: replyPacingEnabled,
        epochKey: replyEpochKey,
        bubbleLengths: replyBubbleLengths,
        isLoading,
    });
    const heldReplyKeys = useMemo(
        () => new Set(replyBubbles.slice(replyPacing.revealedCount).map((bubble) => bubble.key)),
        [replyBubbles, replyPacing.revealedCount],
    );
    const pacedDisplayMessages = useMemo(
        () => heldReplyKeys.size === 0
            ? displayMessages
            : displayMessages.filter((message) => !heldReplyKeys.has(message.id)),
        [displayMessages, heldReplyKeys],
    );
    const pacedStreamingPreviewBubbles = useMemo(
        () => heldReplyKeys.size === 0
            ? streamingPreviewBubbles
            : streamingPreviewBubbles.filter((bubble) => !heldReplyKeys.has(bubble.key)),
        [heldReplyKeys, streamingPreviewBubbles],
    );
    // 生成中に本文を見せずに待たせた吹き出しは、表示するときに登場アニメーションを付ける。
    const [everHeldReply, setEverHeldReply] = useState<{ epochKey: string; keys: ReadonlySet<string> }>(
        () => ({ epochKey: '', keys: new Set() }),
    );
    useEffect(() => {
        setEverHeldReply((current) => {
            const base = current.epochKey === replyEpochKey ? current.keys : new Set<string>();
            const added = [...heldReplyKeys].filter((key) => !base.has(key));
            if (current.epochKey === replyEpochKey && added.length === 0) return current;
            return { epochKey: replyEpochKey, keys: new Set([...base, ...added]) };
        });
    }, [heldReplyKeys, replyEpochKey]);
    const pacedStreamedFinalMessageIds = useMemo(() => {
        if (everHeldReply.keys.size === 0) return streamedFinalMessageIds;
        return new Set([...streamedFinalMessageIds].filter((id) => !everHeldReply.keys.has(id)));
    }, [everHeldReply, streamedFinalMessageIds]);
    // 現実の日時を会話に使うときは、メッセージアプリのように送信時刻と日付の区切りを出す。
    const realTimeMode = isGroupRoom ? situation?.realTimeMode : character?.realTimeMode;
    const showsMessageTimes = isMessageMode && !!realTimeMode && realTimeMode !== 'off';
    const messageTimeLabels = useMemo(
        () => showsMessageTimes ? buildMessageTimeLabels(pacedDisplayMessages) : undefined,
        [pacedDisplayMessages, showsMessageTimes],
    );
    const pacedStreamingAwaiting: ChatStreamingAwaitingStatus | null = !replyPacingEnabled
        ? streamingAwaiting
        : !replyPacing.typingVisible
            ? null
            : replyBubbles[replyPacing.revealedCount]?.awaiting
                ?? streamingAwaiting
                ?? { character: isGroupRoom ? null : character };

    const handleStop = () => {
        if (stopTypewriter(true)) {
            return;
        }

        if (room) {
            if (pendingRepliesRef.current.has(room.id) && !hasGenerationSession(room.id)) {
                // 待ち時間中の停止は返信待ちだけを取り消す。送信済みのメッセージは残す。
                takePendingReply(room.id);
                return;
            }
            void cancelGenerationSession(room.id);
        }
        setIsSummarizing(false);
    };

    const generateRustTurn = async (
        session: ChatGenerationSession,
        sourceRoom: Room,
        generationMode: ChatGenerationMode = 'reply',
        context: ChatGenerationContext = currentGenerationContext,
    ): Promise<ChatGenerationResult> => {
        const {
            character: contextCharacter,
            situation: contextSituation,
            groupCharacters: contextGroupCharacters,
            isSecretMode: contextSecretMode,
        } = context;
        const abortedResult = (): ChatGenerationResult => ({
            status: 'aborted',
            retainedMessages: hasRetainedCancelledMessages(
                cancelledJobResultsRef.current.get(session.jobId),
            ),
        });
        // ユーザー停止では、キャンセルされたジョブが保持したターンの適用が
        // 裏で進んでいる。完了前にロールバックすると古い履歴読込が復元結果を
        // 上書きするので、先に適用の終了を待つ。
        const finalizeAbortedResult = async (): Promise<ChatGenerationResult> => {
            await pendingCancelledAppliesRef.current.get(session.roomId);
            return abortedResult();
        };
        if (!isGenerationSessionActive(session)) return finalizeAbortedResult();
        session.generationBaselineMessageIds = sourceRoom.messages.map((message) => message.id);
        session.continuationBaseMessageId = generationMode === 'continue'
            ? getLatestActiveChatMessage(sourceRoom.messages)?.id
            : undefined;
        if (generationMode === 'reply') {
            // AIが読み始めた時点で、末尾の連投を既読にする。
            markMessagesRead(getTrailingUserMessageIds(sourceRoom.messages));
        }
        let keepStreamingPreview = false;
        setStreamingPreview((current) => current?.roomId === sourceRoom.id ? null : current);

        const controller = new AbortController();
        if (!attachGenerationController(session, controller)) {
            return finalizeAbortedResult();
        }

        try {
            const accepted = await submitConversationJob<RustTurnResponse>({
                    jobId: session.jobId,
                    room: toConversationRoom(sourceRoom),
                    character: toConversationCharacter(contextCharacter),
                    situation: toConversationSituation(contextSituation),
                    groupCharacters: contextGroupCharacters?.map(toConversationParticipant),
                    messages: capMessageAttachmentData(sourceRoom.messages),
                    secretMode: contextSecretMode,
                    summaryModel: serializeModelRef(globalSummaryModel),
                    conversationCompressionEnabled,
                    memoryGateModel: serializeModelRef(memoryGateModel),
                    memoryGateEnabled,
                    memoryBatchUserTurns,
                    memoryExtractionModel: serializeModelRef(memoryExtractionModel),
                    memoryEmbeddingModel: serializeModelRef(memoryEmbeddingModel),
                    reasoningEffort,
                    chatSampling,
                    wordReplacements: activeWordReplacements(wordReplacements),
                    aiApiConfig: getAiApiConfig(),
                    streamingPreview: true,
                    generationMode,
                }, controller.signal);
            if (!isGenerationSessionActive(session) || controller.signal.aborted) {
                throw new DOMException('Generation stopped', 'AbortError');
            }
            session.jobId = accepted.jobId;
            const job = accepted.status === 'running'
                ? await pollConversationJob(session, controller)
                : accepted;
            if (job.status === 'cancelled') {
                if (!session.cancelled) {
                    await handleCancelledJobResult(job.jobId, job.partialResult, sourceRoom).catch((error) => {
                        console.warn('Cancelled conversation result handling failed:', error);
                    });
                }
                return finalizeAbortedResult();
            }
            if (job.status === 'failed') {
                recordJobDebugLogs(job.partialResult, sourceRoom, contextSecretMode);
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
                    isSecretMode: contextSecretMode,
                    debugEnabled: fullJsonDebugEnabled,
                },
                {
                    updateRoomSummary,
                    compressRoomHistory,
                    isGenerationActive: () =>
                        isGenerationSessionActive(session) && !controller.signal.aborted,
                    addMessage,
                    rememberStreamedFinalMessageIds,
                    refreshConversationRoom,
                    clearStreamingPreview: isVisualNovelMode
                        ? () => undefined
                        : clearStreamingPreview,
                    addFullJsonDebugLog,
                    getCurrentRoom,
                },
            );
            keepStreamingPreview = isVisualNovelMode
                && appliedResult.assistantMessageIds.length > 0;
            resumedJobsRef.current.add(session.jobId);
            return {
                status: 'success',
                message: appliedResult.message,
            };
        } catch (error) {
            await pendingCancelledAppliesRef.current.get(session.roomId);
            if (error instanceof Error && error.name === 'AbortError') {
                return session.detached
                    ? { status: 'detached' }
                    : abortedResult();
            }
            logChatError('Rust conversation turn failed:', error);
            return { status: 'error', error };
        } finally {
            if (!keepStreamingPreview) clearStreamingPreview(session.jobId);
            clearGenerationController(session, controller);
        }
    };

    const handleContinue = async () => {
        const latestRoom = getCurrentRoom();
        const continuationBlocked = isLoading
            || isSummarizing
            || situationVnPresentation.locked
            || isEditingMessage;
        if (
            !latestRoom
            || !isChatContinuationAvailable({
                input,
                hasAttachments: isBasicMode && attachments.length > 0,
                messages: latestRoom.messages,
                blocked: continuationBlocked,
            })
        ) return;
        if (!isGroupRoom && !character) return;
        if (isGroupRoom && (!groupCharacters || groupCharacters.length === 0)) return;

        dismissChatNotice();
        setReplySuggestionState(null);
        takePendingReply(latestRoom.id);
        const endTurnFlow = beginTurnFlow(latestRoom.id);
        const session = startGenerationSession(latestRoom.id);
        let generationResult: ChatGenerationResult;
        try {
            generationResult = await generateRustTurn(session, latestRoom, 'continue');
        } finally {
            finishGenerationSession(session);
            setIsSummarizing(false);
            endTurnFlow();
        }

        if (
            generationResult.status === 'error'
            && generationResult.error
            && getCurrentRoom()?.id === latestRoom.id
        ) {
            if (isRetryableGenerationError(generationResult.error)) {
                retrySubmissionRef.current = {
                    kind: 'continue',
                    roomId: latestRoom.id,
                };
                showChatErrorNotice(generationResult.error, { type: 'retry', label: '再試行' });
            } else {
                showChatErrorNotice(generationResult.error);
            }
        }
    };

    /**
     * 末尾の連投へ返信を生成する。送信済みのユーザー発言は失敗しても消さず、
     * 再試行（または追加の送信）で返信を作り直せるようにする。
     */
    const generatePendingReply = async (
        roomId: string,
        sourceRoom: Room,
        context: ChatGenerationContext,
        { generateTitle = false, originalRoomName = sourceRoom.name }: {
            generateTitle?: boolean;
            originalRoomName?: string;
        } = {},
    ) => {
        if (!hasUnansweredUserMessages(sourceRoom.messages)) {
            void clearPendingReplyMarker(roomId).catch((error) => {
                console.warn('Pending reply marker cleanup failed:', error);
            });
            return;
        }
        const endTurnFlow = beginTurnFlow(roomId);
        const session = startGenerationSession(roomId);
        // 生成が始まればジョブ側で再開・復元できるので、返信待ちの印は外す。
        void clearPendingReplyMarker(roomId).catch((error) => {
            console.warn('Pending reply marker cleanup failed:', error);
        });
        let result: ChatGenerationResult;
        try {
            result = await generateRustTurn(session, sourceRoom, 'reply', context);
        } finally {
            finishGenerationSession(session);
            setIsSummarizing(false);
            endTurnFlow();
        }
        if (result.status === 'success') {
            if (generateTitle) void generateInitialRoomTitle(roomId, originalRoomName);
            return;
        }
        if (result.status !== 'error' || !result.error || getCurrentRoom()?.id !== roomId) return;
        if (isRetryableGenerationError(result.error)) {
            retrySubmissionRef.current = { kind: 'reply', roomId };
            showChatErrorNotice(result.error, { type: 'retry', label: '再試行' });
        } else {
            showChatErrorNotice(result.error);
        }
    };

    // 待ち時間が切れた（または部屋を離れた）ときに返信待ちを生成へ進める。
    // タイマーから呼ばれるので、最新の描画の値を使えるよう ref に入れておく。
    const runPendingReply = (roomId: string) => {
        const entry = pendingRepliesRef.current.get(roomId);
        if (!entry) return;
        if (hasGenerationSession(roomId) || interruptChainsRef.current.has(roomId)) {
            // 別の生成（再開したジョブなど）や割り込みの後始末が終わるまで待つ。
            startPendingReplyTimer(roomId, entry);
            return;
        }
        takePendingReply(roomId, { clearMarker: false });
        const latestRoom = getCurrentRoom();
        const isActiveRoom = latestRoom?.id === roomId
            && useStore.getState().loadingRoomHistoryId !== roomId;
        void generatePendingReply(
            roomId,
            isActiveRoom ? latestRoom : entry.room,
            isActiveRoom ? currentGenerationContextRef.current : entry.context,
            { generateTitle: entry.generateTitle, originalRoomName: entry.originalRoomName },
        ).catch((error) => {
            logChatError('Pending reply generation failed:', error);
        });
    };
    useEffect(() => {
        runPendingReplyRef.current = runPendingReply;
    });

    /** 返信待ちを飛ばして、末尾の連投へすぐに返信させる。 */
    const requestReplyNow = async () => {
        const latestRoom = getCurrentRoom();
        if (!latestRoom || hasGenerationSession(latestRoom.id) || isSummarizing) return;
        if (!hasUnansweredUserMessages(latestRoom.messages)) return;
        dismissChatNotice();
        setReplySuggestionState(null);
        const entry = takePendingReply(latestRoom.id, { clearMarker: false });
        await generatePendingReply(latestRoom.id, latestRoom, currentGenerationContext, {
            generateTitle: entry?.generateTitle,
            originalRoomName: entry?.originalRoomName,
        });
    };

    const waitForTurnFlowsToSettle = async (roomId: string) => {
        const startedAt = Date.now();
        while (
            (turnFlowsRef.current.has(roomId) || hasGenerationSession(roomId))
            && Date.now() - startedAt < INTERRUPT_IDLE_TIMEOUT_MS
        ) {
            await new Promise((resolve) => setTimeout(resolve, INTERRUPT_IDLE_POLL_MS));
        }
    };

    /**
     * 生成中の送信（割り込み）。実行中の生成を止め、画面に確定済みとして
     * 見えていた吹き出しは残してから、新しい発言を受け付ける。
     */
    const interruptGeneration = async (roomId: string, messageMode: boolean) => {
        const preview = streamingPreviewRef.current?.roomId === roomId
            ? streamingPreviewRef.current
            : null;
        const retainedBubbles = collectRetainedPreviewBubbles(preview, messageMode);
        // 編集・再生成のジョブは、止めると元の発言へ戻すので吹き出しは残さない。
        const restoresPreviousTurn = preview
            ? (await getPendingTurnRestore(roomId).catch(() => undefined))?.jobId === preview.jobId
            : false;
        const cancelled = await cancelGenerationSession(roomId);
        await waitForTurnFlowsToSettle(roomId);
        await pendingCancelledAppliesRef.current.get(roomId);
        if (
            cancelled
            && cancelled.status !== 'completed'
            && !restoresPreviousTurn
            && !hasRetainedCancelledMessages(cancelled.partialResult as RustTurnResponse | undefined)
        ) {
            retainedBubbles.forEach((bubble, index) => {
                addMessage(
                    roomId,
                    'assistant',
                    bubble.content,
                    bubble.characterId,
                    index === 0 && preview?.continuationOfMessageId
                        ? { continuesPrevious: true }
                        : undefined,
                );
            });
        }
        if (preview) clearStreamingPreview(preview.jobId);
    };

    /** 返信待ちの列へ発言を加える。生成中なら割り込んでから加える。 */
    const submitToReplyQueue = async ({
        roomId,
        content,
        attachments: messageAttachments,
        context,
        generateTitle,
        originalRoomName,
    }: {
        roomId: string;
        content: string;
        attachments?: MessageAttachment[];
        context: ChatGenerationContext;
        generateTitle: boolean;
        originalRoomName: string;
    }) => {
        const messageMode = isMessageMode;
        // 直後の送信では入力欄を空にしたばかりなので下書きなしとして扱う。割り込みの
        // 後始末を待った場合は、その間に打ち始めた下書きを ref から読む。
        const appendAndSchedule = (hasDraft?: boolean) => {
            addMessage(
                roomId,
                'user',
                content,
                undefined,
                messageAttachments ? { attachments: messageAttachments } : undefined,
            );
            const state = useStore.getState();
            const roomAfterUserMessage = state.rooms.find((candidate) => candidate.id === roomId);
            if (!roomAfterUserMessage) return;
            if (state.currentRoomId !== roomId || state.loadingRoomHistoryId === roomId) {
                // 割り込みの後始末中に部屋を離れた場合、ストア上の履歴は不完全なので
                // ここでは生成しない。返信待ちの印を残し、部屋を開き直したときに再開する。
                if (roomAfterUserMessage.secretMode !== true) {
                    void savePendingReplyMarker(roomId).catch((error) => {
                        console.warn('Pending reply marker save failed:', error);
                    });
                }
                return;
            }
            schedulePendingReply(roomId, {
                room: roomAfterUserMessage,
                context,
                generateTitle,
                originalRoomName,
            }, hasDraft);
        };
        const previous = interruptChainsRef.current.get(roomId);
        if (!previous && !hasGenerationSession(roomId) && !turnFlowsRef.current.has(roomId)) {
            appendAndSchedule(false);
            return;
        }
        const step = (previous ?? Promise.resolve())
            .then(async () => {
                if (hasGenerationSession(roomId)) {
                    await interruptGeneration(roomId, messageMode);
                } else {
                    await waitForTurnFlowsToSettle(roomId);
                }
                appendAndSchedule();
            })
            .catch((error) => {
                logChatError('Interrupting generation failed:', error);
                appendAndSchedule();
            });
        interruptChainsRef.current.set(roomId, step);
        try {
            await step;
        } finally {
            if (interruptChainsRef.current.get(roomId) === step) {
                interruptChainsRef.current.delete(roomId);
            }
        }
    };

    const handleSubmit = async (
        e?: React.FormEvent,
        editDraft?: EditingMessageDraft,
        suggestedReply?: string,
        inputOverride?: string,
        attachmentsOverride?: MessageAttachment[],
    ) => {
        e?.preventDefault();
        const submittedInput = suggestedReply ?? editDraft?.content ?? inputOverride ?? input;
        const submittedAttachments = suggestedReply
            ? []
            : editDraft
                ? (editDraft.attachments ?? [])
                : (isBasicMode ? (attachmentsOverride ?? attachments) : []);
        const hasSubmittedAttachments = submittedAttachments.length > 0;
        // 待ち時間つきの送信と割り込みはメッセージ・ベーシックモードの通常送信だけ。
        // 編集の送信は従来どおりすぐに返信を作り直す。
        const queueReply = !editDraft && usesReplyQueue && (replyDelayMs > 0 || isLoading);
        if (
            (!submittedInput.trim() && !hasSubmittedAttachments)
            || !room
            || (isLoading && !queueReply)
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

        if (queueReply) {
            dismissChatNotice();
            setReplySuggestionState(null);
            setInput('');
            if (!suggestedReply) {
                attachmentReadSessionRef.current += 1;
                setAttachments([]);
            }
            await submitToReplyQueue({
                roomId: room.id,
                content: userMessage,
                attachments: hasSubmittedAttachments ? submittedAttachments : undefined,
                context: currentGenerationContext,
                generateTitle: shouldGenerateTitleAfterFirstReply,
                originalRoomName,
            });
            return;
        }
        let editCutIndex = -1;
        let editTargetsCompressedHistory = false;
        let editDeletedMessages: Message[] = [];
        let editDeletedMemories: MemoryRecord[] = [];
        let editCompressionSnapshot: RoomCompressionSnapshot | null = null;
        let editFollowingRunMessages: Message[] = [];

        if (editDraft) {
            const latestRoom = getCurrentRoom();
            if (latestRoom?.id !== room.id) return;
            editCutIndex = latestRoom.messages.findIndex((message) =>
                message.id === editDraft.messageId &&
                message.role === 'user'
            );
            if (editCutIndex < 0) {
                showChatNotice('編集対象のメッセージが見つかりませんでした。');
                setEditingMessage(null);
                return;
            }
            editTargetsCompressedHistory = latestRoom.messages[editCutIndex].archived === true;
            editDeletedMessages = latestRoom.messages.slice(editCutIndex);
            // 連投の途中を編集しても、同じ連投の後続メッセージは消さずに残す。
            const run = getUserMessageRunRange(latestRoom.messages, editCutIndex);
            editFollowingRunMessages = run
                ? latestRoom.messages.slice(editCutIndex + 1, run.end)
                : [];
        }

        dismissChatNotice();
        setReplySuggestionState(null);
        // 編集・通常送信のどちらでもこの送信で返信を作るので、返信待ちは不要になる。
        takePendingReply(room.id);
        const endTurnFlow = beginTurnFlow(room.id);
        const session = startGenerationSession(room.id);
        const canRestoreTurn = room.secretMode !== true && room.isDraft !== true;
        // 生成が完了・中断・失敗として確定したときだけスナップショットを捨てる。
        // detached（コンポーネントのアンマウント）や予期しない例外ではジョブが
        // 継続しているので、再開・掃討処理が使えるよう残しておく。
        let turnSettled = false;
        try {
            if (editDraft) {
                if (editTargetsCompressedHistory) {
                    editCompressionSnapshot = await rewindRoomCompression(room.id);
                }
                // 生成完了前にリロードされると実行中の関数ごと復元データが
                // 消えるので、削除前にスナップショットを永続化しておく。
                if (canRestoreTurn) {
                    await savePendingTurnRestore({
                        jobId: session.jobId,
                        roomId: room.id,
                        fromIndex: editCutIndex,
                        messages: editDeletedMessages,
                        memories: [],
                        compressionSnapshot: editCompressionSnapshot,
                        createdAt: Date.now(),
                    }).catch((error) => {
                        console.warn('Pending turn restore save failed:', error);
                    });
                }
                editDeletedMemories = await deleteMessagesFrom(room.id, editCutIndex);
                if (canRestoreTurn) {
                    await savePendingTurnRestore({
                        jobId: session.jobId,
                        roomId: room.id,
                        fromIndex: editCutIndex,
                        messages: editDeletedMessages,
                        memories: editDeletedMemories,
                        compressionSnapshot: editCompressionSnapshot,
                        createdAt: Date.now(),
                    }).catch((error) => {
                        console.warn('Pending turn restore save failed:', error);
                    });
                }
                setEditingMessage(null);
            } else {
                setInput('');
                if (!suggestedReply) {
                    attachmentReadSessionRef.current += 1;
                    setAttachments([]);
                }
            }

            const userMessageId = addMessage(
                room.id,
                'user',
                userMessage,
                undefined,
                hasSubmittedAttachments ? { attachments: submittedAttachments } : undefined,
            );
            for (const following of editFollowingRunMessages) {
                addMessage(
                    room.id,
                    'user',
                    following.content,
                    undefined,
                    following.attachments?.length ? { attachments: following.attachments } : undefined,
                );
            }

            const roomAfterUserMessage = getCurrentRoom();
            if (!roomAfterUserMessage) return;

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
                    if (editCompressionSnapshot) {
                        await restoreRoomCompression(room.id, editCompressionSnapshot);
                    }
                    return;
                }

                const isCurrentRoomActive = await removeSubmittedUserMessage(
                    { roomId: room.id, messageId: userMessageId },
                    { getCurrentRoom, deleteMessagesFrom },
                );
                if (isCurrentRoomActive) {
                    setInput(submittedInput);
                    if (!suggestedReply && hasSubmittedAttachments) {
                        setAttachments(submittedAttachments);
                    }
                    if (suggestedReply && previousReplySuggestionState?.roomId === room.id) {
                        setInput('');
                        setReplySuggestionState(previousReplySuggestionState);
                    }
                }
            };

            const generationResult = await generateRustTurn(session, roomAfterUserMessage);

            // A stopped turn keeps whatever the job retained: the submitted user
            // message and any applied replies stay instead of being rolled back.
            if (generationResult.status === 'aborted') {
                turnSettled = true;
                if (!editDraft) {
                    setTimeout(() => textareaRef.current?.focus(), 50);
                }
                return;
            }

            if (generationResult.status === 'error') {
                await rollbackSubmittedTurn();
                turnSettled = true;
                if (!editDraft) {
                    setTimeout(() => textareaRef.current?.focus(), 50);
                }

                if (generationResult.error && getCurrentRoom()?.id === room.id) {
                    if (isRetryableGenerationError(generationResult.error)) {
                        retrySubmissionRef.current = {
                            kind: 'submit',
                            roomId: room.id,
                            input: userMessage,
                            attachments: !editDraft && !suggestedReply && hasSubmittedAttachments
                                ? submittedAttachments
                                : undefined,
                            editDraft: editDraft ? { ...editDraft, content: submittedInput } : undefined,
                            suggestedReply,
                        };
                        showChatErrorNotice(generationResult.error, { type: 'retry', label: '再試行' });
                    } else {
                        showChatErrorNotice(generationResult.error);
                    }
                }
                return;
            }
            if (generationResult.status === 'success') {
                turnSettled = true;
                if (shouldGenerateTitleAfterFirstReply) {
                    void generateInitialRoomTitle(room.id, originalRoomName);
                }
            }
        } finally {
            finishGenerationSession(session);
            setIsSummarizing(false);
            endTurnFlow();
            if (turnSettled) {
                void clearPendingTurnRestore(room.id, session.jobId).catch((error) => {
                    console.warn('Pending turn restore cleanup failed:', error);
                });
            }
        }
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
        const retryPromise = retry.kind === 'continue'
            ? handleContinue()
            : retry.kind === 'reply'
                ? requestReplyNow()
                : handleSubmit(undefined, retry.editDraft, retry.suggestedReply, retry.input, retry.attachments);
        void retryPromise
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

        takePendingReply(room.id);
        const endTurnFlow = beginTurnFlow(room.id);
        const session = startGenerationSession(room.id);
        const canRestoreTurn = room.secretMode !== true && room.isDraft !== true;
        let turnSettled = false;
        try {
            // 生成完了前にリロードされると実行中の関数ごと復元データが消える
            // ので、削除前にスナップショットを永続化しておく。
            if (canRestoreTurn) {
                await savePendingTurnRestore({
                    jobId: session.jobId,
                    roomId: room.id,
                    fromIndex: cutFrom,
                    messages: messagesToDelete,
                    memories: [],
                    compressionSnapshot: null,
                    createdAt: Date.now(),
                }).catch((error) => {
                    console.warn('Pending turn restore save failed:', error);
                });
            }
            const removedMemoryRecords = await deleteMessagesFrom(room.id, cutFrom);
            if (canRestoreTurn) {
                await savePendingTurnRestore({
                    jobId: session.jobId,
                    roomId: room.id,
                    fromIndex: cutFrom,
                    messages: messagesToDelete,
                    memories: removedMemoryRecords,
                    compressionSnapshot: null,
                    createdAt: Date.now(),
                }).catch((error) => {
                    console.warn('Pending turn restore save failed:', error);
                });
            }
            // 削除の待機中に表示中の部屋が変わっていても、生成は必ず開始時の
            // 部屋を対象にする。別の部屋へ生成するとその部屋を壊した上に、
            // 元の部屋の応答は消えたまま残ってしまう。
            const result: ChatGenerationResult = await generateRustTurn(session, {
                ...room,
                messages: room.messages.slice(0, cutFrom),
            });
            // Keep turns the cancelled job retained; only a bare abort (or a
            // failure) rolls the pre-regeneration messages back in.
            const shouldRollBack = result.status === 'error'
                || (result.status === 'aborted' && !result.retainedMessages);
            if (shouldRollBack) {
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
            // detached はジョブが継続中なので、復元スナップショットは
            // 再開・掃討処理が使えるよう残しておく。
            turnSettled = result.status !== 'detached';
        } finally {
            finishGenerationSession(session);
            setIsSummarizing(false);
            endTurnFlow();
            if (turnSettled) {
                void clearPendingTurnRestore(room.id, session.jobId).catch((error) => {
                    console.warn('Pending turn restore cleanup failed:', error);
                });
            }
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

    const handleEditMessage = useCallback((messageId: string) => {
        if (isLoading || isSummarizing || !room) return;
        const latestRoom = getCurrentRoom();
        const latestMessage = latestRoom?.id === room.id
            ? latestRoom.messages.find((message) => message.id === messageId)
            : null;
        if (!latestMessage) return;
        setEditingMessage({
            roomId: room.id,
            messageId,
            role: latestMessage.role,
            content: latestMessage.content,
            attachments: latestMessage.attachments,
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
        if (editingMessage.role === 'assistant') {
            const content = editingMessage.content.trim();
            if (!content || isLoading || isSummarizing) return;
            updateAssistantMessageContent(room.id, editingMessage.messageId, content);
            setEditingMessage(null);
            return;
        }
        void handleSubmit(undefined, editingMessage);
    };

    const handleSubmitEditMessageFromVnLog = () => {
        // ユーザー発言を送り直すときは、返信が見えるようにゲーム画面へ戻る。
        if (editingMessage?.role === 'user') setVnLogOpen(false);
        handleSubmitEditMessage();
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

    const latestAssistantMessage = useMemo(() => {
        for (let i = processedMessages.length - 1; i >= 0; i--) {
            const message = processedMessages[i];
            if (message.role === 'assistant' && !message.isArchived) return message;
        }
        return null;
    }, [processedMessages]);

    // 返信を受けた発言と、AIが読み始めた末尾の連投。メッセージモードでのみ「既読」を付ける。
    // まだ見せていない返信は「返信を受けた」扱いにせず、既読も少し間を置いてから付ける。
    // 割り込み送信などで既に既読を見せた発言は、そのまま既読にしておく。
    const [shownReadUserMessageIds, setShownReadUserMessageIds] = useState<ReadonlySet<string>>(() => new Set());
    const readUserMessageIds = useMemo(() => {
        if (!isMessageMode || !room) return new Set<string>();
        const visibleMessages = heldReplyKeys.size === 0
            ? room.messages
            : room.messages.filter((message) => !heldReplyKeys.has(message.id));
        const read = getReadUserMessageIds(visibleMessages, readMessageIds);
        if (!replyPacing.readVisible) {
            for (const id of getTrailingUserMessageIds(visibleMessages)) {
                if (!shownReadUserMessageIds.has(id)) read.delete(id);
            }
        }
        return read;
    }, [heldReplyKeys, readMessageIds, replyPacing.readVisible, room, isMessageMode, shownReadUserMessageIds]);
    useEffect(() => {
        setShownReadUserMessageIds((current) => (
            current.size === readUserMessageIds.size && [...readUserMessageIds].every((id) => current.has(id))
                ? current
                : readUserMessageIds
        ));
    }, [readUserMessageIds]);

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
    // ゲームモードでは表示中のページだけを読み上げる。メッセージ全文を読むと
    // 未表示のページまで先読みしてしまうため。
    const vnTtsItem = useMemo<VisualNovelTtsItem | null>(() => {
        if (!isVisualNovelMode || isVisualNovelLogOpen || !situationVnCurrentItem) return null;
        return {
            key: getSituationVisualNovelTypingKey(situationVnCurrentItem),
            role: situationVnCurrentItem.role,
            content: situationVnCurrentItem.content,
            characterId: situationVnCurrentItem.characterId,
            final: situationVnCurrentItem.source !== 'preview' || situationVnCurrentItem.streamingComplete === true,
        };
    }, [isVisualNovelMode, isVisualNovelLogOpen, situationVnCurrentItem]);
    const situationVnNextItem = situationVnPresentation.pending[0] ?? null;
    const vnTtsNextItem = useMemo<VisualNovelTtsItem | null>(() => {
        if (!isVisualNovelMode || isVisualNovelLogOpen || !situationVnNextItem) return null;
        return {
            key: getSituationVisualNovelTypingKey(situationVnNextItem),
            role: situationVnNextItem.role,
            content: situationVnNextItem.content,
            characterId: situationVnNextItem.characterId,
            final: situationVnNextItem.source !== 'preview' || situationVnNextItem.streamingComplete === true,
        };
    }, [isVisualNovelMode, isVisualNovelLogOpen, situationVnNextItem]);
    const { playMessage: playTtsMessage, playVisualNovelItem: playTtsVisualNovelItem } = useTtsPlayback({
        roomId: currentRoomId,
        messages: pacedDisplayMessages,
        isLoading,
        isRoomHistoryLoading: loadingRoomHistoryId === currentRoomId,
        notify: showChatNotice,
        visualNovelMode: isVisualNovelMode,
        visualNovelItem: vnTtsItem,
        visualNovelNextItem: vnTtsNextItem,
    });
    const vnTtsStatus = useTtsEntry(vnTtsItem?.key ?? '').status;
    const canPlayVnTts = useMemo(() => (
        ttsEnabled
        && !!vnTtsItem
        && vnTtsItem.role === 'assistant'
        && vnTtsItem.final
        && (isNarratorCharacterId(vnTtsItem.characterId)
            ? buildNarrationSpeechSegments(vnTtsItem.content, ttsNarrationEnabled).length > 0
            : !!buildSpeechText(vnTtsItem.content, ttsNarrationEnabled))
    ), [vnTtsItem, ttsEnabled, ttsNarrationEnabled]);
    useVisualNovelAutoPlay({
        enabled: vnAutoPlay && isVisualNovelMode && !isVisualNovelLogOpen,
        canAdvance: situationVnPresentation.canAdvance,
        isTypewriterActive,
        ttsItemKey: vnTtsItem?.key,
        contentLength: situationVnCurrentItem?.content.length ?? 0,
        onAdvance: situationVnPresentation.advanceDialogue,
    });
    const situationVnSceneCharacter = situationVnPresentation.sceneCharacterId && characterMap
        ? characterMap.get(situationVnPresentation.sceneCharacterId) ?? null
        : null;
    const vnCharacter = isSituationVisualNovelMode
        ? situationVnSceneCharacter ?? situationVnInitialCharacter
        : soloVnCharacter;

    const vnSelectedCostumeId = useMemo(
        () => resolveVisualNovelCostumeId(room, vnCharacter),
        [room, vnCharacter],
    );
    const vnCostumeOptions = useMemo(
        () => getVisualNovelCostumeOptions(vnCharacter),
        [vnCharacter],
    );

    const vnExpressionImage = useMemo(
        () => resolveVisualNovelExpressionImage(
            vnCharacter,
            situationVnPresentation.sceneExpression ?? null,
            vnSelectedCostumeId,
        ),
        [
            situationVnPresentation.sceneExpression,
            vnCharacter,
            vnSelectedCostumeId,
        ],
    );
    // ナレーションでは立ち絵のキャラクターが話しているわけではないので跳ねさせない。
    const situationVnAssistantBounceKey = situationVnCurrentItem?.role === 'assistant'
        && !isNarrationMessage(situationVnCurrentItem)
        ? situationVnCurrentItem.utteranceKey ?? `${situationVnCurrentItem.source}:${situationVnCurrentItem.id}`
        : null;
    const vnBounceContextKey = isVisualNovelMode && !isVisualNovelLogOpen && currentRoomId
        ? `${currentRoomId}:${isSituationVisualNovelMode ? 'situation' : 'solo'}`
        : null;
    const vnBounceMessageKey = situationVnAssistantBounceKey;

    const vnWaitingForSentence = isVisualNovelMode
        && situationVnCurrentItem?.source === 'preview'
        && !situationVnCurrentItem.content.trim();
    useLayoutEffect(() => {
        if (vnWaitingForSentence && previousVnBounceSnapshotRef.current?.contextKey === vnBounceContextKey) return;
        const current: VisualNovelBounceSnapshot = {
            contextKey: vnBounceContextKey,
            messageKey: vnWaitingForSentence ? null : vnBounceMessageKey,
        };
        const previous = previousVnBounceSnapshotRef.current;
        previousVnBounceSnapshotRef.current = current;

        if (previous?.contextKey !== current.contextKey || current.messageKey == null) {
            stopVnBounce();
        }
        if (shouldTriggerVisualNovelBounce(previous, current)) {
            triggerVnBounce();
        }
    }, [
        stopVnBounce,
        triggerVnBounce,
        vnBounceContextKey,
        vnBounceMessageKey,
        vnWaitingForSentence,
    ]);

    const lastRoomMessage = room
        ? getLatestActiveChatMessage(room.messages)
        : undefined;
    const isWaitingForAssistant = isVisualNovelMode
        ? situationVnPresentation.isWaitingForResponse
        : isLoading && lastRoomMessage?.role !== 'assistant' && !activeStreamingPreview;
    const situationVnItemContent = situationVnCurrentItem
        ? getSituationVisualNovelTypingKey(situationVnCurrentItem) === typingMessageId
            ? typedContent
            : situationVnPresentation.currentComplete
                ? situationVnCurrentItem.content
                : ''
        : '';
    const situationVnDialogueContent = situationVnCurrentItem
        ? isNarrationMessage(situationVnCurrentItem)
            ? wrapNarrationForDialogue(situationVnItemContent)
            : situationVnCurrentItem.role === 'assistant'
                ? hideAssistantDialogueBrackets(situationVnItemContent)
                : situationVnItemContent
        : isWaitingForAssistant
            ? '...'
            : '...（話しかけてみよう）';
    const vnDialogueContent = situationVnPresentation.waitingForNextPage
        ? `${situationVnDialogueContent}\n\n…`
        : situationVnDialogueContent;
    const vnProcessedDialogueContent = useMemo(() => formatAssistantMarkdown(vnDialogueContent), [vnDialogueContent]);
    const situationVnShowsLatestAssistant = situationVnCurrentItem?.source === 'room'
        && situationVnCurrentItem.role === 'assistant'
        && situationVnCurrentItem.id === latestAssistantMessage?.id;
    const showSituationVnAdvanceIndicator = isVisualNovelMode
        && !isTypewriterActive
        && !situationVnPresentation.waitingForNextPage
        && situationVnPresentation.current != null
        && situationVnPresentation.currentComplete
        && !!situationVnPresentation.pending[0]?.content.trim();
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
            : situationVnCurrentItem && isNarrationMessage(situationVnCurrentItem)
                ? NARRATOR_DISPLAY_NAME
            : situationVnCurrentItem?.role === 'assistant'
                ? (situationVnCurrentItem.characterId && characterMap?.get(situationVnCurrentItem.characterId)?.name)
                    ?? situationVnCurrentItem.characterName
                    ?? '?'
                : ''
        : undefined;
    const vnDisplayedMessageId = situationVnCurrentItem?.key;
    const vnDisplayedMessageContent = situationVnCurrentItem?.content;
    const situationVnCastCharacters = isSituationVisualNovelMode
        && !vnCharacter
        && situationVnCurrentItem?.role !== 'assistant'
        ? groupCharacters ?? []
        : undefined;

    // ナレーションの間は誰も話していないので、どの立ち絵も強調しない。
    const vnActiveSpriteId = situationVnCurrentItem && isNarrationMessage(situationVnCurrentItem)
        ? undefined
        : situationVnPresentation.sceneCharacterId ?? situationVnInitialCharacterId;

    // 表示人数の上限を超える場合は、直近に話したキャラだけを舞台に残す。
    const vnStageParticipantIds = useMemo(
        () => (groupCharacters ?? []).map((participant) => participant.id),
        [groupCharacters],
    );
    const [vnStageRosterState, setVnStageRosterState] = useState<{
        roomId?: string;
        roster: SituationVisualNovelStageRoster;
    }>({ roster: EMPTY_SITUATION_VISUAL_NOVEL_STAGE_ROSTER });
    const vnStageRosterBase = vnStageRosterState.roomId === currentRoomId
        ? vnStageRosterState.roster
        : EMPTY_SITUATION_VISUAL_NOVEL_STAGE_ROSTER;
    const vnStageRoster = isSituationVisualNovelMode
        ? updateSituationVisualNovelStageRoster(
            vnStageRosterBase,
            vnStageParticipantIds,
            vnActiveSpriteId,
            vnMaxStageSprites,
        )
        : vnStageRosterBase;
    if (vnStageRosterState.roomId !== currentRoomId || vnStageRoster !== vnStageRosterState.roster) {
        setVnStageRosterState({ roomId: currentRoomId, roster: vnStageRoster });
    }
    const vnStageSlots = vnStageRoster.slots;

    const vnStageSprites = useMemo<VisualNovelStageSprite[] | undefined>(() => {
        if (!isSituationVisualNovelMode || !groupCharacters || groupCharacters.length === 0) {
            return undefined;
        }
        const expressions = situationVnPresentation.sceneExpressions ?? {};
        const sceneMotion = situationVnPresentation.sceneMotion;
        const participantsById = new Map(groupCharacters.map((participant) => [participant.id, participant]));
        const stageParticipants = vnStageSlots.flatMap((id) => {
            const participant = participantsById.get(id);
            return participant ? [participant] : [];
        });
        return stageParticipants.map((participant) => {
            const costumeId = resolveVisualNovelCostumeId(room, participant);
            const costume = findVisualNovelCostume(participant, costumeId);
            const vrm = costume?.kind === 'vrm' ? costume.vrm : undefined;
            const expression = expressions[participant.id] ?? null;
            return {
                id: participant.id,
                name: participant.name,
                image: vrm
                    ? costume?.image ?? null
                    : resolveVisualNovelExpressionImage(participant, expression, costumeId),
                expression,
                motion: sceneMotion?.characterId === participant.id
                    ? { name: sceneMotion.name, nonce: sceneMotion.nonce }
                    : undefined,
                vrm,
                vrmFallbackImage: costume?.image ?? null,
                active: vnActiveSpriteId != null && participant.id === vnActiveSpriteId,
                bounce: vnBounceActive && participant.id === vnActiveSpriteId,
            };
        });
    }, [
        groupCharacters,
        isSituationVisualNovelMode,
        room,
        situationVnPresentation.sceneExpressions,
        situationVnPresentation.sceneMotion,
        vnActiveSpriteId,
        vnBounceActive,
        vnStageSlots,
    ]);

    // Solo mode shows a single character, so the scene motion always targets it.
    const soloMotion = situationVnPresentation.sceneMotion
        ? {
            name: situationVnPresentation.sceneMotion.name,
            nonce: situationVnPresentation.sceneMotion.nonce,
        }
        : undefined;

    const vnStagePreloadSources = useMemo(() => {
        if (!vnStageSprites?.length) return undefined;
        const currentImages = new Set(vnStageSprites.map((sprite) => sprite.image).filter(Boolean));
        const sources: string[] = [];
        const seen = new Set<string>();
        for (const participant of groupCharacters ?? []) {
            const costumeId = resolveVisualNovelCostumeId(room, participant);
            for (const candidate of getVisualNovelPreloadCandidates(participant, costumeId, undefined, 8)) {
                if (!candidate || currentImages.has(candidate) || seen.has(candidate)) continue;
                seen.add(candidate);
                sources.push(candidate);
            }
        }
        return sources;
    }, [groupCharacters, room, vnStageSprites]);

    const handleEditLatestUserMessageInVn = useCallback(() => {
        if (!room || !latestEditableUserMessage || isLoading || isSummarizing) return;
        setEditingMessage({
            roomId: room.id,
            messageId: latestEditableUserMessage.id,
            role: 'user',
            content: latestEditableUserMessage.content,
            attachments: latestEditableUserMessage.attachments,
        });
        closeMention();
        setTouchedMessageId(null);
        setTimeout(() => textareaRef.current?.focus(), 0);
    }, [closeMention, isLoading, isSummarizing, latestEditableUserMessage, room]);

    const handleSelectVnCostume = (costumeId: string) => {
        if (!room || !vnCharacter || isSituationVisualNovelMode) return;
        const nextSelections = { ...(room.costumeSelections ?? {}) };
        // Selecting the default costume clears the choice so the room follows later default changes.
        if (resolveDefaultCostume(vnCharacter)?.id === costumeId) {
            delete nextSelections[vnCharacter.id];
        } else {
            nextSelections[vnCharacter.id] = costumeId;
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
            ? editingMessage?.role === 'assistant'
                ? '編集中のメッセージを保存してください'
                : '編集中のメッセージで送信してください'
            : '返信を入力';
    const situationVnInputLocked = isVisualNovelMode && situationVnPresentation.locked;
    const previousSituationVnInputLockedRef = useRef(situationVnInputLocked);
    // メッセージ・ベーシックモードでは生成中も入力・送信（割り込み）できる。
    const canInterruptGeneration = usesReplyQueue && !isEditingMessage;
    const inputLockedByGeneration = isLoading && !canInterruptGeneration;
    const chatInputDisabled = inputLockedByGeneration
        || isSummarizing
        || situationVnInputLocked
        || (isEditingMessage && !isInlineVnEditing);
    const activeAttachments = isBasicMode && !isEditingMessage ? attachments : [];
    const hasActiveAttachments = activeAttachments.length > 0;
    const hasChatDraft = !!input.trim() || hasActiveAttachments;
    const isReplyPending = !!currentRoomId && pendingReplyRoomIds.has(currentRoomId);
    const canContinue = isChatContinuationAvailable({
        input,
        hasAttachments: hasActiveAttachments,
        messages: room?.messages ?? EMPTY_MESSAGES,
        blocked: chatInputDisabled || isEditingMessage || isLoading,
    });
    // 返信待ちを取り消した後や返信に失敗した後は、空の入力で送ると返信を頼める。
    const canRequestReply = usesReplyQueue
        && !hasChatDraft
        && !isLoading
        && !isReplyPending
        && !isSummarizing
        && !isEditingMessage
        && hasUnansweredUserMessages(room?.messages ?? EMPTY_MESSAGES);
    const chatInputSubmitDisabled = chatInputDisabled || (isInlineVnEditing
        ? !editingMessage?.content.trim() && !(editingMessage?.attachments?.length)
        : (!hasChatDraft && !canContinue && !canRequestReply) || isEditingMessage);
    // 下書きがあるときは送信ボタン、無いときは停止ボタン（生成中・返信待ち中）を出す。
    const showStopButton = (isLoading && !(canInterruptGeneration && hasChatDraft))
        || isSummarizing
        || (situationVnInputLocked && isTypewriterActive)
        || (isReplyPending && !hasChatDraft && !isInlineVnEditing);

    const handleSelectAttachmentFiles = useCallback(async (files: File[]) => {
        if (!isBasicMode || chatInputDisabled) return;
        const readSession = attachmentReadSessionRef.current;
        const { attachments: added, errors } = await readChatAttachmentFiles(files, {
            existing: attachments,
        });
        // 読み込み中にルーム・表示モードが変わったり送信された場合は結果を捨てる。
        if (readSession !== attachmentReadSessionRef.current) return;
        if (added.length > 0) {
            setAttachments((current) => [...current, ...added]);
            // 添付の追加も入力中として返信を待たせる。
            if (currentRoomId) updatePendingReplyForDraft(currentRoomId, true);
        }
        if (errors.length > 0) {
            showChatNotice(errors[0]);
        }
    }, [attachments, chatInputDisabled, currentRoomId, updatePendingReplyForDraft, isBasicMode, showChatNotice]);

    const handleRemoveAttachment = useCallback((attachmentId: string) => {
        setAttachments((current) => current.filter((item) => item.id !== attachmentId));
        if (currentRoomId) {
            const remaining = attachments.filter((item) => item.id !== attachmentId).length;
            updatePendingReplyForDraft(currentRoomId, input.trim() !== '' || remaining > 0);
        }
    }, [attachments, currentRoomId, input, updatePendingReplyForDraft]);

    const handlePreviewAttachmentImage = useCallback((src: string, name: string) => {
        if (!src) return;
        setPreviewAttachmentImage({ src, name });
    }, []);

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
        && !hasActiveAttachments
        && (replySuggestionState.loading || replySuggestionState.suggestions.length === 3);
    const handleChatInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (isInlineVnEditing) {
            handleEditMessageChange(e.target.value);
        } else {
            handleInputChange(e);
            // 打っている間は設定した待ち時間だけ返信を待たせ、空に戻したら短い猶予で返信する。
            if (currentRoomId) {
                updatePendingReplyForDraft(
                    currentRoomId,
                    e.target.value.trim() !== '' || (isBasicMode && attachments.length > 0),
                );
            }
        }
    };
    const handleInsertAsterisk = () => {
        if (chatInputDisabled) return;
        const textarea = textareaRef.current;
        const selectionStart = textarea?.selectionStart ?? chatInputValue.length;
        const selectionEnd = textarea?.selectionEnd ?? selectionStart;
        const nextValue = `${chatInputValue.slice(0, selectionStart)}*${chatInputValue.slice(selectionEnd)}`;
        textarea?.focus();
        if (isInlineVnEditing) {
            handleEditMessageChange(nextValue);
        } else {
            setInput(nextValue);
            closeMention();
            if (currentRoomId) updatePendingReplyForDraft(currentRoomId, true);
        }
        setTimeout(() => {
            const inputElement = textareaRef.current;
            if (!inputElement) return;
            const nextCursorPosition = selectionStart + 1;
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

    const showChatWallpaper = !isVisualNovelMode && !!chatWallpaper;
    const vnBackgroundImage = situation?.backgroundImage || chatWallpaper;

    return (
        <div className={`chat-container ${isVisualNovelMode ? 'vn-mode' : ''} ${isMessageMode ? 'message-mode' : ''} ${showChatWallpaper ? 'has-wallpaper' : ''}`}>
            {isVisualNovelMode && vnBackgroundImage && (
                <VisualNovelBackground src={vnBackgroundImage} />
            )}
            {showChatWallpaper && (
                <div className="chat-wallpaper" aria-hidden="true">
                    <StoredImage
                        src={chatWallpaper}
                        alt=""
                        className="chat-wallpaper-image"
                        loading="eager"
                        fetchPriority="high"
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
                    typing={replyPacingEnabled ? replyPacing.typingVisible : isLoading && usesReplyQueue}
                    isMobile={isMobile}
                    onOpenSidebar={onOpenSidebar}
                    debugEnabled={debugPanelEnabled}
                    debugLogCount={visibleDebugLogCount}
                    runningBackgroundTaskCount={runningBackgroundTaskCount}
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
                    messages={displayMessages}
                    activeStreamingPreview={activeStreamingPreview}
                    streamingPreviewCharacter={streamingPreviewCharacter}
                    formattedStreamingPreviewMessages={formattedStreamingPreviewMessages}
                    continuationAppendPreviewKey={continuationAppendKey}
                    isLoading={isLoading}
                    isSummarizing={isSummarizing}
                    canEdit={
                        !isLoading
                        && !isSummarizing
                        && !branchingMessageId
                        && !situationVnPresentation.locked
                    }
                    editingMessage={
                        editingMessage?.roomId === room.id
                            ? {
                                messageId: editingMessage.messageId,
                                content: editingMessage.content,
                                hasAttachments: (editingMessage.attachments?.length ?? 0) > 0,
                            }
                            : null
                    }
                    onEdit={handleEditMessage}
                    onEditChange={handleEditMessageChange}
                    onCancelEdit={handleCancelEditMessage}
                    onSubmitEdit={handleSubmitEditMessageFromVnLog}
                    onClose={closeVisualNovelLog}
                />
            ) : isVisualNovelMode ? (
                <VisualNovelView
                    character={vnCharacter}
                    fallbackCharacterName={character?.name}
                    speakerName={vnSpeakerName}
                    castCharacters={situationVnCastCharacters}
                    stageSprites={vnStageSprites}
                    stagePreloadSources={vnStagePreloadSources}
                    expressionImage={vnExpressionImage}
                    expression={situationVnPresentation.sceneExpression}
                    motion={soloMotion}
                    backgroundImage={vnBackgroundImage}
                    bounceActive={vnBounceActive}
                    replySuggestions={replySuggestions}
                    hasReplySuggestions={showReplySuggestions}
                    isSummarizing={isSummarizing}
                    selectedCostumeId={vnSelectedCostumeId}
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
                    autoPlay={vnAutoPlay}
                    onToggleAutoPlay={() => setVnAutoPlay((on) => !on)}
                    ttsStatus={vnTtsStatus}
                    canTtsPlay={canPlayVnTts}
                    onTtsToggle={ttsEnabled ? () => {
                        if (vnTtsItem) playTtsVisualNovelItem(vnTtsItem);
                    } : undefined}
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
                    messages={pacedDisplayMessages}
                    isSecretMode={isSecretMode}
                    isMessageMode={isMessageMode}
                    isGroupRoom={isGroupRoom}
                    character={character}
                    groupCharacters={isGroupRoom ? groupCharacters : null}
                    activeStreamingPreview={activeStreamingPreview}
                    streamingPreviewBubbles={pacedStreamingPreviewBubbles}
                    streamingAwaiting={pacedStreamingAwaiting}
                    isLoading={isLoading || replyPacing.holding}
                    isSummarizing={isSummarizing}
                    branchingMessageId={branchingMessageId}
                    hoveredMessageId={hoveredMessageId}
                    touchedMessageId={touchedMessageId}
                    copiedMessageId={copiedMessageId}
                    streamedFinalMessageIds={pacedStreamedFinalMessageIds}
                    readMessageIds={readUserMessageIds}
                    messageTimeLabels={messageTimeLabels}
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
                    onRevealTypewriter={() => stopTypewriter(true)}
                    onTtsPlay={ttsEnabled ? playTtsMessage : undefined}
                    onPreviewImage={handlePreviewAttachmentImage}
                />
            )}

            {!isVisualNovelLogOpen && (
                <ChatComposer
                    inputRef={textareaRef}
                    focusKey={room.id}
                    value={chatInputValue}
                    onChange={handleChatInputChange}
                    onInsertAsterisk={handleInsertAsterisk}
                    showAttachmentButton={isBasicMode}
                    attachments={activeAttachments}
                    onSelectAttachmentFiles={handleSelectAttachmentFiles}
                    onRemoveAttachment={handleRemoveAttachment}
                    onPreviewAttachmentImage={handlePreviewAttachmentImage}
                    placeholder={chatInputPlaceholder}
                    disabled={chatInputDisabled}
                    redirectDisabled={
                        inputLockedByGeneration
                        || situationVnInputLocked
                        || (isEditingMessage && !isInlineVnEditing)
                    }
                    submitDisabled={chatInputSubmitDisabled}
                    submitMode={canContinue ? 'continue' : canRequestReply ? 'reply' : 'send'}
                    isMobile={isMobile}
                    isInlineEditing={isInlineVnEditing}
                    isBusy={showStopButton}
                    stopTitle={isReplyPending && !isLoading ? '返信待ちを取り消す' : undefined}
                    isTypewriterActive={isTypewriterActive}
                    onSubmit={() => {
                        if (canContinue) {
                            void handleContinue();
                        } else if (canRequestReply) {
                            void requestReplyNow();
                        } else {
                            void handleSubmit();
                        }
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
                    backgroundTasks={backgroundTasks}
                    backgroundTasksCheckedAt={backgroundTasksCheckedAt}
                    rooms={getAllRooms()}
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
            {previewAttachmentImage && (
                <AttachmentImageModal
                    image={previewAttachmentImage}
                    onClose={() => setPreviewAttachmentImage(null)}
                />
            )}
        </div>
    );
}
