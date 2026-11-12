import { describe, expect, test, vi } from 'vitest';

import {
    removeCostume,
    resolveActiveCostume,
    resolveDefaultCostume,
    resolveStoredCostumeReference,
    setDefaultCostume,
    upsertCostume,
    type CostumeSet,
} from '../lib/costumes';
import { parseFullBackup } from '../lib/importExport';
import { createCharacterSlice } from '../lib/store/characters';
import { normalizeGroupData } from '../lib/store/situations';
import type { AppState, Character, Costume, Room, Situation, StoreGet, StoreSet } from '../lib/store/types';
import { migrateCostumeOwner, normalizeCharactersForCostumeDiffs } from '../lib/visualDiffMigration';

vi.mock('../lib/db', () => ({
    putCharacter: vi.fn(async (character: Character) => character),
    putGroup: vi.fn(async (group: Situation) => group),
    putRoom: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => undefined),
    deleteGroup: vi.fn(async () => undefined),
    deleteRoom: vi.fn(async () => undefined),
    setMeta: vi.fn(async () => undefined),
}));

type LegacyCharacter = Omit<Character, 'costumes'> & {
    expressions?: { name: string; image: string }[];
    costumes?: Omit<Costume, 'id'>[];
};

const legacyCharacter = (overrides: Partial<LegacyCharacter> = {}): Character => ({
    id: 'character-1',
    name: '葵',
    systemPrompt: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
}) as unknown as Character;

const room = (overrides: Partial<Room> = {}): Room => ({
    id: 'room-1',
    characterId: 'character-1',
    name: 'チャット 1',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
});

describe('costume data migration', () => {
    test('moves root expressions into the legacy default costume and keeps its image', () => {
        const migrated = migrateCostumeOwner(legacyCharacter({
            expressions: [
                { name: 'neutral', image: 'neutral.png' },
                { name: 'happy', image: 'happy.png' },
            ],
            costumes: [
                { name: 'uniform', image: 'uniform.png' },
                { name: 'Default', image: 'default-costume.png', description: '普段着' },
            ],
        }));

        expect(migrated).not.toHaveProperty('expressions');
        const costumes = migrated.costumes ?? [];
        expect(costumes.map((costume) => costume.name)).toEqual(['uniform', 'Default']);
        expect(costumes.every((costume) => typeof costume.id === 'string' && costume.id.length > 0)).toBe(true);
        expect(new Set(costumes.map((costume) => costume.id)).size).toBe(2);
        const defaultCostume = costumes[1];
        expect(migrated.defaultCostumeId).toBe(defaultCostume.id);
        expect(defaultCostume).toMatchObject({
            name: 'Default',
            image: 'default-costume.png',
            description: '普段着',
            expressions: [{ name: 'happy', image: 'happy.png' }],
        });
    });

    test('creates a default costume from the neutral expression when none exists', () => {
        const migrated = migrateCostumeOwner(legacyCharacter({
            expressions: [
                { name: 'happy', image: 'happy.png' },
                { name: 'NEUTRAL', image: 'neutral.png' },
            ],
            costumes: [{ name: 'uniform', image: 'uniform.png' }],
        }));

        const [created, uniform] = migrated.costumes ?? [];
        expect(created).toMatchObject({
            name: 'default',
            image: 'neutral.png',
            expressions: [{ name: 'happy', image: 'happy.png' }],
        });
        expect(uniform.name).toBe('uniform');
        expect(migrated.defaultCostumeId).toBe(created.id);
    });

    test('uses the first costume as the default when no legacy default exists', () => {
        const migrated = migrateCostumeOwner(legacyCharacter({
            costumes: [
                { name: 'uniform', image: 'uniform.png' },
                { name: 'casual', image: 'casual.png' },
            ],
        }));
        expect(migrated.defaultCostumeId).toBe(migrated.costumes?.[0].id);
    });

    test('is idempotent and leaves current data untouched', () => {
        const once = migrateCostumeOwner(legacyCharacter({
            expressions: [{ name: 'neutral', image: 'neutral.png' }],
            costumes: [{ name: 'uniform', image: 'uniform.png' }],
        }));
        expect(migrateCostumeOwner(once)).toBe(once);
        const characters = [once];
        expect(normalizeCharactersForCostumeDiffs(characters)).toBe(characters);

        const bare = legacyCharacter();
        expect(migrateCostumeOwner(bare)).toBe(bare);
    });

    test('repairs duplicate costume ids and an invalid default reference', () => {
        const migrated = migrateCostumeOwner(legacyCharacter({
            defaultCostumeId: 'removed',
            costumes: [
                { id: 'same', name: 'a', image: 'a.png' },
                { id: 'same', name: 'b', image: 'b.png' },
            ] as Costume[],
        }));
        const [first, second] = migrated.costumes ?? [];
        expect(first.id).toBe('same');
        expect(second.id).not.toBe('same');
        expect(migrated.defaultCostumeId).toBe('same');
    });
});

describe('costume reference migration', () => {
    const character = migrateCostumeOwner(legacyCharacter({
        expressions: [{ name: 'neutral', image: 'neutral.png' }],
        costumes: [{ name: '制服', image: 'uniform.png' }],
    }));
    const uniformId = character.costumes?.find((costume) => costume.name === '制服')?.id;

    test('resolves ids, legacy names, and drops default or unknown references', () => {
        expect(resolveStoredCostumeReference(character, uniformId)).toBe(uniformId);
        expect(resolveStoredCostumeReference(character, '制服')).toBe(uniformId);
        expect(resolveStoredCostumeReference(character, 'default')).toBeUndefined();
        expect(resolveStoredCostumeReference(character, 'missing')).toBeUndefined();
        expect(resolveStoredCostumeReference(undefined, '制服')).toBeUndefined();
    });

    test('converts room selections and situation actors from names to ids', () => {
        const temporaryLegacy = {
            id: 'actor-temp',
            type: 'temporary',
            name: '通行人',
            systemPrompt: '',
            expressions: [
                { name: 'neutral', image: 'temp-neutral.png' },
                { name: 'smile', image: 'temp-smile.png' },
            ],
        };
        const situation = {
            id: 'situation-1',
            name: '放課後',
            actors: [
                { id: 'actor-1', type: 'character', characterId: character.id, costumeName: '制服' },
                { id: 'actor-2', type: 'character', characterId: character.id, costumeName: 'default' },
                temporaryLegacy,
            ],
            maxTurns: 1,
            memoryMode: 'off',
            createdAt: 1,
            updatedAt: 1,
        } as unknown as Situation;
        const rooms = [
            room({ id: 'solo', costumeSelections: { [character.id]: '制服' } }),
            room({ id: 'solo-default', costumeSelections: { [character.id]: 'default' } }),
            room({ id: 'solo-missing', costumeSelections: { [character.id]: 'missing', 'unknown-character': '制服' } }),
            room({ id: 'situation-room', characterId: 'actor-1', groupId: situation.id, costumeSelections: { 'actor-1': '制服' } }),
        ];

        const normalized = normalizeGroupData({ characters: [character], groups: [situation], rooms });
        const byId = new Map(normalized.rooms.map((entry) => [entry.id, entry]));
        expect(byId.get('solo')?.costumeSelections).toEqual({ [character.id]: uniformId });
        expect(byId.get('solo-default')?.costumeSelections).toBeUndefined();
        expect(byId.get('solo-missing')?.costumeSelections).toBeUndefined();
        expect(byId.get('situation-room')?.costumeSelections).toEqual({ 'actor-1': uniformId });

        const [group] = normalized.groups;
        expect(group.actors[0]).toEqual({ id: 'actor-1', type: 'character', characterId: character.id, costumeId: uniformId });
        expect(group.actors[1]).toEqual({ id: 'actor-2', type: 'character', characterId: character.id });
        const temporary = group.actors[2];
        if (temporary.type !== 'temporary') throw new Error('Expected a temporary actor');
        expect(temporary).not.toHaveProperty('expressions');
        expect(temporary.costumes?.[0]).toMatchObject({
            name: 'default',
            image: 'temp-neutral.png',
            expressions: [{ name: 'smile', image: 'temp-smile.png' }],
        });
        expect(temporary.defaultCostumeId).toBe(temporary.costumes?.[0].id);

        // The converted data is stable on the next load.
        const again = normalizeGroupData({ characters: [character], groups: normalized.groups, rooms: normalized.rooms });
        expect(again.changedGroups).toHaveLength(0);
        expect(again.changedRooms).toHaveLength(0);
        expect(again.groups).toEqual(normalized.groups);
    });

    test('reads a legacy full backup into the current costume format', () => {
        const backup = {
            version: 1,
            exportedAt: 1,
            type: 'full',
            data: {
                characters: [legacyCharacter({
                    expressions: [{ name: 'neutral', image: 'data:image/png;base64,AA==' }],
                    costumes: [
                        { name: 'default', image: 'data:image/png;base64,AA==' },
                        { name: '制服', image: 'data:image/png;base64,AQ==' },
                    ],
                })],
                situations: [],
                rooms: [{ ...room({ costumeSelections: { 'character-1': '制服' } }), messages: undefined }],
                messages: [],
                memories: [],
                usageRecords: [],
            },
        };
        const parsed = parseFullBackup(JSON.stringify(backup));
        const [parsedCharacter] = parsed.characters;
        expect(parsedCharacter).not.toHaveProperty('expressions');
        const uniform = parsedCharacter.costumes?.find((costume) => costume.name === '制服');
        expect(parsedCharacter.defaultCostumeId).toBe(parsedCharacter.costumes?.[0].id);

        const normalized = normalizeGroupData({ characters: parsed.characters, groups: parsed.groups, rooms: parsed.rooms });
        expect(normalized.rooms[0].costumeSelections).toEqual({ 'character-1': uniform?.id });
    });
});

describe('costume set operations', () => {
    const a: Costume = { id: 'a', name: 'default', image: 'a.png' };
    const b: Costume = { id: 'b', name: 'uniform', image: 'b.png' };
    const c: Costume = { id: 'c', name: 'casual', image: 'c.png' };

    test('the first added costume becomes the default and renaming keeps the reference', () => {
        let set: CostumeSet = { costumes: [] };
        set = upsertCostume(set, a);
        expect(set.defaultCostumeId).toBe('a');
        set = upsertCostume(set, b);
        set = upsertCostume(set, { ...a, name: 'renamed' });
        expect(set.costumes.map((costume) => costume.name)).toEqual(['renamed', 'uniform']);
        expect(set.defaultCostumeId).toBe('a');
    });

    test('switches the default costume', () => {
        const set = setDefaultCostume({ costumes: [a, b], defaultCostumeId: 'a' }, 'b');
        expect(resolveDefaultCostume(set)?.id).toBe('b');
        expect(setDefaultCostume(set, 'missing')).toBe(set);
    });

    test('moves the default when the default costume is removed and keeps the last costume', () => {
        const set = removeCostume({ costumes: [a, b, c], defaultCostumeId: 'b' }, 'b');
        expect(set.costumes.map((costume) => costume.id)).toEqual(['a', 'c']);
        expect(set.defaultCostumeId).toBe('a');
        const kept = removeCostume({ costumes: [c, a], defaultCostumeId: 'a' }, 'c');
        expect(kept.defaultCostumeId).toBe('a');
        const last = { costumes: [a], defaultCostumeId: 'a' };
        expect(removeCostume(last, 'a')).toBe(last);
    });

    test('resolves the active costume from a selection with default fallback', () => {
        const owner = { costumes: [a, b], defaultCostumeId: 'b' };
        expect(resolveActiveCostume(owner, 'a')?.id).toBe('a');
        expect(resolveActiveCostume(owner, 'removed')?.id).toBe('b');
        expect(resolveActiveCostume({ costumes: [a, b], defaultCostumeId: 'removed' }, null)?.id).toBe('a');
        expect(resolveActiveCostume({ costumes: [] }, 'a')).toBeNull();
    });
});

describe('removing a costume from a character', () => {
    function fakeStore(initial: Pick<AppState, 'characters' | 'groups' | 'rooms'>) {
        let state = initial as AppState;
        const set = ((partial: unknown) => {
            const patch = typeof partial === 'function'
                ? (partial as (current: AppState) => Partial<AppState>)(state)
                : (partial as Partial<AppState>);
            state = { ...state, ...patch };
        }) as unknown as StoreSet;
        const get = (() => state) as unknown as StoreGet;
        return { set, get, state: () => state };
    }

    test('clears room selections and situation costume references to the removed costume', () => {
        const character: Character = {
            id: 'character-1',
            name: '葵',
            systemPrompt: '',
            costumes: [
                { id: 'costume-a', name: 'default', image: 'a.png' },
                { id: 'costume-b', name: 'uniform', image: 'b.png' },
            ],
            defaultCostumeId: 'costume-a',
            createdAt: 1,
            updatedAt: 1,
        };
        const situation: Situation = {
            id: 'situation-1',
            name: '放課後',
            actors: [{ id: 'actor-1', type: 'character', characterId: character.id, costumeId: 'costume-b' }],
            maxTurns: 1,
            memoryMode: 'off',
            createdAt: 1,
            updatedAt: 1,
        };
        const store = fakeStore({
            characters: [character],
            groups: [situation],
            rooms: [
                room({ id: 'solo', costumeSelections: { [character.id]: 'costume-b' } }),
                room({ id: 'other', costumeSelections: { [character.id]: 'costume-a' } }),
                room({ id: 'situation-room', characterId: 'actor-1', groupId: situation.id, costumeSelections: { 'actor-1': 'costume-b' } }),
            ],
        });
        const slice = createCharacterSlice(store.set, store.get);

        // Renaming keeps every reference because rooms and situations refer to the id.
        slice.updateCharacter(character.id, {
            costumes: [character.costumes![0], { ...character.costumes![1], name: '制服' }],
        });
        expect(store.state().rooms.find((entry) => entry.id === 'solo')?.costumeSelections).toEqual({ [character.id]: 'costume-b' });

        slice.updateCharacter(character.id, { costumes: [character.costumes![0]], defaultCostumeId: 'costume-a' });
        const rooms = new Map(store.state().rooms.map((entry) => [entry.id, entry]));
        expect(rooms.get('solo')?.costumeSelections).toBeUndefined();
        expect(rooms.get('other')?.costumeSelections).toEqual({ [character.id]: 'costume-a' });
        expect(rooms.get('situation-room')?.costumeSelections).toBeUndefined();
        expect(store.state().groups[0].actors[0]).not.toHaveProperty('costumeId');
    });
});
