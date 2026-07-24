import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { Send, Sparkles, MessageSquare, MessagesSquare, Menu, Brain, Bug, Square, SquarePen, Gamepad2, Copy, Check, RefreshCw, ChevronsDown, Shirt, AlertTriangle, X, ChevronDown, HatGlasses, Undo2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import {
    useStore,
    Room,
    Character,
    Message,
    Situation,
    SituationParticipant,
    DEFAULT_TITLE_GENERATION_MODEL,
} from '@/lib/store';
import type { MemoryKind, MemoryRecord, MemoryScope, SituationPriorMessage } from '@/lib/store';
import type { VnTypingSpeed } from '@/lib/store';
import { getMessageMemories } from '@/lib/chatAssistantResponse';
import { formatAssistantMarkdown } from '@/lib/markdownUtils';
import MessageBubble from './MessageBubble';
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
}

const DEFAULT_COSTUME_NAME = 'default';
const NEUTRAL_EXPRESSION_NAME = 'neutral';
const MESSAGE_MODE_BUBBLE_DELAY_MS = 420;

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
type ConversationCharacter = {
    id: string;
    name: string;
    systemPrompt: string;
    protagonistPrompt?: string;
    userConstraints?: string;
    model: string;
    maxTokens?: number;
    maxHistory?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    enableMemory?: boolean;
    enableSummary?: boolean;
    thinkModeEnabled?: boolean;
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
        protagonistPrompt: character.protagonistPrompt,
        userConstraints: character.userConstraints,
        model: character.model,
        maxTokens: character.maxTokens,
        maxHistory: character.maxHistory,
        temperature: character.temperature,
        topP: character.topP,
        topK: character.topK,
        enableMemory: character.enableMemory,
        enableSummary: character.enableSummary,
        thinkModeEnabled: character.thinkModeEnabled,
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
        name: room.name,
        viewMode: room.viewMode,
        summary: room.summary,
        maxMentionChain: room.maxMentionChain,
        costumeSelections: room.costumeSelections,
        secretMode: room.secretMode,
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

function buildProtagonistSection(character: Pick<Character, 'protagonistPrompt'>): string {
    const protagonistPrompt = character.protagonistPrompt?.trim();
    return protagonistPrompt ? `# 主人公の概要\n${protagonistPrompt}` : '';
}

function buildUserConstraintsSection(character: Pick<Character, 'userConstraints'>): string {
    const userConstraints = character.userConstraints?.trim();
    return userConstraints ? `# 追加の制約\n${userConstraints}` : '';
}

function buildCharacterSettingPrompt(character: Pick<Character, 'systemPrompt' | 'protagonistPrompt' | 'userConstraints'>): string {
    return [character.systemPrompt, buildProtagonistSection(character), buildUserConstraintsSection(character)]
        .filter((part) => part.trim())
        .join('\n\n');
}

function getLastReplyRoundStartIndex(messages: Message[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return i + 1;
    }
    return -1;
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

class ChatRequestError extends Error {
    status: number;
    detail?: string;
    elapsedMs?: number;
    bodyText?: string;
    contentType?: string;

    constructor(status: number, detail?: string, elapsedMs?: number, bodyText?: string, contentType?: string) {
        super(detail ? `Chat request failed (${status}): ${detail}` : `Chat request failed (${status})`);
        this.name = 'ChatRequestError';
        this.status = status;
        this.detail = detail;
        this.elapsedMs = elapsedMs;
        this.bodyText = bodyText;
        this.contentType = contentType;
    }
}

class ChatNetworkError extends Error {
    elapsedMs: number;
    originalName?: string;
    originalMessage?: string;

    constructor(error: unknown, elapsedMs: number) {
        const original = toErrorInfo(error);
        super(`Chat fetch failed after ${elapsedMs}ms: ${original.message ?? original.name ?? 'unknown error'}`);
        this.name = 'ChatNetworkError';
        this.elapsedMs = elapsedMs;
        this.originalName = original.name;
        this.originalMessage = original.message;
    }
}

class ChatStreamError extends Error {
    detail?: string;
    elapsedMs: number;
    chunk?: unknown;

    constructor(detail: string | undefined, elapsedMs: number, chunk?: unknown) {
        super(detail ? `Chat stream failed: ${detail}` : 'Chat stream failed');
        this.name = 'ChatStreamError';
        this.detail = detail;
        this.elapsedMs = elapsedMs;
        this.chunk = chunk;
    }
}

class ChatResponseReadError extends Error {
    status: number;
    contentType?: string;
    elapsedMs: number;
    phase: 'success-body' | 'error-body';
    originalName?: string;
    originalMessage?: string;

    constructor(params: {
        status: number;
        contentType?: string;
        elapsedMs: number;
        phase: ChatResponseReadError['phase'];
        error: unknown;
    }) {
        const original = toErrorInfo(params.error);
        super(`Failed to read chat response body (${params.phase}) after ${params.elapsedMs}ms`);
        this.name = 'ChatResponseReadError';
        this.status = params.status;
        this.contentType = params.contentType;
        this.elapsedMs = params.elapsedMs;
        this.phase = params.phase;
        this.originalName = original.name;
        this.originalMessage = original.message;
    }
}

type ResponseBodyInfo = {
    length: number;
    firstChar: string;
    looksLikeHtml: boolean;
    looksLikeJson: boolean;
};

class ChatResponseJsonError extends Error {
    status: number;
    contentType?: string;
    elapsedMs: number;
    bodyText: string;
    bodyInfo: ResponseBodyInfo;
    originalName?: string;
    originalMessage?: string;

    constructor(params: {
        status: number;
        contentType?: string;
        elapsedMs: number;
        bodyText: string;
        error: unknown;
    }) {
        const original = toErrorInfo(params.error);
        super(`Failed to parse chat response JSON after ${params.elapsedMs}ms`);
        this.name = 'ChatResponseJsonError';
        this.status = params.status;
        this.contentType = params.contentType;
        this.elapsedMs = params.elapsedMs;
        this.bodyText = params.bodyText;
        this.bodyInfo = describeResponseBody(params.bodyText);
        this.originalName = original.name;
        this.originalMessage = original.message;
    }
}

class ChatResponseFormatError extends Error {
    detail: string;
    elapsedMs: number;

    constructor(detail: string, elapsedMs: number) {
        super(`Unexpected chat response format: ${detail}`);
        this.name = 'ChatResponseFormatError';
        this.detail = detail;
        this.elapsedMs = elapsedMs;
    }
}

type ChatClientProcessingStage = 'assistant-response-parse' | 'message-save' | 'message-display';

class ChatClientProcessingError extends Error {
    stage: ChatClientProcessingStage;
    originalName?: string;
    originalMessage?: string;

    constructor(stage: ChatClientProcessingStage, error: unknown) {
        const original = toErrorInfo(error);
        super(`Client chat processing failed at ${stage}: ${original.message ?? original.name ?? 'unknown error'}`);
        this.name = 'ChatClientProcessingError';
        this.stage = stage;
        this.originalName = original.name;
        this.originalMessage = original.message;
    }
}

function toErrorInfo(error: unknown): { name?: string; message?: string } {
    if (error instanceof Error) return { name: error.name, message: error.message };
    if (typeof error === 'string') return { message: error };
    return { message: String(error) };
}

function describeResponseBody(bodyText: string): ResponseBodyInfo {
    const trimmed = bodyText.trimStart();
    return {
        length: bodyText.length,
        firstChar: trimmed.slice(0, 1),
        looksLikeHtml: /^<!doctype html|^<html/i.test(trimmed),
        looksLikeJson: /^[{\[]/.test(trimmed),
    };
}

function extractErrorDetail(value: unknown, depth = 0): string | undefined {
    if (depth > 2) return undefined;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;

        try {
            const parsed = JSON.parse(trimmed) as unknown;
            return extractErrorDetail(parsed, depth + 1) ?? trimmed;
        } catch {
            return trimmed;
        }
    }

    if (!value || typeof value !== 'object') return undefined;

    const record = value as Record<string, unknown>;
    return extractErrorDetail(record.error, depth + 1)
        ?? extractErrorDetail(record.message, depth + 1)
        ?? extractErrorDetail(record.detail, depth + 1);
}

function shortenErrorDetail(detail: string | undefined): string | undefined {
    if (!detail) return undefined;
    const compact = detail.replace(/\s+/g, ' ').trim();
    return compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
}

async function throwChatRequestError(response: Response, elapsedMs: number): Promise<never> {
    let errorText = '';
    const contentType = response.headers.get('content-type') ?? undefined;
    try {
        errorText = await response.text();
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new ChatResponseReadError({
            status: response.status,
            contentType,
            elapsedMs,
            phase: 'error-body',
            error,
        });
    }

    throw new ChatRequestError(response.status, shortenErrorDetail(extractErrorDetail(errorText)), elapsedMs, errorText, contentType);
}

function isTimeoutOrAbortStatus(status: number): boolean {
    return status === 408 || status === 499 || status === 504;
}

function isTimeoutOrAbortDetail(detail: string | undefined): boolean {
    return !!detail && /aborted|abort|timeout|timed out|network connection was lost|cancel/i.test(detail);
}

function getChatErrorMessage(error: unknown): string {
    if (error instanceof ChatNetworkError) {
        return 'リクエスト送信中に通信が失敗しました。';
    }

    if (error instanceof ChatRequestError) {
        const { status, detail } = error;
        if (isTimeoutOrAbortStatus(status) || isTimeoutOrAbortDetail(detail)) {
            return '生成が時間切れ、または通信が中断されました。';
        }
        if (status === 401 || status === 403) {
            return 'API認証でエラーが発生しました。接続先のAPI設定を確認してください。';
        }
        if (status === 429) {
            return 'リクエスト数または利用上限に達しました。少し時間を置いてからもう一度お試しください。';
        }
        if (status >= 500) {
            return 'サーバー側または接続先API側でエラーが発生しました。少し時間を置いてからもう一度お試しください。';
        }
        if (status >= 400) {
            return 'リクエスト内容でエラーが発生しました。';
        }
    }

    if (error instanceof ChatStreamError) {
        return 'ストリーミング応答の途中でエラーが発生しました。通信状態やモデル設定を確認してからもう一度お試しください。';
    }

    if (error instanceof ChatResponseReadError) {
        return 'サーバーは応答しましたが、レスポンス本文の読み取りに失敗しました。通信が途中で切れた可能性があります。';
    }

    if (error instanceof ChatResponseJsonError) {
        return 'サーバー応答をJSONとして解析できませんでした。';
    }

    if (error instanceof ChatResponseFormatError) {
        return 'サーバー応答の形式が想定外でした。モデル設定や接続先APIの応答を確認してください。';
    }

    if (error instanceof ChatClientProcessingError) {
        if (error.stage === 'message-save') {
            return '返信の保存処理でエラーが発生しました。ブラウザのストレージ容量や設定を確認してください。';
        }
        if (error.stage === 'message-display') {
            return '返信の表示処理でエラーが発生しました。ページを再読み込みしてからもう一度お試しください。';
        }
        return 'AI応答の整形処理でエラーが発生しました。';
    }

    if (error instanceof TypeError) {
        return 'クライアント側で未分類のTypeErrorが発生しました。詳細はブラウザのコンソールを確認してください。';
    }

    return '予期しないエラーが発生しました。もう一度お試しください。';
}

function getChatErrorDebugInfo(error: unknown): Record<string, unknown> {
    if (error instanceof ChatNetworkError) {
        return {
            stage: 'fetch',
            name: error.name,
            elapsedMs: error.elapsedMs,
            originalName: error.originalName,
            originalMessage: error.originalMessage,
        };
    }
    if (error instanceof ChatRequestError) {
        return {
            stage: 'http-status',
            name: error.name,
            status: error.status,
            detail: error.detail,
            contentType: error.contentType,
            elapsedMs: error.elapsedMs,
        };
    }
    if (error instanceof ChatStreamError) {
        return {
            stage: 'stream',
            name: error.name,
            detail: error.detail,
            elapsedMs: error.elapsedMs,
            chunk: error.chunk,
        };
    }
    if (error instanceof ChatResponseReadError) {
        return {
            stage: 'response-body-read',
            name: error.name,
            status: error.status,
            contentType: error.contentType,
            phase: error.phase,
            elapsedMs: error.elapsedMs,
            originalName: error.originalName,
            originalMessage: error.originalMessage,
        };
    }
    if (error instanceof ChatResponseJsonError) {
        return {
            stage: 'response-json-parse',
            name: error.name,
            status: error.status,
            contentType: error.contentType,
            elapsedMs: error.elapsedMs,
            bodyInfo: error.bodyInfo,
            originalName: error.originalName,
            originalMessage: error.originalMessage,
        };
    }
    if (error instanceof ChatResponseFormatError) {
        return {
            stage: 'response-format',
            name: error.name,
            detail: error.detail,
            elapsedMs: error.elapsedMs,
        };
    }
    if (error instanceof ChatClientProcessingError) {
        return {
            stage: error.stage,
            name: error.name,
            originalName: error.originalName,
            originalMessage: error.originalMessage,
        };
    }
    if (error instanceof Error) {
        return { stage: 'unclassified', name: error.name, message: error.message };
    }
    return { stage: 'unclassified', value: String(error) };
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

const CHAT_NOTICE_AUTO_HIDE_MS = 5000;

type ChatNotice = {
    id: number;
    message: string;
    tone: 'error';
};

type ChatGenerationResult = {
    status: 'success' | 'aborted' | 'error';
    message?: string;
    toCharacterIds?: string[];
};

type RustTurnResponse = {
    messages?: Array<{
        role: 'assistant';
        content: string;
        characterId: string;
        expression?: string;
        toCharacterIds?: string[];
    }>;
    usages?: Array<{
        characterId: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cost: number;
    }>;
    thinkLogs?: Array<{
        characterId: string;
        characterName: string;
        thinking: string;
    }>;
    fullJsonLogs?: Array<{
        characterId: string;
        characterName: string;
        model?: string;
        status: 'success' | 'error';
        source: string;
        prompt?: string;
        json: string;
        httpStatus?: number;
        elapsedMs?: number;
        errorName?: string;
    }>;
    summary?: {
        text: string;
        checkpointUserMessageId?: string;
        keepCount: number;
    } | null;
    memoryCandidates?: ExtractedMemoryUpdate[];
    usedMemoryIds?: string[];
};

type ChatGenerationSession = {
    id: number;
    roomId: string;
    cancelled: boolean;
    controller: AbortController | null;
};

type DebugLogTab = 'thinking' | 'json';

const MEMORY_SAVE_MIN_IMPORTANCE = 0.4;
const MEMORY_SAVE_MIN_CONFIDENCE = 0.75;
const MEMORY_SAVE_MAX_UPDATES = 5;
const MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD = 0.68;
const MEMORY_EXISTING_DEDUP_SIMILARITY_THRESHOLD = 0.78;

type ExtractedMemoryUpdate = {
    content: string;
    kind: MemoryKind;
    scope: MemoryScope;
    importance: number;
    confidence: number;
};

function normalizeMemoryTextForDedup(value: string): string {
    return value
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase()
        .replace(/[「」『』（）()[\]{}.,，。!！?？:：;；、・\s]/g, '');
}

function getMemoryDedupSignals(value: string): Set<string> {
    const signals = new Set<string>();
    const normalized = value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    for (const token of normalized.split(/[\s、。,.!?！？「」『』（）()[\]{}:;・/\\|]+/)) {
        if (token.length >= 2) signals.add(token);
    }

    const compact = normalizeMemoryTextForDedup(value);
    for (let i = 0; i < compact.length - 1; i++) {
        signals.add(compact.slice(i, i + 2));
    }
    return signals;
}

function memoryDedupSimilarity(a: string, b: string): number {
    const keyA = normalizeMemoryTextForDedup(a);
    const keyB = normalizeMemoryTextForDedup(b);
    if (!keyA || !keyB) return 0;
    if (keyA === keyB) return 1;
    if (keyA.includes(keyB) || keyB.includes(keyA)) {
        return Math.min(keyA.length, keyB.length) / Math.max(keyA.length, keyB.length);
    }

    const signalsA = getMemoryDedupSignals(a);
    const signalsB = getMemoryDedupSignals(b);
    if (signalsA.size === 0 || signalsB.size === 0) return 0;
    let overlap = 0;
    for (const signal of signalsA) {
        if (signalsB.has(signal)) overlap++;
    }
    return overlap / Math.min(signalsA.size, signalsB.size);
}

function isSimilarMemoryContent(content: string, others: { content: string }[], threshold: number): boolean {
    return others.some((other) =>
        memoryDedupSimilarity(content, other.content) >= threshold
    );
}

function isCoveredByCharacterSetting(content: string, systemPrompt: string): boolean {
    const normalizedPrompt = systemPrompt.trim();
    if (!normalizedPrompt) return false;
    return memoryDedupSimilarity(content, normalizedPrompt) >= 0.28;
}

export default function ChatWindow({ room, character, situation, groupName, groupCharacters, onOpenSidebar, onOpenMemoryList, onCreateCharacter }: ChatWindowProps) {
    const {
        addMessage,
        addMemory,
        deleteMessagesFrom,
        restoreMessagesAt,
        attachMemoriesToMessage,
        getCurrentRoom,
        addUsageRecord,
        updateRoomSummary,
        compressRoomHistory,
        updateRoomSettings,
        updateRoomName,
        setRoomSecretMode,
        createRoom,
        createRoomForSituation,
        vnTypingSpeed,
        summaryModel: globalSummaryModel,
        memoryExtractionModel,
        memoryEmbeddingModel,
        generateTitleOnFirstReply,
        titleGenerationModel,
        thinkDebugEnabled,
        thinkDebugLogs,
        addThinkDebugLog,
        clearThinkDebugLogs,
        fullJsonDebugEnabled,
        fullJsonDebugLogs,
        addFullJsonDebugLog,
        clearFullJsonDebugLogs,
        listMemoriesForCharacter,
        markMemoriesUsed,
        getAiProviderConfig,
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
    const [isLoading, setIsLoading] = useState(false);
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const [mentionStartIndex, setMentionStartIndex] = useState(0);
    const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
    const [touchedMessageId, setTouchedMessageId] = useState<string | null>(null);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const [editingMessage, setEditingMessage] = useState<EditingMessageDraft | null>(null);
    const [vnBounceActive, setVnBounceActive] = useState(false);
    const [typingMessageId, setTypingMessageId] = useState<string | null>(null);
    const [typedContent, setTypedContent] = useState('');
    const [isTypewriterActive, setIsTypewriterActive] = useState(false);
    const [chatModeMenuOpen, setChatModeMenuOpen] = useState(false);
    const [vnCostumeMenuOpen, setVnCostumeMenuOpen] = useState(false);
    const [debugLogOpen, setDebugLogOpen] = useState(false);
    const [debugLogTab, setDebugLogTab] = useState<DebugLogTab>('thinking');
    const [chatNotice, setChatNotice] = useState<ChatNotice | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const vnDialogueBodyRef = useRef<HTMLDivElement>(null);
    const chatModeMenuRef = useRef<HTMLDivElement>(null);
    const vnCostumeMenuRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const generationSessionRef = useRef<ChatGenerationSession | null>(null);
    const generationSessionSeqRef = useRef(0);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const vnBounceStartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const vnBounceStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const vnTypewriterRef = useRef<{ messageId: string; fullContent: string } | null>(null);
    const vnTypeDelayRef = useRef<{ timeout: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);
    const chatNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const vnTypingSpeedRef = useRef(vnTypingSpeed);
    const messagePointerDragRef = useRef(false);
    const currentRoomId = room?.id;
    const isEditingMessage = editingMessage?.roomId === currentRoomId;
    const isInlineVnEditing = isVisualNovelMode && isEditingMessage;
    const debugPanelEnabled = thinkDebugEnabled || fullJsonDebugEnabled;
    const activeDebugLogTab: DebugLogTab = fullJsonDebugEnabled && (!thinkDebugEnabled || debugLogTab === 'json')
        ? 'json'
        : 'thinking';
    const visibleDebugLogCount = (thinkDebugEnabled ? thinkDebugLogs.length : 0)
        + (fullJsonDebugEnabled ? fullJsonDebugLogs.length : 0);
    const activeDebugLogCount = activeDebugLogTab === 'thinking'
        ? thinkDebugLogs.length
        : fullJsonDebugLogs.length;

    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, []);

    const clearChatNoticeTimer = useCallback(() => {
        if (!chatNoticeTimeoutRef.current) return;
        clearTimeout(chatNoticeTimeoutRef.current);
        chatNoticeTimeoutRef.current = null;
    }, []);

    const dismissChatNotice = useCallback(() => {
        clearChatNoticeTimer();
        setChatNotice(null);
    }, [clearChatNoticeTimer]);

    const showChatNotice = useCallback((message: string) => {
        clearChatNoticeTimer();
        setChatNotice({
            id: Date.now(),
            message,
            tone: 'error',
        });
        chatNoticeTimeoutRef.current = setTimeout(() => {
            chatNoticeTimeoutRef.current = null;
            setChatNotice(null);
        }, CHAT_NOTICE_AUTO_HIDE_MS);
    }, [clearChatNoticeTimer]);

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
                    model: titleGenerationModel.trim() || DEFAULT_TITLE_GENERATION_MODEL,
                    aiProviderConfig: getAiProviderConfig(),
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
    }, [getAiProviderConfig, getCurrentRoom, groupCharacters, titleGenerationModel, updateRoomName]);

    const startGenerationSession = useCallback((roomId: string): ChatGenerationSession => {
        const previousSession = generationSessionRef.current;
        if (previousSession) {
            previousSession.cancelled = true;
            previousSession.controller?.abort();
        }

        const session: ChatGenerationSession = {
            id: generationSessionSeqRef.current + 1,
            roomId,
            cancelled: false,
            controller: null,
        };
        generationSessionSeqRef.current = session.id;
        generationSessionRef.current = session;
        abortControllerRef.current = null;
        return session;
    }, []);

    const isGenerationSessionActive = useCallback((session: ChatGenerationSession): boolean => {
        return generationSessionRef.current === session && !session.cancelled;
    }, []);

    const attachGenerationController = useCallback((session: ChatGenerationSession, controller: AbortController): boolean => {
        if (!isGenerationSessionActive(session)) {
            controller.abort();
            return false;
        }
        session.controller = controller;
        abortControllerRef.current = controller;
        return true;
    }, [isGenerationSessionActive]);

    const clearGenerationController = useCallback((session: ChatGenerationSession, controller: AbortController) => {
        if (session.controller === controller) {
            session.controller = null;
        }
        if (abortControllerRef.current === controller) {
            abortControllerRef.current = null;
        }
    }, []);

    const cancelGenerationSession = useCallback(() => {
        const session = generationSessionRef.current;
        if (session) {
            session.cancelled = true;
            session.controller?.abort();
            session.controller = null;
        }
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
    }, []);

    const finishGenerationSession = useCallback((session: ChatGenerationSession) => {
        if (generationSessionRef.current === session) {
            generationSessionRef.current = null;
        }
        if (session.controller && abortControllerRef.current === session.controller) {
            abortControllerRef.current = null;
        }
        session.controller = null;
    }, []);

    useEffect(() => {
        vnTypingSpeedRef.current = vnTypingSpeed;
    }, [vnTypingSpeed]);

    useEffect(() => {
        return () => clearChatNoticeTimer();
    }, [clearChatNoticeTimer]);

    useEffect(() => {
        dismissChatNotice();
    }, [currentRoomId, dismissChatNotice]);

    useEffect(() => {
        setEditingMessage(null);
    }, [currentRoomId]);

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

    // Room switch cleanup: abort any in-flight generation.
    useEffect(() => {
        return () => {
            stopTypewriter(false);
            cancelGenerationSession();
            setIsLoading(false);
            setIsSummarizing(false);
        };
    }, [room?.id, stopTypewriter, cancelGenerationSession]);

    useEffect(() => {
        if (!isVisualNovelMode) {
            setVnCostumeMenuOpen(false);
        }
    }, [isVisualNovelMode]);

    useEffect(() => {
        if (!debugPanelEnabled) {
            setDebugLogOpen(false);
            return;
        }
        if (debugLogTab === 'thinking' && !thinkDebugEnabled) {
            setDebugLogTab('json');
        } else if (debugLogTab === 'json' && !fullJsonDebugEnabled) {
            setDebugLogTab('thinking');
        }
    }, [debugPanelEnabled, debugLogTab, fullJsonDebugEnabled, thinkDebugEnabled]);

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
    useEffect(() => {
        if (isMobile) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as Element;
            const tag = target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if ((target as HTMLElement).isContentEditable) return;
            if (e.key.length !== 1 && e.key !== 'Backspace') return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (!textareaRef.current || isLoading || (isEditingMessage && !isInlineVnEditing)) return;
            textareaRef.current.focus();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isMobile, isLoading, isEditingMessage, isInlineVnEditing]);

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
                showArchiveDivider,
                showMemoryIndicator: memories.length > 0,
                msgCharacterIcon: msgCharacter?.icon ?? (isGroupRoom ? undefined : character?.icon),
                msgCharacterName: msgCharacter?.name ?? (isGroupRoom ? undefined : character?.name),
            };
        });
    }, [room, characterMap, character, isGroupRoom, typingMessageId, typedContent]);

    const handleStop = () => {
        if (stopTypewriter(true)) {
            return;
        }

        cancelGenerationSession();
        setIsLoading(false);
        setIsSummarizing(false);
    };

    const generateRustTurn = async (
        session: ChatGenerationSession,
        sourceRoom: Room,
    ): Promise<ChatGenerationResult> => {
        if (!isGenerationSessionActive(session)) return { status: 'aborted' };

        const controller = new AbortController();
        if (!attachGenerationController(session, controller)) {
            return { status: 'aborted' };
        }

        try {
            const response = await fetch('/api/conversation/turn', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    room: toConversationRoom(sourceRoom),
                    character: toConversationCharacter(character),
                    situation: toConversationSituation(situation),
                    groupCharacters: groupCharacters?.map(toConversationParticipant),
                    messages: sourceRoom.messages,
                    secretMode: isSecretMode,
                    summaryModel: globalSummaryModel,
                    memoryExtractionModel,
                    memoryEmbeddingModel,
                    aiProviderConfig: getAiProviderConfig(),
                }),
                signal: controller.signal,
            });
            if (!isGenerationSessionActive(session) || controller.signal.aborted) {
                throw new DOMException('Generation stopped', 'AbortError');
            }
            if (!response.ok) {
                await throwChatRequestError(response, 0);
            }

            const data = await response.json() as RustTurnResponse;
            if (data.summary?.text) {
                updateRoomSummary(
                    sourceRoom.id,
                    data.summary.text,
                    data.summary.checkpointUserMessageId,
                );
                if (Number.isInteger(data.summary.keepCount) && data.summary.keepCount > 0) {
                    compressRoomHistory(sourceRoom.id, data.summary.keepCount);
                }
            }

            const assistantMessageIds: string[] = [];
            const assistantMessages = Array.isArray(data.messages) ? data.messages : [];
            for (let index = 0; index < assistantMessages.length; index++) {
                const message = assistantMessages[index];
                if (!message?.content?.trim()) continue;
                if (isMessageMode && index > 0) {
                    await waitForMessageModeBubbleDelay();
                }
                if (!isGenerationSessionActive(session) || controller.signal.aborted) {
                    throw new DOMException('Generation stopped', 'AbortError');
                }
                assistantMessageIds.push(addMessage(
                    sourceRoom.id,
                    'assistant',
                    message.content,
                    message.characterId,
                    {
                        expression: message.expression,
                        toCharacterIds: message.toCharacterIds ?? [],
                    },
                ));
            }

            if (!isSecretMode) {
                for (const usage of data.usages ?? []) {
                    addUsageRecord(
                        usage.characterId,
                        usage.promptTokens,
                        usage.completionTokens,
                        usage.totalTokens,
                        usage.cost,
                    );
                }
                if (thinkDebugEnabled) {
                    for (const log of data.thinkLogs ?? []) {
                        if (!log.thinking?.trim()) continue;
                        addThinkDebugLog({
                            roomId: sourceRoom.id,
                            roomName: getCurrentRoom()?.name ?? sourceRoom.name,
                            characterId: log.characterId,
                            characterName: log.characterName,
                            thinking: log.thinking,
                        });
                    }
                }
                if (fullJsonDebugEnabled) {
                    for (const log of data.fullJsonLogs ?? []) {
                        if (!log.json?.trim()) continue;
                        addFullJsonDebugLog({
                            roomId: sourceRoom.id,
                            roomName: getCurrentRoom()?.name ?? sourceRoom.name,
                            characterId: log.characterId,
                            characterName: log.characterName,
                            model: log.model,
                            status: log.status,
                            source: log.source,
                            prompt: log.prompt,
                            json: log.json,
                            httpStatus: log.httpStatus,
                            elapsedMs: log.elapsedMs,
                            errorName: log.errorName,
                        });
                    }
                }
                markMemoriesUsed(data.usedMemoryIds ?? []);
            }

            if (
                !isSecretMode &&
                character &&
                assistantMessageIds.length > 0 &&
                Array.isArray(data.memoryCandidates) &&
                data.memoryCandidates.length > 0
            ) {
                const existingMemories = await listMemoriesForCharacter(character.id);
                const savedThisTurn: ExtractedMemoryUpdate[] = [];
                const candidates = data.memoryCandidates
                    .filter((update) =>
                        update &&
                        typeof update.content === 'string' &&
                        ['fact', 'preference', 'event', 'relationship', 'instruction'].includes(update.kind) &&
                        ['character', 'relationship', 'world'].includes(update.scope) &&
                        update.importance >= MEMORY_SAVE_MIN_IMPORTANCE &&
                        update.confidence >= MEMORY_SAVE_MIN_CONFIDENCE
                    )
                    .sort((a, b) =>
                        (b.importance * b.confidence) - (a.importance * a.confidence)
                    )
                    .filter((update) => {
                        const setting = buildCharacterSettingPrompt(character);
                        if (isCoveredByCharacterSetting(update.content, setting)) return false;
                        if (isSimilarMemoryContent(update.content, existingMemories, MEMORY_EXISTING_DEDUP_SIMILARITY_THRESHOLD)) return false;
                        if (isSimilarMemoryContent(update.content, savedThisTurn, MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD)) return false;
                        savedThisTurn.push(update);
                        return true;
                    })
                    .slice(0, MEMORY_SAVE_MAX_UPDATES);

                await Promise.all(candidates.map((update) =>
                    addMemory(character.id, update.content, {
                        scope: update.scope,
                        kind: update.kind,
                        importance: update.importance,
                        confidence: update.confidence,
                        sourceRoomId: sourceRoom.id,
                        sourceMessageIds: assistantMessageIds,
                    })
                ));
                attachMemoriesToMessage(
                    sourceRoom.id,
                    assistantMessageIds[0],
                    candidates.map((update) => update.content),
                );
            }

            if (
                !isMessageMode &&
                vnTypingSpeed !== 'streaming' &&
                assistantMessageIds[0] &&
                assistantMessages[0]?.content
            ) {
                await playTypewriter(assistantMessageIds[0], assistantMessages[0].content);
            }

            return {
                status: 'success',
                message: assistantMessages.map((message) => message.content).join('\n\n'),
            };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return { status: 'aborted' };
            }
            console.error('Rust conversation turn failed:', getChatErrorDebugInfo(error));
            showChatNotice(getChatErrorMessage(error));
            return { status: 'error' };
        } finally {
            clearGenerationController(session, controller);
        }
    };

    const handleSubmit = async (e?: React.FormEvent, editDraft?: EditingMessageDraft) => {
        e?.preventDefault();
        const submittedInput = editDraft?.content ?? input;
        if (!submittedInput.trim() || !room || isLoading || isSummarizing) return;
        if (!isGroupRoom && !character) return;
        if (isGroupRoom && (!groupCharacters || groupCharacters.length === 0)) return;

        const userMessage = submittedInput.trim();
        const shouldGenerateTitleAfterFirstReply = generateTitleOnFirstReply
            && !editDraft
            && room.isDraft === true
            && !isSecretMode;
        const originalRoomName = room.name;
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
        if (editDraft) {
            editDeletedMemories = await deleteMessagesFrom(room.id, editCutIndex);
            setEditingMessage(null);
        } else {
            setInput('');
        }
        setIsLoading(true);
        const session = startGenerationSession(room.id);

        const userMessageId = addMessage(room.id, 'user', userMessage);

        const roomAfterUserMessage = getCurrentRoom();
        if (!roomAfterUserMessage) {
            finishGenerationSession(session);
            setIsLoading(false);
            return;
        }

        const rollbackSubmittedTurn = async () => {
            const latestRoom = getCurrentRoom();
            const isCurrentRoomActive = latestRoom?.id === room.id;

            if (editDraft && editCutIndex >= 0) {
                if (isCurrentRoomActive && latestRoom.messages.length > editCutIndex) {
                    await deleteMessagesFrom(room.id, editCutIndex);
                }
                await restoreMessagesAt(room.id, editCutIndex, editDeletedMessages, editDeletedMemories);
                if (isCurrentRoomActive) {
                    setEditingMessage({ ...editDraft, content: submittedInput });
                }
                return;
            }

            if (isCurrentRoomActive) {
                setInput(submittedInput);
                const userMessageIndex = latestRoom.messages.findIndex((message) => message.id === userMessageId);
                if (userMessageIndex >= 0) {
                    await deleteMessagesFrom(room.id, userMessageIndex);
                }
            }
        };

        const generationResult = await generateRustTurn(session, roomAfterUserMessage);

        if (generationResult.status === 'error' || generationResult.status === 'aborted') {
            await rollbackSubmittedTurn();
            if (!editDraft) {
                setTimeout(() => textareaRef.current?.focus(), 50);
            }
        } else if (shouldGenerateTitleAfterFirstReply) {
            void generateInitialRoomTitle(room.id, originalRoomName);
        }
        finishGenerationSession(session);
        setIsLoading(false);
        setIsSummarizing(false);
    };

    const handleRegenerate = async () => {
        if (!room || isLoading) return;

        if (isGroupRoom && groupCharacters) {
            // Remove all assistant messages from the last round (after the last user message)
            const lastUserIndex = [...room.messages].reverse().findIndex((m) => m.role === 'user');
            if (lastUserIndex === -1) return;
            const cutFrom = room.messages.length - lastUserIndex;
            const messagesToDelete = room.messages.slice(cutFrom);
            const removedMemoryRecords = await deleteMessagesFrom(room.id, cutFrom);
            setIsLoading(true);
            const session = startGenerationSession(room.id);
            try {
                const latestRoom = getCurrentRoom();
                const result = latestRoom
                    ? await generateRustTurn(session, latestRoom)
                    : { status: 'aborted' as const };
                if (result.status !== 'success') {
                    const latestRoom = getCurrentRoom();
                    if (latestRoom?.id === room.id && latestRoom.messages.length > cutFrom) {
                        await deleteMessagesFrom(room.id, cutFrom);
                    }
                    await restoreMessagesAt(room.id, cutFrom, messagesToDelete, removedMemoryRecords);
                }
            } finally {
                finishGenerationSession(session);
                setIsLoading(false);
                setIsSummarizing(false);
            }
        } else {
            if (!character) return;
            const cutFrom = getLastReplyRoundStartIndex(room.messages);
            if (cutFrom < 0 || cutFrom >= room.messages.length) return;
            const messagesToDelete = room.messages.slice(cutFrom);
            if (!messagesToDelete.some((msg) => msg.role === 'assistant')) return;

            const removedMemoryRecords = await deleteMessagesFrom(room.id, cutFrom);

            setIsLoading(true);

            const session = startGenerationSession(room.id);
            try {
                const latestRoom = getCurrentRoom();
                const result = latestRoom
                    ? await generateRustTurn(session, latestRoom)
                    : { status: 'aborted' as const };
                if (result.status !== 'success') {
                    const latestRoom = getCurrentRoom();
                    if (latestRoom?.id === room.id && latestRoom.messages.length > cutFrom) {
                        await deleteMessagesFrom(room.id, cutFrom);
                    }
                    await restoreMessagesAt(room.id, cutFrom, messagesToDelete, removedMemoryRecords);
                }
            } finally {
                finishGenerationSession(session);
                setIsLoading(false);
                setIsSummarizing(false);
            }
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

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Handle mention navigation
        if (mentionQuery !== null && mentionCandidates.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedMentionIdx((i) => (i + 1) % mentionCandidates.length);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedMentionIdx((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                applyMention(mentionCandidates[selectedMentionIdx]);
                return;
            }
            if (e.key === 'Escape') {
                setMentionQuery(null);
                return;
            }
        }
        if (isMobile) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (isInlineVnEditing) {
                handleSubmitEditMessage();
            } else {
                handleSubmit();
            }
        }
    };

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
        () => resolveExpressionImage(vnCharacter, latestAssistantMessage?.emotion ?? latestResolvedAssistantEmotion, vnSelectedCostumeName),
        [vnCharacter, latestAssistantMessage, latestResolvedAssistantEmotion, vnSelectedCostumeName],
    );
    const latestAssistantMessageId = latestAssistantMessage?.id;
    const latestAssistantEmotion = latestAssistantMessage?.emotion;
    const latestAssistantHasText = !!latestAssistantMessage?.displayContent.trim();

    useEffect(() => {
        if (!isVisualNovelMode || !latestAssistantMessageId || !latestAssistantHasText) return;
        triggerVnBounce();
    }, [isVisualNovelMode, latestAssistantMessageId, latestAssistantEmotion, latestAssistantHasText, triggerVnBounce]);

    const lastRoomMessage = room ? room.messages[room.messages.length - 1] : undefined;
    const isWaitingForAssistant = isLoading && lastRoomMessage?.role !== 'assistant';
    const isTypingLatestMessage = latestAssistantMessage?.id === typingMessageId;
    const vnDialogueContent = isTypingLatestMessage
        ? typedContent
        : latestAssistantMessage?.displayContent || (isWaitingForAssistant ? '...' : '...（話しかけてみましょう）');
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

    useEffect(() => {
        const handleAdvanceKey = (e: KeyboardEvent) => {
            if (!vnTypewriterRef.current) return;
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName;
            const isEditableTarget = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
            const isDisabledFormTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
                ? target.disabled
                : false;
            if (isEditableTarget && !isDisabledFormTarget) return;

            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                stopTypewriter(true);
            }
        };

        document.addEventListener('keydown', handleAdvanceKey);
        return () => document.removeEventListener('keydown', handleAdvanceKey);
    }, [stopTypewriter]);

    const handleClearActiveDebugLogs = () => {
        if (activeDebugLogTab === 'thinking') {
            clearThinkDebugLogs();
        } else {
            clearFullJsonDebugLogs();
        }
    };

    const chatInputValue = isInlineVnEditing ? editingMessage?.content ?? '' : input;
    const chatInputPlaceholder = isInlineVnEditing
        ? '直前の入力を編集中'
        : isEditingMessage
            ? '編集中のメッセージで送信してください'
            : (isMobile ? '返信' : '返信… (Enterで送信)');
    const chatInputDisabled = isLoading || isSummarizing || (isEditingMessage && !isInlineVnEditing);
    const chatInputSubmitDisabled = isInlineVnEditing
        ? !editingMessage?.content.trim()
        : !input.trim() || isEditingMessage;
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

    return (
        <div className={`chat-container ${isVisualNovelMode ? 'vn-mode' : ''} ${isMessageMode ? 'message-mode' : ''}`}>
            <div className="chat-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
                    {isMobile && (
                        <button type="button" className="btn btn-ghost mobile-sidebar-trigger" onClick={onOpenSidebar} style={{ padding: '0.5rem', flexShrink: 0 }} title="サイドバーを開く" aria-label="サイドバーを開く">
                            <Menu size={20} />
                        </button>
                    )}
                    <MessageSquare size={20} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} className="desktop-only" />
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
                <div className="vn-stage">
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
                                    isLoading={isLoading}
                                    isHovered={hoveredMessageId === message.id || touchedMessageId === message.id}
                                    isCopied={copiedMessageId === message.id}
                                    isTypewriterActive={isTypewriterActive && message.id === typingMessageId}
                                    formatAssistantActions={!isMessageMode}
                                    isAssistantContinuation={message.isAssistantContinuation}
                                    showAssistantActions={message.showAssistantActions}
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
                                    onOpenMemoryList={handleOpenMessageMemoryList}
                                    onRevealTypewriter={() => stopTypewriter(true)}
                                />
                            ))}
                        </>
                    )}
                    {isLoading && room.messages[room.messages.length - 1]?.role !== 'assistant' && (
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
                    <div key={chatNotice.id} className={`chat-notice ${chatNotice.tone}`} role="alert" aria-live="polite">
                        <AlertTriangle size={16} className="chat-notice-icon" />
                        <span className="chat-notice-message">{chatNotice.message}</span>
                        <button
                            type="button"
                            className="chat-notice-close"
                            onClick={dismissChatNotice}
                            title="閉じる"
                            aria-label="通知を閉じる"
                        >
                            <X size={14} />
                        </button>
                    </div>
                )}
                {mentionQuery !== null && mentionCandidates.length > 0 && (
                    <div style={{
                        position: 'absolute',
                        bottom: '100%',
                        left: 0,
                        right: 0,
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
                                <Send size={16} />
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
                    <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 820 }}>
                        <div className="modal-header">
                            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <Bug size={18} />
                                デバッグログ
                            </h2>
                            <button className="btn btn-ghost" onClick={() => setDebugLogOpen(false)} style={{ padding: '0.5rem' }} title="閉じる">
                                <X size={20} />
                            </button>
                        </div>
                        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            {thinkDebugEnabled && fullJsonDebugEnabled && (
                                <div className="tabs">
                                    <button
                                        type="button"
                                        className={`tab ${activeDebugLogTab === 'thinking' ? 'active' : ''}`}
                                        onClick={() => setDebugLogTab('thinking')}
                                    >
                                        考え ({thinkDebugLogs.length})
                                    </button>
                                    <button
                                        type="button"
                                        className={`tab ${activeDebugLogTab === 'json' ? 'active' : ''}`}
                                        onClick={() => setDebugLogTab('json')}
                                    >
                                        JSON ({fullJsonDebugLogs.length})
                                    </button>
                                </div>
                            )}

                            {activeDebugLogTab === 'thinking' ? (
                                thinkDebugLogs.length === 0 ? (
                                    <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                                        まだ考えログはありません。
                                    </p>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                        {thinkDebugLogs.map((log) => (
                                            <div
                                                key={log.id}
                                                style={{
                                                    padding: '0.875rem',
                                                    borderRadius: '0.5rem',
                                                    border: '1px solid var(--border-color)',
                                                    background: 'var(--bg-secondary)',
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.5rem' }}>
                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {log.characterName}
                                                        </div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {log.roomName}
                                                        </div>
                                                    </div>
                                                    <time style={{ flexShrink: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                        {new Date(log.createdAt).toLocaleString()}
                                                    </time>
                                                </div>
                                                <pre style={{
                                                    margin: 0,
                                                    whiteSpace: 'pre-wrap',
                                                    wordBreak: 'break-word',
                                                    fontFamily: 'inherit',
                                                    fontSize: '0.875rem',
                                                    lineHeight: 1.6,
                                                    color: 'var(--text-secondary)',
                                                }}>{log.thinking}</pre>
                                            </div>
                                        ))}
                                    </div>
                                )
                            ) : (
                                fullJsonDebugLogs.length === 0 ? (
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
                                )
                            )}
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={handleClearActiveDebugLogs} disabled={activeDebugLogCount === 0}>
                                ログを消去
                            </button>
                            <button className="btn btn-primary" onClick={() => setDebugLogOpen(false)}>
                                閉じる
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
