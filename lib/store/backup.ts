import * as db from '../db';
import { normalizeCharacters } from './characters';
import { nextRoomLoadSequence, toStoredRoom } from './persistence';
import { normalizeGroupData } from './situations';
import type { AppState, ParsedBackup, Room, StoreGet, StoreSet } from './types';

type BackupSlice = Pick<AppState, 'mergeBackup' | 'restoreBackup'>;

export function createBackupSlice(set: StoreSet, get: StoreGet): BackupSlice {
    return {
        mergeBackup: async (data) => {
            const characters = normalizeCharacters(data.characters, get().defaultChatModel);
            const normalizedGroups = normalizeGroupData({
                characters,
                groups: data.groups,
                rooms: data.rooms,
                fallbackModel: get().defaultChatModel,
                directorFallbackModel: get().defaultDirectorModel,
            });
            const normalizedData: ParsedBackup = {
                ...data,
                characters,
                groups: normalizedGroups.groups,
                rooms: normalizedGroups.rooms,
            };
            const storedGroups = normalizedData.groups;
            const storedRooms = normalizedData.rooms.map(toStoredRoom);
            const storedMessages = normalizedData.rooms.flatMap((r) =>
                (r.messages ?? []).map((m) => ({ ...m, roomId: r.id }))
            );
            const stored = await db.bulkWrite({
                characters: normalizedData.characters,
                groups: storedGroups,
                rooms: storedRooms,
                messages: storedMessages,
                memories: normalizedData.memories,
                usageRecords: normalizedData.usageRecords,
            });
            // Keep the server's asset references in state so imported binary data
            // (especially VRM models) is not retained in memory.
            const storedCharacters = new Map(stored.characters.map((c) => [c.id, c]));
            const storedSituations = new Map(stored.groups.map((g) => [g.id, g]));
            set((state) => ({
                characters: [
                    ...state.characters,
                    ...normalizedData.characters.map((c) => storedCharacters.get(c.id) ?? c),
                ],
                groups: [
                    ...state.groups,
                    ...normalizedData.groups.map((g) => storedSituations.get(g.id) ?? g),
                ],
                rooms: [
                    ...state.rooms,
                    // Messages lazy-load from the database when the room is opened.
                    ...normalizedData.rooms.map((r) => ({ ...r, messages: [] })),
                ],
                usageRecords: [...state.usageRecords, ...normalizedData.usageRecords],
            }));
        },

        restoreBackup: async (data) => {
            const characters = normalizeCharacters(data.characters, get().defaultChatModel);
            const normalizedGroups = normalizeGroupData({
                characters,
                groups: data.groups,
                rooms: data.rooms,
                fallbackModel: get().defaultChatModel,
                directorFallbackModel: get().defaultDirectorModel,
            });
            const normalizedData: ParsedBackup = {
                ...data,
                characters,
                groups: normalizedGroups.groups,
                rooms: normalizedGroups.rooms,
            };
            const nextCurrentRoomId = normalizedData.rooms
                .reduce<Room | null>((latest, room) => (!latest || room.updatedAt > latest.updatedAt ? room : latest), null)
                ?.id ?? null;
            const storedGroups = normalizedData.groups;
            const storedRooms = normalizedData.rooms.map(toStoredRoom);
            const storedMessages = normalizedData.rooms.flatMap((r) =>
                (r.messages ?? []).map((m) => ({ ...m, roomId: r.id }))
            );
            const stored = await db.replaceAll({
                characters: normalizedData.characters,
                groups: storedGroups,
                rooms: storedRooms,
                messages: storedMessages,
                memories: normalizedData.memories,
                usageRecords: normalizedData.usageRecords,
                currentRoomId: nextCurrentRoomId,
            });
            nextRoomLoadSequence();
            const storedCharacters = new Map(stored.characters.map((c) => [c.id, c]));
            const storedSituations = new Map(stored.groups.map((g) => [g.id, g]));
            set({
                characters: normalizedData.characters.map((c) => storedCharacters.get(c.id) ?? c),
                groups: normalizedData.groups.map((g) => storedSituations.get(g.id) ?? g),
                rooms: normalizedData.rooms.map((r) => ({
                    ...r,
                    messages: r.id === nextCurrentRoomId ? r.messages ?? [] : [],
                })),
                usageRecords: normalizedData.usageRecords,
                currentRoomId: nextCurrentRoomId,
            });
        },
    };
}
