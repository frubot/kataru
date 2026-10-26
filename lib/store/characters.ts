import * as db from '../db';
import { generateId } from '../id';
import { normalizeCharactersForCostumeDiffs } from '../visualDiffMigration';
import { duplicateDedicatedMemories } from './memories';
import { fire, persistGroup, shouldPersistRoom, toStoredRoom } from './persistence';
import { getSituationActorIds, normalizeSituationActor } from './situations';
import type {
    AppState,
    Character,
    Room,
    Situation,
    SituationActor,
    StoreGet,
    StoreSet,
} from './types';

/** 保存データに残っている、もう使わない項目。モデルと生成パラメータは
 * キャラクターごとではなく全体設定で持つようになった。 */
const OBSOLETE_CHARACTER_KEYS = [
    'model',
    'aiApiType',
    'temperature',
    'topP',
    'topK',
    'frequencyPenalty',
    'presencePenalty',
    'repetitionPenalty',
    'reasoningEffort',
    'enableThinking',
    'thinkModeEnabled',
    'maxTokens',
    'enableSummary',
] as const;

/** 旧形式の項目を取り除く。変更がなければ同じオブジェクトを返し、書き戻しを避ける。 */
export function stripObsoleteCharacterFields<T extends object>(character: T): T {
    if (!OBSOLETE_CHARACTER_KEYS.some((key) => key in character)) return character;
    const next = { ...character } as Record<string, unknown>;
    for (const key of OBSOLETE_CHARACTER_KEYS) delete next[key];
    return next as T;
}

export function normalizeCharacters(characters: Character[]): Character[] {
    return normalizeCharactersForCostumeDiffs(characters).map(stripObsoleteCharacterFields);
}

type CharacterSlice = Pick<
    AppState,
    | 'characters'
    | 'createCharacter'
    | 'updateCharacter'
    | 'deleteCharacter'
    | 'duplicateCharacter'
    | 'addImportedCharacter'
    | 'getCharacter'
>;

export function createCharacterSlice(set: StoreSet, get: StoreGet): CharacterSlice {
    const persistCharacter = async (submitted: Character) => {
        const stored = await db.putCharacter(submitted);
        // Release imported binary data from state once the server has returned asset references.
        // A later edit must never be overwritten by an older save response.
        if (stored && get().characters.some((character) => character === submitted)) {
            set((state) => ({ characters: state.characters.map((character) => character === submitted ? stored : character) }));
        }
    };
    return {
        characters: [],

        createCharacter: (name, systemPrompt = '', extras) => {
            const id = generateId();
            const now = Date.now();
            const character: Character = {
                id,
                name,
                systemPrompt,
                ...(extras ?? {}),
                createdAt: now,
                updatedAt: now,
            };
            set((state) => ({ characters: [...state.characters, character] }));
            fire(persistCharacter(character));
            return id;
        },

        updateCharacter: (id, updates) => {
            let updated: Character | undefined;
            set((state) => ({
                characters: state.characters.map((character) => {
                    if (character.id !== id) return character;
                    updated = { ...character, ...updates, updatedAt: Date.now() };
                    return updated;
                }),
            }));
            if (updated) fire(persistCharacter(updated));
        },

        deleteCharacter: (id) => {
            const state = get();
            const now = Date.now();
            const validCharacterIds = new Set(
                state.characters.map((character) => character.id).filter((characterId) => characterId !== id),
            );
            const groupResolution = new Map<
                string,
                | { type: 'keep'; group: Situation; removedActorIds: string[] }
                | { type: 'delete'; removedActorIds: string[] }
            >();
            const updatedGroups: Situation[] = [];
            const groupsToDelete: string[] = [];
            const nextGroups: Situation[] = [];

            for (const group of state.groups) {
                const removedActorIds = group.actors
                    .filter((actor) => actor.type === 'character' && actor.characterId === id)
                    .map((actor) => actor.id);
                if (removedActorIds.length === 0) {
                    nextGroups.push(group);
                    continue;
                }

                const remainingActors = group.actors
                    .filter((actor) => !(actor.type === 'character' && actor.characterId === id))
                    .map((actor) => normalizeSituationActor(actor, validCharacterIds))
                    .filter((actor): actor is SituationActor => actor != null);
                if (remainingActors.length > 0) {
                    const nextGroup = {
                        ...group,
                        actors: remainingActors,
                        updatedAt: now,
                    };
                    nextGroups.push(nextGroup);
                    updatedGroups.push(nextGroup);
                    groupResolution.set(group.id, { type: 'keep', group: nextGroup, removedActorIds });
                } else {
                    groupsToDelete.push(group.id);
                    groupResolution.set(group.id, { type: 'delete', removedActorIds });
                }
            }

            const updatedRooms: Room[] = [];
            const roomsToDelete: string[] = [];
            const roomsToUpdate: Room[] = [];
            for (const room of state.rooms) {
                const nextSelections = { ...(room.costumeSelections ?? {}) };
                delete nextSelections[id];
                const resolution = room.groupId ? groupResolution.get(room.groupId) : undefined;
                for (const removedActorId of resolution?.removedActorIds ?? []) {
                    delete nextSelections[removedActorId];
                }
                const costumeSelections = Object.keys(nextSelections).length > 0 ? nextSelections : undefined;

                if (room.groupId && resolution) {
                    if (resolution.type === 'keep') {
                        const actorIds = getSituationActorIds(resolution.group);
                        const next = {
                            ...room,
                            characterId: actorIds[0],
                            costumeSelections,
                        };
                        updatedRooms.push(next);
                        roomsToUpdate.push(next);
                    } else {
                        roomsToDelete.push(room.id);
                    }
                } else if (room.characterId === id) {
                    roomsToDelete.push(room.id);
                } else {
                    updatedRooms.push(room);
                }
            }
            const nextCurrent = roomsToDelete.includes(state.currentRoomId || '')
                ? null
                : state.currentRoomId;
            set({
                characters: state.characters.filter((character) => character.id !== id),
                groups: nextGroups,
                rooms: updatedRooms,
                currentRoomId: nextCurrent,
            });
            fire(db.deleteCharacter(id));
            for (const groupId of groupsToDelete) fire(db.deleteGroup(groupId));
            for (const group of updatedGroups) fire(persistGroup(set, get, group));
            for (const roomId of roomsToDelete) fire(db.deleteRoom(roomId));
            for (const room of roomsToUpdate) {
                if (shouldPersistRoom(room)) fire(db.putRoom(toStoredRoom(room)));
            }
            if (nextCurrent !== state.currentRoomId) {
                fire(db.setMeta('currentRoomId', nextCurrent));
            }
        },

        duplicateCharacter: (id) => {
            const source = get().characters.find((character) => character.id === id);
            if (!source) return '';
            const newId = generateId();
            const now = Date.now();
            const baseName = source.name.replace(/\s*\(\d+\)$/, '');
            const existingNames = new Set(get().characters.map((character) => character.name));
            let index = 1;
            while (existingNames.has(`${baseName} (${index})`)) index += 1;
            const next: Character = {
                ...source,
                id: newId,
                name: `${baseName} (${index})`,
                createdAt: now,
                updatedAt: now,
            };
            set((state) => ({ characters: [...state.characters, next] }));
            fire(persistCharacter(next));
            fire(duplicateDedicatedMemories(source.id, newId));
            return newId;
        },

        addImportedCharacter: (character) => {
            // サーバーが永続化済みのCharacter（asset参照）をそのままstateへ追加する。
            set((state) => ({ characters: [...state.characters, character] }));
        },

        getCharacter: (id) => get().characters.find((character) => character.id === id),
    };
}
