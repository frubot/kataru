import { describe, expect, test } from 'vitest';

import { toFullJsonDebugLog } from '../components/chat/applyConversationResult';
import { takeNewlyFinishedTasks, type BackgroundTask } from '../lib/backgroundTasks';

function task(id: string, status: BackgroundTask['status'], finishedAt?: number): BackgroundTask {
    return {
        id,
        kind: 'memory-batch',
        reason: 'ターン後',
        roomId: 'room-1',
        characterId: 'char-1',
        characterName: 'アリス',
        status,
        startedAt: 1,
        finishedAt: finishedAt ?? null,
    };
}

describe('takeNewlyFinishedTasks', () => {
    test('returns finished tasks oldest first and skips them next time', () => {
        const imported = new Set<string>();
        const tasks = [task('c', 'running'), task('b', 'failed', 30), task('a', 'completed', 20)];

        expect(takeNewlyFinishedTasks(tasks, imported).map((entry) => entry.id)).toEqual(['a', 'b']);
        expect(takeNewlyFinishedTasks(tasks, imported)).toEqual([]);

        const later = [task('c', 'completed', 40), ...tasks.slice(1)];
        expect(takeNewlyFinishedTasks(later, imported).map((entry) => entry.id)).toEqual(['c']);
    });
});

describe('toFullJsonDebugLog', () => {
    test('keeps the server fields and drops logs without output', () => {
        const room = { id: 'room-1', name: '部屋' };
        expect(toFullJsonDebugLog({
            characterId: 'char-1',
            characterName: 'アリス',
            status: 'success',
            source: 'memory-batch-json',
            json: '{"memories":[]}',
            usage: { promptTokens: 10, completionTokens: 2 },
        }, room)).toMatchObject({
            roomId: 'room-1',
            roomName: '部屋',
            source: 'memory-batch-json',
            json: '{"memories":[]}',
            usage: { promptTokens: 10, completionTokens: 2 },
        });
        expect(toFullJsonDebugLog({
            characterId: 'char-1',
            characterName: 'アリス',
            status: 'success',
            source: 'memory-batch-json',
            json: '  ',
        }, room)).toBeNull();
    });
});
