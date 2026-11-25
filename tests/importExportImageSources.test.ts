import { describe, expect, test } from 'vitest';

import { parseFullBackup } from '../lib/importExport';

const ASSET_ID = 'a'.repeat(64);
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

type BackupOverrides = {
    characters?: unknown[];
    situations?: unknown[];
    rooms?: unknown[];
    messages?: unknown[];
};

function character(overrides: Record<string, unknown> = {}) {
    return {
        id: 'character-a',
        name: 'アリス',
        systemPrompt: 'アリスのシステムプロンプト',
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    };
}

function situation(overrides: Record<string, unknown> = {}) {
    return {
        id: 'situation-1',
        name: 'テストシチュエーション',
        actors: [{ id: 'actor-a', type: 'character', characterId: 'character-a' }],
        maxTurns: 1,
        memoryMode: 'off',
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    };
}

function room(overrides: Record<string, unknown> = {}) {
    return {
        id: 'room-1',
        characterId: 'character-a',
        name: 'テストルーム',
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    };
}

function backup(overrides: BackupOverrides = {}): string {
    return JSON.stringify({
        version: 1,
        exportedAt: 0,
        type: 'full',
        data: {
            characters: overrides.characters ?? [character()],
            situations: overrides.situations ?? [],
            rooms: overrides.rooms ?? [],
            messages: overrides.messages ?? [],
            memories: [],
            usageRecords: [],
        },
    });
}

describe('full backup import image sources', () => {
    test('アプリ内の画像参照はそのまま取り込める', () => {
        const parsed = parseFullBackup(backup({
            characters: [character({
                icon: PNG_DATA_URL,
                costumes: [{
                    id: 'costume-1',
                    name: 'default',
                    image: `asset:${ASSET_ID}`,
                    expressions: [{ name: 'smile', image: PNG_DATA_URL }],
                }],
            })],
        }));

        expect(parsed.characters[0].icon).toBe(PNG_DATA_URL);
        expect(parsed.characters[0].costumes?.[0].image).toBe(`asset:${ASSET_ID}`);
    });

    test('空のアイコンは画像なしとして扱う', () => {
        const parsed = parseFullBackup(backup({ characters: [character({ icon: '' })] }));
        expect(parsed.characters[0].icon).toBe('');
    });

    test.each([
        ['アイコン', { icon: 'https://attacker.example/pixel.png' }, /アイコン/],
        ['アイコン（プロトコル相対）', { icon: '//attacker.example/pixel.png' }, /アイコン/],
        ['アイコン（blob）', { icon: 'blob:http://127.0.0.1:37371/abc' }, /アイコン/],
        ['アイコン（表示用URL）', { icon: `/api/assets/${ASSET_ID}` }, /アイコン/],
        [
            '衣装の画像',
            { costumes: [{ id: 'costume-1', name: 'default', image: 'https://attacker.example/costume.png' }] },
            /衣装の画像/,
        ],
        [
            '衣装の表情画像',
            {
                costumes: [{
                    id: 'costume-1',
                    name: 'default',
                    image: PNG_DATA_URL,
                    expressions: [{ name: 'smile', image: 'http://attacker.example/expression.png' }],
                }],
            },
            /衣装の表情の画像/,
        ],
        [
            '旧形式の表情画像',
            { expressions: [{ name: 'neutral', image: 'https://attacker.example/legacy.png' }] },
            /衣装の画像/,
        ],
    ])('%s に外部URLがあれば取り込みを拒否する', (_label, overrides, pattern) => {
        expect(() => parseFullBackup(backup({ characters: [character(overrides)] }))).toThrow(pattern);
    });

    test('シチュエーションの背景画像に外部URLがあれば拒否する', () => {
        expect(() => parseFullBackup(backup({
            situations: [situation({ backgroundImage: 'https://attacker.example/background.png' })],
        }))).toThrow(/背景画像/);
    });

    test('シチュエーション参加者のアイコンに外部URLがあれば拒否する', () => {
        expect(() => parseFullBackup(backup({
            situations: [situation({
                actors: [
                    { id: 'actor-a', type: 'character', characterId: 'character-a' },
                    {
                        id: 'actor-temp',
                        type: 'temporary',
                        name: 'モブ',
                        systemPrompt: '',
                        icon: 'https://attacker.example/mob.png',
                    },
                ],
            })],
        }))).toThrow(/参加者「モブ」のアイコン/);
    });

    test('メッセージ添付画像に外部URLがあれば拒否する', () => {
        expect(() => parseFullBackup(backup({
            rooms: [room()],
            messages: [{
                id: 'message-1',
                roomId: 'room-1',
                role: 'user',
                content: '添付つき',
                timestamp: 1,
                attachments: [{
                    id: 'attachment-1',
                    kind: 'image',
                    name: 'pixel.png',
                    mimeType: 'image/png',
                    data: 'https://attacker.example/pixel.png?secret=conversation',
                }],
            }],
        }))).toThrow(/添付画像/);
    });
});
