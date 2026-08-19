import {
    getChatErrorPolicy,
    isRetryableGenerationError as isRetryableGenerationErrorPolicy,
} from './chatErrorPolicy';
import type { ChatErrorPolicyInput } from './chatErrorPolicy';

export class ChatRequestError extends Error {
    status: number;
    detail?: string;
    elapsedMs?: number;
    bodyText?: string;
    contentType?: string;
    phase?: ChatErrorPolicyInput['phase'];

    constructor(
        status: number,
        detail?: string,
        elapsedMs?: number,
        bodyText?: string,
        contentType?: string,
        phase?: ChatRequestError['phase'],
    ) {
        super(detail ? `Chat request failed (${status}): ${detail}` : `Chat request failed (${status})`);
        this.name = 'ChatRequestError';
        this.status = status;
        this.detail = detail;
        this.elapsedMs = elapsedMs;
        this.bodyText = bodyText;
        this.contentType = contentType;
        this.phase = phase;
    }
}

export class ChatResponseReadError extends Error {
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

export class ChatGenerationJobError extends Error {
    detail?: string;

    constructor(detail?: string) {
        super(detail || 'バックグラウンド生成に失敗しました。');
        this.name = 'ChatGenerationJobError';
        this.detail = detail;
    }
}

function toErrorInfo(error: unknown): { name?: string; message?: string } {
    if (error instanceof Error) return { name: error.name, message: error.message };
    if (typeof error === 'string') return { message: error };
    return { message: String(error) };
}

function extractErrorDetail(value: unknown, depth = 0): string | undefined {
    if (depth > 2) return undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        try {
            return extractErrorDetail(JSON.parse(trimmed) as unknown, depth + 1) ?? trimmed;
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

export async function throwChatRequestError(
    response: Response,
    elapsedMs: number,
    phase?: ChatRequestError['phase'],
): Promise<never> {
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
    throw new ChatRequestError(
        response.status,
        shortenErrorDetail(extractErrorDetail(errorText)),
        elapsedMs,
        errorText,
        contentType,
        phase,
    );
}

function getChatErrorPolicyInput(error: unknown): ChatErrorPolicyInput {
    const status = error instanceof ChatRequestError || error instanceof ChatResponseReadError
        ? error.status
        : undefined;
    const detail = error instanceof ChatRequestError
        ? [error.detail, error.bodyText, error.message].filter(Boolean).join(' ')
        : error instanceof ChatResponseReadError
            ? [error.originalMessage, error.message].filter(Boolean).join(' ')
            : error instanceof ChatGenerationJobError
                ? [error.detail, error.message].filter(Boolean).join(' ')
                : error instanceof Error
                    ? error.message
                    : error == null
                        ? ''
                        : String(error);
    return {
        status,
        detail: detail.slice(0, 4000),
        phase: error instanceof ChatRequestError ? error.phase : undefined,
        source: error instanceof ChatRequestError
            ? 'request'
            : error instanceof ChatGenerationJobError
                ? 'job'
                : 'other',
    };
}

function getPolicy(error: unknown) {
    return getChatErrorPolicy(getChatErrorPolicyInput(error));
}

export function isRetryableGenerationError(error: unknown): boolean {
    return isRetryableGenerationErrorPolicy(getChatErrorPolicyInput(error));
}

export function shouldOpenSettingsForChatError(error: unknown): boolean {
    return getPolicy(error).action === 'open-settings';
}

export function getChatErrorMessage(error: unknown): string {
    const policy = getPolicy(error);
    if (policy.classification === 'rate-limit') {
        return 'リクエスト数または利用上限に達しました。少し時間を置いてからもう一度お試しください。';
    }
    if (policy.classification === 'context-length') {
        return '会話履歴がモデルのコンテキスト上限を超えました。自動要約を有効にするか、キャラクター／シチュエーション設定の最大履歴を小さくしてから、もう一度送信してください。';
    }
    if (policy.classification === 'authentication') {
        return 'API認証でエラーが発生しました。接続先のAPI設定を確認してください。';
    }
    if ((error instanceof ChatRequestError || error instanceof ChatGenerationJobError) && policy.classification === 'timeout') {
        return '生成が時間切れ、または通信が中断されました。';
    }
    if (error instanceof ChatGenerationJobError) {
        return 'バックグラウンド生成に失敗しました。少し時間を置いてからもう一度お試しください。';
    }
    if (error instanceof ChatRequestError) {
        if (error.status >= 500) {
            return 'サーバー側または接続先API側でエラーが発生しました。少し時間を置いてからもう一度お試しください。';
        }
        if (error.status >= 400) return 'リクエスト内容でエラーが発生しました。';
    }
    if (error instanceof ChatResponseReadError) {
        return 'サーバーは応答しましたが、レスポンス本文の読み取りに失敗しました。通信が途中で切れた可能性があります。';
    }
    if (error instanceof TypeError) {
        return 'クライアント側で未分類のTypeErrorが発生しました。詳細はブラウザのコンソールを確認してください。';
    }
    return '予期しないエラーが発生しました。もう一度お試しください。';
}

function formatOriginalError(name?: string, message?: string): string | undefined {
    const detail = [name, message]
        .filter((value): value is string => !!value?.trim())
        .join(': ');
    return shortenErrorDetail(detail);
}

function getChatErrorDetail(error: unknown, detailed: boolean): string | undefined {
    if (error instanceof ChatRequestError) {
        const detail = [`HTTP ${error.status}`, error.detail].filter(Boolean).join(': ');
        if (!detailed) return detail;
        return [
            detail,
            error.contentType ? `Content-Type ${error.contentType}` : undefined,
            error.elapsedMs != null ? `応答まで ${error.elapsedMs}ms` : undefined,
        ].filter(Boolean).join(' / ');
    }
    if (error instanceof ChatResponseReadError) {
        const original = formatOriginalError(error.originalName, error.originalMessage);
        if (!detailed) return original ? `応答本文の読み取り: ${original}` : undefined;
        return [
            `HTTP ${error.status}`,
            `読み取り段階: ${error.phase}`,
            error.contentType ? `Content-Type ${error.contentType}` : undefined,
            `経過 ${error.elapsedMs}ms`,
            original ? `原因: ${original}` : undefined,
        ].filter(Boolean).join(' / ');
    }
    if (error instanceof ChatGenerationJobError) {
        return error.detail ? `生成ジョブ: ${shortenErrorDetail(error.detail)}` : '生成ジョブの詳細を取得できませんでした。';
    }
    if (error instanceof Error) return formatOriginalError(error.name, error.message);
    if (typeof error === 'string') return shortenErrorDetail(error);
    return error == null ? undefined : shortenErrorDetail(String(error));
}

export function getChatErrorNotice(error: unknown, detailed: boolean): string {
    const message = getChatErrorMessage(error);
    const detail = getChatErrorDetail(error, detailed);
    if (!detail) return message;
    return detailed ? `${message}\n詳細: ${detail}` : `${message}（${detail}）`;
}

export function getChatErrorDebugInfo(error: unknown): Record<string, unknown> {
    if (error instanceof ChatRequestError) {
        return {
            stage: 'http-status',
            name: error.name,
            status: error.status,
            detail: error.detail,
            contentType: error.contentType,
            elapsedMs: error.elapsedMs,
            phase: error.phase,
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
    if (error instanceof ChatGenerationJobError) {
        return { stage: 'generation-job', name: error.name, detail: error.detail };
    }
    if (error instanceof Error) {
        return { stage: 'unclassified', name: error.name, message: error.message };
    }
    return { stage: 'unclassified', value: String(error) };
}
