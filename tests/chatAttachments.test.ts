import { afterEach, describe, expect, test, vi } from 'vitest';

import {
    MAX_TOTAL_ATTACHMENT_DATA_BYTES,
    capMessageAttachmentData,
    chatAttachmentDataBytes,
    extractDroppedAttachmentFiles,
    hasDraggedAttachmentFiles,
    readChatAttachmentFiles,
} from '../lib/chatAttachments';
import type { Message, MessageAttachment } from '../lib/store';

class MockFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(file: File) {
        void file.arrayBuffer().then((buffer) => {
            const base64 = Buffer.from(buffer).toString('base64');
            this.result = `data:${file.type || 'application/octet-stream'};base64,${base64}`;
            this.onload?.();
        });
    }
    readAsText(file: File) {
        void file.text().then((text) => {
            this.result = text;
            this.onload?.();
        });
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
});

function stubFileReader() {
    vi.stubGlobal('FileReader', MockFileReader);
}

function attachment(name: string, data: string, kind: 'image' | 'file' = 'image'): MessageAttachment {
    return {
        id: `id-${name}`,
        kind,
        name,
        mimeType: kind === 'image' ? 'image/png' : 'text/plain',
        data,
    };
}

describe('chatAttachmentDataBytes', () => {
    test('counts ASCII data URLs by length and text by UTF-8 bytes', () => {
        expect(chatAttachmentDataBytes(attachment('a.png', 'data:image/png;base64,AAAA'))).toBe(26);
        expect(chatAttachmentDataBytes(attachment('a.txt', 'abc', 'file'))).toBe(3);
        // 日本語はUTF-8で1文字3バイト。
        expect(chatAttachmentDataBytes(attachment('a.txt', 'あいう', 'file'))).toBe(9);
    });
});

describe('readChatAttachmentFiles total size limit', () => {
    test('accepts attachments while the combined data stays under the limit', async () => {
        stubFileReader();
        const file = new File([new Uint8Array(1024)], 'tiny.gif', { type: 'image/gif' });
        const { attachments, errors } = await readChatAttachmentFiles([file]);
        expect(errors).toEqual([]);
        expect(attachments).toHaveLength(1);
        expect(attachments[0].data.startsWith('data:image/gif;base64,')).toBe(true);
    });

    test('rejects files once the batch total exceeds the limit', async () => {
        stubFileReader();
        // GIFはリサイズされずBase64化されるので、入力サイズの約1.37倍になる。
        const size = 20 * 1024 * 1024;
        const files = [
            new File([new Uint8Array(size)], 'a.gif', { type: 'image/gif' }),
            new File([new Uint8Array(size)], 'b.gif', { type: 'image/gif' }),
            new File([new Uint8Array(size)], 'c.gif', { type: 'image/gif' }),
        ];
        const { attachments, errors } = await readChatAttachmentFiles(files);
        // 各GIFは約27MiBにエンコードされるため、2件目以降は合計上限にかかる。
        expect(attachments).toHaveLength(1);
        expect(errors).toHaveLength(2);
        expect(errors[0]).toContain('合計サイズ');
    });

    test('counts already-pending attachments toward the limit', async () => {
        stubFileReader();
        const existing = [
            attachment('big.png', `data:image/png;base64,${'A'.repeat(MAX_TOTAL_ATTACHMENT_DATA_BYTES - 1024)}`),
        ];
        const file = new File([new Uint8Array(64 * 1024)], 'extra.gif', { type: 'image/gif' });
        const { attachments, errors } = await readChatAttachmentFiles([file], { existing });
        expect(attachments).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('extra.gif');
    });
});

describe('capMessageAttachmentData', () => {
    test('returns messages unchanged when the total fits the budget', () => {
        const messages = [
            {
                id: 'u1',
                role: 'user',
                content: '見て',
                attachments: [attachment('a.png', 'data:image/png;base64,AAAA')],
                timestamp: 1,
            },
            { id: 'a1', role: 'assistant', content: 'いいね', timestamp: 2 },
        ] as Message[];

        const result = capMessageAttachmentData(messages, 1024);
        expect(result).toEqual(messages);
        expect(result[0].attachments?.[0].data).toBe('data:image/png;base64,AAAA');
    });

    test('strips data from the oldest attachments first, keeping name and kind', () => {
        const big = (seed: string) => `data:image/png;base64,${seed.repeat(100)}`;
        const messages = [
            {
                id: 'u1',
                role: 'user',
                content: '古い画像',
                attachments: [attachment('old.png', big('O'))],
                timestamp: 1,
            },
            {
                id: 'u2',
                role: 'user',
                content: '新しい画像',
                attachments: [attachment('new.png', big('N'))],
                timestamp: 2,
            },
        ] as Message[];

        const single = chatAttachmentDataBytes(messages[1].attachments![0]);
        const result = capMessageAttachmentData(messages, single);

        expect(result[1].attachments?.[0].data).toBe(big('N'));
        expect(result[0].attachments?.[0]).toMatchObject({
            id: 'id-old.png',
            kind: 'image',
            name: 'old.png',
            data: '',
        });
        // 表示側のルーム状態は変更しない。
        expect(messages[0].attachments?.[0].data).toBe(big('O'));
    });

    test('keeps a small older attachment that fits after an oversized one was skipped', () => {
        const big = (seed: string) => `data:image/png;base64,${seed.repeat(1000)}`;
        const messages = [
            {
                id: 'u1',
                role: 'user',
                content: '',
                attachments: [attachment('tiny.txt', '小さいファイル', 'file')],
                timestamp: 1,
            },
            {
                id: 'u2',
                role: 'user',
                content: '',
                attachments: [attachment('mid.png', big('M'))],
                timestamp: 2,
            },
            {
                id: 'u3',
                role: 'user',
                content: '',
                attachments: [attachment('new.png', big('N'))],
                timestamp: 3,
            },
        ] as Message[];

        const smallBytes = chatAttachmentDataBytes(messages[0].attachments![0]);
        const newBytes = chatAttachmentDataBytes(messages[2].attachments![0]);
        const result = capMessageAttachmentData(messages, newBytes + smallBytes);

        // 最新の添付を優先して残し、中間の大きい添付は削られても、
        // 収まる範囲の古い小さい添付はそのまま残る。
        expect(result[2].attachments?.[0].data).toBe(big('N'));
        expect(result[1].attachments?.[0].data).toBe('');
        expect(result[0].attachments?.[0].data).toBe('小さいファイル');
    });
});

describe('dragged attachment file helpers', () => {
    test('detects dragged files from DataTransfer types or files list', () => {
        expect(hasDraggedAttachmentFiles(null)).toBe(false);
        expect(hasDraggedAttachmentFiles({ types: ['text/plain'] })).toBe(false);
        expect(hasDraggedAttachmentFiles({ types: ['text/plain', 'Files'] })).toBe(true);
        const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
        expect(hasDraggedAttachmentFiles({ types: [], files: [file] })).toBe(true);
    });

    test('extracts dropped files as an array', () => {
        expect(extractDroppedAttachmentFiles(null)).toEqual([]);
        const fileA = new File(['a'], 'a.txt', { type: 'text/plain' });
        const fileB = new File(['b'], 'b.txt', { type: 'text/plain' });
        expect(extractDroppedAttachmentFiles({ files: [fileA, fileB] })).toEqual([fileA, fileB]);
    });
});
