import { describe, expect, test } from 'vitest';
import type { Character, Message, Room } from '../lib/store';
import {
    buildChatMessagePresentations,
    resolveChatStreamingPresentation,
} from '../lib/chatMessagePresentation';

const character: Character = {
    id: 'character-1',
    name: 'Alice',
    systemPrompt: '',
    model: 'test',
    icon: 'alice.png',
    createdAt: 0,
    updatedAt: 0,
};

function message(id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
    return { id, role, content, timestamp: 0, ...extra };
}

function room(messages: Message[]): Room {
    return {
        id: 'room-1',
        characterId: character.id,
        name: 'Room',
        messages,
        createdAt: 0,
        updatedAt: 0,
    };
}

describe('chat message presentation', () => {
    test('groups assistant continuations and exposes actions only on the final segment', () => {
        const presentations = buildChatMessagePresentations({
            room: room([
                message('user', 'user', 'hello'),
                message('assistant-1', 'assistant', 'one'),
                message('assistant-2', 'assistant', 'two'),
            ]),
            characterMap: null,
            character,
            isGroupRoom: false,
            isSecretMode: false,
            typingMessageId: null,
            typedContent: '',
        });

        expect(presentations[1].showAssistantActions).toBe(false);
        expect(presentations[2].isAssistantContinuation).toBe(true);
        expect(presentations[2].showAssistantActions).toBe(true);
        expect(presentations[2].showBranchAction).toBe(true);
    });

    test('uses typewriter content and shows the archive boundary', () => {
        const presentations = buildChatMessagePresentations({
            room: room([
                message('archived', 'assistant', 'old', { archived: true }),
                message('active', 'assistant', 'full'),
            ]),
            characterMap: null,
            character,
            isGroupRoom: false,
            isSecretMode: false,
            typingMessageId: 'active',
            typedContent: 'fu',
        });

        expect(presentations[1].displayContent).toBe('fu');
        expect(presentations[1].showArchiveDivider).toBe(true);
    });
});

describe('streaming preview presentation', () => {
    test('hides formatted previews that are already persisted', () => {
        const result = resolveChatStreamingPresentation({
            streamingPreview: {
                roomId: 'room-1',
                jobId: 'job-1',
                content: 'done',
                formattedMessages: ['done'],
            },
            room: room([message('assistant', 'assistant', 'done')]),
            isLoading: true,
            characterMap: null,
            character,
        });

        expect(result.activePreview).toBeNull();
        expect(result.formattedMessages).toEqual([]);
    });

    test('keeps a running preview for the active room', () => {
        const preview = { roomId: 'room-1', jobId: 'job-1', content: 'partial' };
        const result = resolveChatStreamingPresentation({
            streamingPreview: preview,
            room: room([message('user', 'user', 'hello')]),
            isLoading: true,
            characterMap: null,
            character,
        });

        expect(result.activePreview).toEqual(preview);
    });
});
