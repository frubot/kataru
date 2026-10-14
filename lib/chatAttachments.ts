import { generateId } from './id';
import { resizeToMaxEdge } from './imageUtils';
import type { MessageAttachment } from './store/types';

export const CHAT_ATTACHMENT_ACCEPT = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'text/*',
    '.txt',
    '.md',
    '.markdown',
    '.json',
    '.jsonl',
    '.csv',
    '.tsv',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.log',
    '.xml',
    '.html',
    '.htm',
    '.css',
    '.scss',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rs',
    '.go',
    '.rb',
    '.java',
    '.kt',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.php',
    '.swift',
    '.sh',
    '.bash',
    '.zsh',
    '.ps1',
    '.bat',
    '.sql',
    '.graphql',
    '.lua',
    '.r',
    '.tex',
].join(',');

const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_IMAGE_EDGE = 1280;
// 添付の実データ合計の上限。会話APIはリクエスト全体に64MiBの制限があり、
// 履歴を毎回送る構造なので、1メッセージ分・リクエスト内の添付データは
// これ以下に収める。
export const MAX_TOTAL_ATTACHMENT_DATA_BYTES = 32 * 1024 * 1024;

const attachmentDataEncoder = new TextEncoder();

// 添付がJSONリクエスト内で占める実バイト数。data URLはASCIIのみなので
// 文字数がそのままバイト数になり、テキストはUTF-8にエンコードして数える。
export function chatAttachmentDataBytes(attachment: Pick<MessageAttachment, 'kind' | 'data'>): number {
    return attachment.kind === 'image'
        ? attachment.data.length
        : attachmentDataEncoder.encode(attachment.data).length;
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
]);

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
]);

const SUPPORTED_TEXT_MIME_TYPES = new Set([
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/typescript',
    'application/x-typescript',
    'application/yaml',
    'application/x-yaml',
    'application/toml',
    'application/sql',
    'application/graphql',
    'application/x-sh',
    'image/svg+xml',
]);

const SUPPORTED_TEXT_EXTENSIONS = new Set([
    '.txt',
    '.md',
    '.markdown',
    '.json',
    '.jsonl',
    '.csv',
    '.tsv',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.log',
    '.xml',
    '.svg',
    '.html',
    '.htm',
    '.css',
    '.scss',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rs',
    '.go',
    '.rb',
    '.java',
    '.kt',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.php',
    '.swift',
    '.sh',
    '.bash',
    '.zsh',
    '.ps1',
    '.bat',
    '.sql',
    '.graphql',
    '.lua',
    '.r',
    '.tex',
]);

function getLowerExtension(fileName: string): string {
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

export function isSupportedImageFile(file: Pick<File, 'name' | 'type'>): boolean {
    const mime = file.type.toLowerCase();
    if (SUPPORTED_IMAGE_MIME_TYPES.has(mime)) return true;
    return SUPPORTED_IMAGE_EXTENSIONS.has(getLowerExtension(file.name));
}

export function isKnownTextFile(file: Pick<File, 'name' | 'type'>): boolean {
    const mime = file.type.toLowerCase();
    if (mime.startsWith('text/') || SUPPORTED_TEXT_MIME_TYPES.has(mime)) return true;
    return SUPPORTED_TEXT_EXTENSIONS.has(getLowerExtension(file.name));
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error(`${file.name} の読み込みに失敗しました。`));
        reader.readAsDataURL(file);
    });
}

function readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error(`${file.name} の読み込みに失敗しました。`));
        reader.readAsText(file);
    });
}

async function normalizeImageAttachmentDataUrl(file: File, dataUrl: string): Promise<string> {
    const mime = file.type.toLowerCase();
    const ext = getLowerExtension(file.name);
    if (mime === 'image/gif' || ext === '.gif') {
        return dataUrl;
    }
    try {
        return await resizeToMaxEdge(dataUrl, MAX_ATTACHMENT_IMAGE_EDGE);
    } catch {
        return dataUrl;
    }
}

export async function readChatAttachmentFiles(
    files: Iterable<File>,
    options?: { existing?: readonly MessageAttachment[] },
): Promise<{ attachments: MessageAttachment[]; errors: string[] }> {
    const attachments: MessageAttachment[] = [];
    const errors: string[] = [];
    let totalDataBytes = (options?.existing ?? []).reduce(
        (sum, attachment) => sum + chatAttachmentDataBytes(attachment),
        0,
    );
    const pushWithinTotalLimit = (attachment: MessageAttachment) => {
        const bytes = chatAttachmentDataBytes(attachment);
        if (totalDataBytes + bytes > MAX_TOTAL_ATTACHMENT_DATA_BYTES) {
            errors.push(`${attachment.name}: 添付の合計サイズは32MB以下にしてください。`);
            return;
        }
        totalDataBytes += bytes;
        attachments.push(attachment);
    };

    for (const file of files) {
        const name = file.name.trim() || 'attachment';
        if (isSupportedImageFile(file)) {
            if (file.size <= 0) {
                errors.push(`${name}: 空のファイルは添付できません。`);
                continue;
            }
            if (file.size > MAX_IMAGE_FILE_BYTES) {
                errors.push(`${name}: 画像サイズは20MB以下にしてください。`);
                continue;
            }
            try {
                const rawDataUrl = await readFileAsDataUrl(file);
                const data = await normalizeImageAttachmentDataUrl(file, rawDataUrl);
                const mimeMatch = /^data:([^;,]+);base64,/i.exec(data);
                pushWithinTotalLimit({
                    id: generateId(),
                    kind: 'image',
                    name,
                    mimeType: mimeMatch?.[1] || file.type || 'image/png',
                    data,
                });
            } catch (error) {
                errors.push(error instanceof Error ? error.message : `${name} の読み込みに失敗しました。`);
            }
            continue;
        }

        if (file.size <= 0) {
            errors.push(`${name}: 空のファイルは添付できません。`);
            continue;
        }
        if (file.size > MAX_TEXT_FILE_BYTES) {
            errors.push(`${name}: テキストファイルのサイズは1MB以下にしてください。`);
            continue;
        }

        const knownText = isKnownTextFile(file);
        if (!knownText && file.type && !file.type.startsWith('text/') && file.type !== 'application/octet-stream') {
            errors.push(`${name}: 対応していないファイル形式です。画像（PNG/JPEG/WebP/GIF）またはテキストファイルを選択してください。`);
            continue;
        }

        try {
            const text = await readFileAsText(file);
            if (text.includes('\0')) {
                errors.push(`${name}: バイナリファイルは添付できません。画像またはテキストファイルを選択してください。`);
                continue;
            }
            if (!text.trim()) {
                errors.push(`${name}: 空のテキストファイルは添付できません。`);
                continue;
            }
            pushWithinTotalLimit({
                id: generateId(),
                kind: 'file',
                name,
                mimeType: file.type || 'text/plain',
                data: text,
            });
        } catch (error) {
            errors.push(error instanceof Error ? error.message : `${name} の読み込みに失敗しました。`);
        }
    }

    return { attachments, errors };
}

export function formatMessageTextWithAttachments(
    content: string,
    attachments?: readonly MessageAttachment[],
): string {
    const sections: string[] = [];
    const trimmed = content.trim();
    if (trimmed) {
        sections.push(trimmed);
    }
    for (const attachment of attachments ?? []) {
        if (attachment.kind === 'file' && attachment.data.trim()) {
            sections.push(`[添付ファイル: ${attachment.name}]\n${attachment.data}`);
        } else if (attachment.kind === 'image') {
            sections.push(`[添付画像: ${attachment.name}]`);
        }
    }
    return sections.join('\n\n');
}

// 会話APIには履歴全体を毎回送るため、添付データが蓄積するとリクエスト上限を
// 超えうる。新しい添付から優先して残し、収まらなかった古い添付は data を
// 空にする（サーバー側で名前だけのプレースホルダーに変換される）。
// 画面上のルーム状態ではなく送信ペイロードにだけ適用すること。
export function capMessageAttachmentData<T extends { attachments?: MessageAttachment[] }>(
    messages: readonly T[],
    maxBytes: number = MAX_TOTAL_ATTACHMENT_DATA_BYTES,
): T[] {
    let totalBytes = 0;
    for (const message of messages) {
        for (const attachment of message.attachments ?? []) {
            totalBytes += chatAttachmentDataBytes(attachment);
        }
    }
    if (totalBytes <= maxBytes) return [...messages];

    let remaining = maxBytes;
    const keepByMessage = messages.map((message) => (message.attachments ?? []).map(() => false));
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const attachments = messages[i].attachments ?? [];
        for (let j = attachments.length - 1; j >= 0; j -= 1) {
            const bytes = chatAttachmentDataBytes(attachments[j]);
            if (bytes <= remaining) {
                keepByMessage[i][j] = true;
                remaining -= bytes;
            }
        }
    }
    return messages.map((message, index) => {
        const attachments = message.attachments;
        if (!attachments?.length || keepByMessage[index].every(Boolean)) {
            return message;
        }
        return {
            ...message,
            attachments: attachments.map((attachment, attachmentIndex) => (
                keepByMessage[index][attachmentIndex]
                    ? attachment
                    : { ...attachment, data: '' }
            )),
        };
    });
}
