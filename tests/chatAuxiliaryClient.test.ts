import { describe, expect, test } from 'vitest';

import { buildPromptRequestMessages } from '../lib/chatAuxiliaryClient';
import type { Message, SituationParticipant } from '../lib/store';

describe('auxiliary chat prompt messages', () => {
    test('drops archived and blank messages and adds participant names', () => {
        const messages = [
            { id: 'u1', role: 'user', content: '質問', timestamp: 1 },
            { id: 'a1', role: 'assistant', content: '回答', characterId: 'actor-1', timestamp: 2 },
            { id: 'a2', role: 'assistant', content: '非表示', archived: true, timestamp: 3 },
            { id: 'u2', role: 'user', content: '   ', timestamp: 4 },
        ] as Message[];
        const participants = [{ id: 'actor-1', name: 'アリス' }] as SituationParticipant[];

        expect(buildPromptRequestMessages(messages, participants)).toEqual([
            { role: 'user', content: '質問' },
            { role: 'assistant', content: '回答', name: 'アリス' },
        ]);
    });
});
