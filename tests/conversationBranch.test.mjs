import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildConversationBranch,
    isConversationResponseEnd,
} from '../lib/conversationBranch.ts';

function createIdGenerator() {
    let id = 0;
    return () => `generated-${++id}`;
}

function message(id, role, timestamp, extras = {}) {
    return { id, role, content: id, timestamp, ...extras };
}

function room(messages, extras = {}) {
    return {
        id: 'source-room',
        characterId: 'character-1',
        name: '元の会話',
        messages,
        createdAt: 1,
        updatedAt: 2,
        ...extras,
    };
}

test('only the last character response before the next user message is a branch point', () => {
    const messages = [
        message('user-1', 'user', 1),
        message('assistant-1', 'assistant', 2, { characterId: 'actor-1' }),
        message('assistant-2', 'assistant', 3, { characterId: 'actor-2' }),
        message('user-2', 'user', 4),
    ];

    assert.equal(isConversationResponseEnd(messages, 1), false);
    assert.equal(isConversationResponseEnd(messages, 2), true);
});

test('branching inside summarized history restores messages and removes the summary', () => {
    const source = room([
        message('user-1', 'user', 1, { archived: true }),
        message('assistant-1', 'assistant', 2, {
            archived: true,
            memories: ['分岐元だけの記憶'],
        }),
        message('user-2', 'user', 3),
        message('assistant-2', 'assistant', 4),
    ], {
        summary: '既存の要約',
        summaryCheckpointUserMessageId: 'user-1',
    });

    const branched = buildConversationBranch(
        source,
        ['元の会話', '元の会話 (分岐)'],
        'assistant-1',
        100,
        createIdGenerator(),
    );

    assert.equal(branched.name, '元の会話 (分岐 2)');
    assert.equal(branched.summary, undefined);
    assert.equal(branched.summaryCheckpointUserMessageId, undefined);
    assert.equal(branched.messages.length, 2);
    assert.equal(branched.messages.some((item) => item.archived), false);
    assert.equal(branched.messages.some((item) => item.memories), false);
});

test('branching after summarized history preserves the summary and remaps its checkpoint', () => {
    const source = room([
        message('user-1', 'user', 1, { archived: true }),
        message('assistant-1', 'assistant', 2, { archived: true }),
        message('user-2', 'user', 3),
        message('assistant-2', 'assistant', 4),
        message('user-3', 'user', 5),
        message('assistant-3', 'assistant', 6),
    ], {
        summary: '既存の要約',
        summaryCheckpointUserMessageId: 'user-1',
    });

    const branched = buildConversationBranch(
        source,
        ['元の会話'],
        'assistant-2',
        100,
        createIdGenerator(),
    );

    assert.equal(branched.summary, '既存の要約');
    assert.equal(branched.summaryCheckpointUserMessageId, branched.messages[0].id);
    assert.equal(branched.messages[0].archived, true);
    assert.equal(branched.messages.length, 4);
    assert.equal(branched.messages.at(-1).content, 'assistant-2');
});

test('an intermediate character response cannot be used as a branch point', () => {
    const source = room([
        message('user-1', 'user', 1),
        message('assistant-1', 'assistant', 2),
        message('assistant-2', 'assistant', 3),
    ]);

    assert.throws(
        () => buildConversationBranch(source, [], 'assistant-1', 100, createIdGenerator()),
        /分岐できる応答地点/,
    );
});
