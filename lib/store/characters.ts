import * as db from '../db';
import { generateId } from '../id';
import { DEFAULT_CHAT_MODEL } from '../modelDefaults';
import { normalizeCharactersForCostumeDiffs } from '../visualDiffMigration';
import { duplicateDedicatedMemories } from './memories';
import { fire, shouldPersistRoom, toStoredRoom } from './persistence';
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

export function resolveCharacterModel(model: string | undefined, fallbackModel: string): string {
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    if (normalizedModel) return normalizedModel;
    return fallbackModel.trim() || DEFAULT_CHAT_MODEL;
}

export function normalizeCharacterModel(character: Character, fallbackModel: string): Character {
    const model = resolveCharacterModel(character.model, fallbackModel);
    const normalized = { ...character } as Character & {
        thinkModeEnabled?: boolean;
        maxTokens?: number;
        enableSummary?: boolean;
    };
    const hadLegacyThinkMode = 'thinkModeEnabled' in normalized;
    const hadLegacyMaxTokens = 'maxTokens' in normalized;
    const hadLegacyEnableSummary = 'enableSummary' in normalized;
    delete normalized.thinkModeEnabled;
    delete normalized.maxTokens;
    delete normalized.enableSummary;
    return model === character.model && !hadLegacyThinkMode && !hadLegacyMaxTokens && !hadLegacyEnableSummary
        ? character
        : { ...normalized, model };
}

export function normalizeCharacters(characters: Character[], fallbackModel: string): Character[] {
    return normalizeCharactersForCostumeDiffs(characters)
        .map((character) => normalizeCharacterModel(character, fallbackModel));
}

type CharacterSlice = Pick<
    AppState,
    | 'characters'
    | 'createCharacter'
    | 'updateCharacter'
    | 'deleteCharacter'
    | 'duplicateCharacter'
    | 'getCharacter'
>;

export function createCharacterSlice(set: StoreSet, get: StoreGet): CharacterSlice {
    return {
        characters: [],

        createCharacter: (name, systemPrompt = '', model = get().defaultChatModel, extras) => {
            const id = generateId();
            const now = Date.now();
            const character: Character = {
                id,
                name,
                systemPrompt,
                ...(extras ?? {}),
                model: resolveCharacterModel(model, get().defaultChatModel),
                createdAt: now,
                updatedAt: now,
            };
            set((state) => ({ characters: [...state.characters, character] }));
            fire(db.putCharacter(character));
            return id;
        },

        updateCharacter: (id, updates) => {
            let updated: Character | undefined;
            const normalizedUpdates = 'model' in updates
                ? { ...updates, model: resolveCharacterModel(updates.model, get().defaultChatModel) }
                : updates;
            set((state) => ({
                characters: state.characters.map((character) => {
                    if (character.id !== id) return character;
                    updated = { ...character, ...normalizedUpdates, updatedAt: Date.now() };
                    return updated;
                }),
            }));
            if (updated) fire(db.putCharacter(updated));
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
                    .map((actor) => normalizeSituationActor(actor, validCharacterIds, get().defaultChatModel))
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
            for (const group of updatedGroups) fire(db.putGroup(group));
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
                model: resolveCharacterModel(source.model, get().defaultChatModel),
                createdAt: now,
                updatedAt: now,
            };
            set((state) => ({ characters: [...state.characters, next] }));
            fire(db.putCharacter(next));
            fire(duplicateDedicatedMemories(source.id, newId));
            return newId;
        },

        getCharacter: (id) => get().characters.find((character) => character.id === id),
    };
}
