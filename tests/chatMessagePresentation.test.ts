import { describe, expect, test } from 'vitest';
import type { Character, Message, Room } from '../lib/store';
import {
    buildChatMessagePresentations,
    resolveChatStreamingPresentation,
} from '../lib/chatMessagePresentation';
import { buildConversationBranch } from '../lib/conversationBranch';

const character: Character = {
    id: 'character-1',
    name: 'Alice',
    systemPrompt: '',
    model: { connectionId: 'openrouter', model: 'test' },
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

    test('merges a flagged continuation into the previous bubble for the same character', () => {
        const presentations = buildChatMessagePresentations({
            room: room([
                message('user', 'user', 'hello'),
                message('assistant-1', 'assistant', 'one', { characterId: 'character-1' }),
                message('assistant-2', 'assistant', 'two', { characterId: 'character-1', continuesPrevious: true }),
            ]),
            characterMap: null,
            character,
            isGroupRoom: false,
            isSecretMode: false,
            typingMessageId: null,
            typedContent: '',
        });

        expect(presentations[2].mergedIntoPrevious).toBe(true);
        expect(presentations[1].displayContent).toBe('one\n\ntwo');
        expect(presentations[1].showAssistantActions).toBe(true);
        expect(presentations[1].showBranchAction).toBe(true);
        expect(presentations[1].branchMessageId).toBe('assistant-2');
    });

    test('branches a merged bubble at the merged tail message', () => {
        const source = room([
            message('user', 'user', 'hello'),
            message('assistant-1', 'assistant', 'one', { characterId: 'character-1' }),
            message('assistant-2', 'assistant', 'two', { characterId: 'character-1', continuesPrevious: true }),
        ]);
        const presentations = buildChatMessagePresentations({
            room: source,
            characterMap: null,
            character,
            isGroupRoom: false,
            isSecretMode: false,
            typingMessageId: null,
            typedContent: '',
        });
        let generated = 0;
        const branched = buildConversationBranch(
            source,
            [],
            presentations[1].branchMessageId,
            100,
            () => `generated-${++generated}`,
        );

        expect(branched.messages.map((item) => item.content)).toEqual(['hello', 'one', 'two']);
    });

    test('keeps a flagged continuation separate when a different character speaks', () => {
        const presentations = buildChatMessagePresentations({
            room: room([
                message('user', 'user', 'hello'),
                message('assistant-1', 'assistant', 'one', { characterId: 'char-a' }),
                message('assistant-2', 'assistant', 'two', { characterId: 'char-b', continuesPrevious: true }),
            ]),
            characterMap: new Map(),
            character,
            isGroupRoom: true,
            isSecretMode: false,
            typingMessageId: null,
            typedContent: '',
        });

        expect(presentations[2].mergedIntoPrevious).toBe(false);
        expect(presentations[1].displayContent).toBe('one');
        expect(presentations[2].displayContent).toBe('two');
    });

    test('does not merge a flagged continuation across an archive boundary', () => {
        const presentations = buildChatMessagePresentations({
            room: room([
                message('assistant-1', 'assistant', 'old', { characterId: 'character-1', archived: true }),
                message('assistant-2', 'assistant', 'new', { characterId: 'character-1', continuesPrevious: true }),
            ]),
            characterMap: null,
            character,
            isGroupRoom: false,
            isSecretMode: false,
            typingMessageId: null,
            typedContent: '',
        });

        expect(presentations[1].mergedIntoPrevious).toBe(false);
        expect(presentations[1].showArchiveDivider).toBe(true);
    });

    test('merges chained continuations into the same bubble', () => {
        const presentations = buildChatMessagePresentations({
            room: room([
                message('user', 'user', 'hello'),
                message('assistant-1', 'assistant', 'one', { characterId: 'character-1' }),
                message('assistant-2', 'assistant', 'two', { characterId: 'character-1', continuesPrevious: true }),
                message('assistant-3', 'assistant', 'three', { characterId: 'character-1', continuesPrevious: true }),
            ]),
            characterMap: null,
            character,
            isGroupRoom: false,
            isSecretMode: false,
            typingMessageId: null,
            typedContent: '',
        });

        expect(presentations[2].mergedIntoPrevious).toBe(true);
        expect(presentations[3].mergedIntoPrevious).toBe(true);
        expect(presentations[1].displayContent).toBe('one\n\ntwo\n\nthree');
        expect(presentations[1].branchMessageId).toBe('assistant-3');
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

    test('keeps completed turns visible while a later turn streams', () => {
        const result = resolveChatStreamingPresentation({
            streamingPreview: {
                roomId: 'room-1',
                jobId: 'job-1',
                content: 'two…',
                characterId: 'char-b',
                characterName: 'B',
                turns: [
                    {
                        turnIndex: 0,
                        content: 'one-a\n\none-b',
                        characterId: 'char-a',
                        characterName: 'A',
                        formattedMessages: ['one-a', 'one-b'],
                        complete: true,
                    },
                    {
                        turnIndex: 1,
                        content: 'two…',
                        characterId: 'char-b',
                        characterName: 'B',
                        complete: false,
                    },
                ],
            },
            room: room([message('user', 'user', 'hello')]),
            isLoading: true,
            characterMap: null,
            character,
        });

        expect(result.bubbles.map((bubble) => bubble.content)).toEqual([
            'one-a',
            'one-b',
            'two…',
        ]);
        expect(result.bubbles.map((bubble) => bubble.streaming)).toEqual([
            false,
            false,
            true,
        ]);
        expect(result.bubbles.map((bubble) => bubble.continuation)).toEqual([
            false,
            true,
            false,
        ]);
        expect(result.bubbles.map((bubble) => bubble.characterId)).toEqual([
            'char-a',
            'char-a',
            'char-b',
        ]);
    });

    test('drops preview turns that are already persisted', () => {
        const result = resolveChatStreamingPresentation({
            streamingPreview: {
                roomId: 'room-1',
                jobId: 'job-1',
                content: 'two',
                characterId: 'char-b',
                characterName: 'B',
                turns: [
                    {
                        turnIndex: 0,
                        content: 'one',
                        characterId: 'char-a',
                        characterName: 'A',
                        complete: true,
                    },
                    {
                        turnIndex: 1,
                        content: 'two',
                        characterId: 'char-b',
                        characterName: 'B',
                        complete: false,
                    },
                ],
            },
            room: room([
                message('user', 'user', 'hello'),
                message('assistant-1', 'assistant', 'one', { characterId: 'char-a' }),
            ]),
            isLoading: true,
            characterMap: null,
            character,
        });

        expect(result.bubbles.map((bubble) => bubble.content)).toEqual(['two']);
    });

    test('appends a continuation preview to the previous same-character bubble', () => {
        const result = resolveChatStreamingPresentation({
            streamingPreview: {
                roomId: 'room-1',
                jobId: 'job-1',
                content: 'two',
                continuationOfMessageId: 'assistant-1',
                turns: [
                    { turnIndex: 0, content: 'two', characterId: 'character-1', complete: false },
                ],
            },
            room: room([
                message('user', 'user', 'hello'),
                message('assistant-1', 'assistant', 'one', { characterId: 'character-1' }),
            ]),
            isLoading: true,
            characterMap: null,
            character,
        });

        expect(result.continuationAppend).toBe('two');
        expect(result.bubbles).toEqual([]);
        expect(result.activePreview).not.toBeNull();
    });

    test('keeps continuation preview bubbles when a different character speaks', () => {
        const result = resolveChatStreamingPresentation({
            streamingPreview: {
                roomId: 'room-1',
                jobId: 'job-1',
                content: 'two',
                continuationOfMessageId: 'assistant-1',
                turns: [
                    { turnIndex: 0, content: 'two', characterId: 'char-b', complete: false },
                ],
            },
            room: room([
                message('user', 'user', 'hello'),
                message('assistant-1', 'assistant', 'one', { characterId: 'char-a' }),
            ]),
            isLoading: true,
            characterMap: new Map(),
            character,
        });

        expect(result.continuationAppend).toBeUndefined();
        expect(result.bubbles.map((bubble) => bubble.content)).toEqual(['two']);
    });

    test('keeps only the first turn bubble merged during a continuation', () => {
        const result = resolveChatStreamingPresentation({
            streamingPreview: {
                roomId: 'room-1',
                jobId: 'job-1',
                content: 'two',
                continuationOfMessageId: 'assistant-1',
                turns: [
                    { turnIndex: 0, content: 'two', characterId: 'character-1', complete: true },
                    { turnIndex: 1, content: 'three', characterId: 'character-1', complete: false },
                ],
            },
            room: room([
                message('user', 'user', 'hello'),
                message('assistant-1', 'assistant', 'one', { characterId: 'character-1' }),
            ]),
            isLoading: true,
            characterMap: null,
            character,
        });

        expect(result.continuationAppend).toBe('two');
        expect(result.bubbles.map((bubble) => bubble.content)).toEqual(['three']);
    });
});
