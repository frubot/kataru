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
            await db.bulkWrite({
                characters: normalizedData.characters,
                groups: storedGroups,
                rooms: storedRooms,
                messages: storedMessages,
                memories: normalizedData.memories,
                usageRecords: normalizedData.usageRecords,
            });
            set((state) => ({
                characters: [...state.characters, ...normalizedData.characters],
                groups: [...state.groups, ...normalizedData.groups],
                rooms: [...state.rooms, ...normalizedData.rooms],
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
            await db.replaceAll({
                characters: normalizedData.characters,
                groups: storedGroups,
                rooms: storedRooms,
                messages: storedMessages,
                memories: normalizedData.memories,
                usageRecords: normalizedData.usageRecords,
                currentRoomId: nextCurrentRoomId,
            });
            nextRoomLoadSequence();
            set({
                characters: normalizedData.characters,
                groups: normalizedData.groups,
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
