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
    /**
     * 削除された衣装を参照する部屋の衣装選択とシチュエーションの衣装指定を取り除き、
     * キャラクターのデフォルト衣装に従うようにする。
     */
    const clearRemovedCostumeReferences = (characterId: string, removedCostumeIds: Set<string>) => {
        const state = get();
        const now = Date.now();
        const changedGroups: Situation[] = [];
        const clearedActorIds = new Set<string>();
        const groups = state.groups.map((group) => {
            let changed = false;
            const actors = group.actors.map((actor) => {
                if (actor.type !== 'character' || actor.characterId !== characterId) return actor;
                if (!actor.costumeId || !removedCostumeIds.has(actor.costumeId)) return actor;
                changed = true;
                clearedActorIds.add(actor.id);
                const next = { ...actor };
                delete next.costumeId;
                return next;
            });
            if (!changed) return group;
            const next = { ...group, actors, updatedAt: now };
            changedGroups.push(next);
            return next;
        });

        const changedRooms: Room[] = [];
        const rooms = state.rooms.map((room) => {
            const selections = room.costumeSelections;
            if (!selections) return room;
            const keys = room.groupId
                ? Object.keys(selections).filter((key) => clearedActorIds.has(key))
                : Object.keys(selections).filter((key) => key === characterId && removedCostumeIds.has(selections[key]));
            if (keys.length === 0) return room;
            const nextSelections = { ...selections };
            for (const key of keys) delete nextSelections[key];
            const next: Room = {
                ...room,
                costumeSelections: Object.keys(nextSelections).length > 0 ? nextSelections : undefined,
            };
            changedRooms.push(next);
            return next;
        });

        if (changedGroups.length === 0 && changedRooms.length === 0) return;
        set({ groups, rooms });
        for (const group of changedGroups) fire(persistGroup(set, get, group));
        for (const room of changedRooms) {
            if (shouldPersistRoom(room)) fire(db.putRoom(toStoredRoom(room)));
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
            let previous: Character | undefined;
            let updated: Character | undefined;
            set((state) => ({
                characters: state.characters.map((character) => {
                    if (character.id !== id) return character;
                    previous = character;
                    updated = { ...character, ...updates, updatedAt: Date.now() };
                    return updated;
                }),
            }));
            if (!updated || !previous) return;
            fire(persistCharacter(updated));

            const remainingCostumeIds = new Set((updated.costumes ?? []).map((costume) => costume.id));
            const removedCostumeIds = new Set(
                (previous.costumes ?? [])
                    .map((costume) => costume.id)
                    .filter((costumeId) => !remainingCostumeIds.has(costumeId)),
            );
            if (removedCostumeIds.size > 0) clearRemovedCostumeReferences(id, removedCostumeIds);
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
            // サーバーが永続化済みのCharacter（asset参照）をstateへ追加する。
            // 旧形式のパッケージは衣装データを現行形式へ変換してから保存し直す。
            const normalized = normalizeCharacters([character])[0];
            set((state) => ({ characters: [...state.characters, normalized] }));
            if (normalized !== character) fire(persistCharacter(normalized));
        },

        getCharacter: (id) => get().characters.find((character) => character.id === id),
    };
}
