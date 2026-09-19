import { isAiConnectionKind, type ModelRef } from '../aiApi';
import { createAiConnection, getAiConnections } from '../aiConnections';
import * as db from '../db';
import { normalizeCharacters } from './characters';
import { nextRoomLoadSequence, toStoredRoom } from './persistence';
import { normalizeGroupData } from './situations';
import type { AppState, ParsedBackup, Room, StoreGet, StoreSet } from './types';

type BackupSlice = Pick<AppState, 'mergeBackup' | 'restoreBackup'>;

// カスタム接続（cx_*）のIDは環境固有のため、バックアップのメタデータを元に
// 既存接続への対応付け・非秘密情報のみでの再作成を行い、IDを張り替える。
async function remapBackupConnectionIds(data: ParsedBackup, get: StoreGet): Promise<void> {
    const referencedIds = new Set<string>();
    for (const character of data.characters) {
        referencedIds.add(character.model.connectionId);
    }
    for (const group of data.groups) {
        referencedIds.add(group.director.model.connectionId);
        for (const actor of group.actors) {
            if (actor.type === 'temporary' && actor.model) {
                referencedIds.add(actor.model.connectionId);
            }
        }
    }
    for (const memory of data.memories) {
        const embeddingConnectionId = (memory as { embeddingConnectionId?: string }).embeddingConnectionId;
        if (embeddingConnectionId) referencedIds.add(embeddingConnectionId);
    }

    let connections = await getAiConnections()
        .then((response) => response.connections)
        .catch(() => null);
    const knownIds = new Set((connections ?? []).map((connection) => connection.id));
    const missingIds = [...referencedIds]
        .filter((id) => !isAiConnectionKind(id) && !knownIds.has(id));
    if (missingIds.length === 0) return;

    const fallbackId = get().defaultChatModel.connectionId;
    const exportedById = new Map((data.connections ?? []).map((connection) => [connection.id, connection]));
    const remap = new Map<string, string>();
    for (const oldId of missingIds) {
        const exported = exportedById.get(oldId);
        let newId: string | undefined;
        if (exported) {
            // kind + baseUrl が一致する既存のカスタム接続があれば再利用する。
            const reusable = (connections ?? []).find((connection) => (
                !connection.builtin
                && connection.kind === exported.kind
                && (connection.baseUrl ?? undefined) === exported.baseUrl
            ));
            if (reusable) {
                newId = reusable.id;
            } else {
                try {
                    const beforeIds = new Set((connections ?? []).map((connection) => connection.id));
                    const response = await createAiConnection({
                        name: exported.name,
                        kind: exported.kind,
                        ...(exported.baseUrl ? { baseUrl: exported.baseUrl } : {}),
                        ...(exported.embeddingsEnabled !== undefined
                            ? { embeddingsEnabled: exported.embeddingsEnabled }
                            : {}),
                        ...(exported.imageGenerationEnabled !== undefined
                            ? { imageGenerationEnabled: exported.imageGenerationEnabled }
                            : {}),
                        ...(exported.ttsEnabled !== undefined
                            ? { ttsEnabled: exported.ttsEnabled }
                            : {}),
                        ...(exported.ignoredProviders !== undefined
                            ? { ignoredProviders: exported.ignoredProviders }
                            : {}),
                    });
                    connections = response.connections;
                    newId = (response.connections.find((connection) => (
                        !beforeIds.has(connection.id)
                        && connection.kind === exported.kind
                        && (connection.baseUrl ?? undefined) === exported.baseUrl
                        && connection.name === exported.name
                    )) ?? response.connections.find((connection) => !beforeIds.has(connection.id)))?.id;
                } catch {
                    newId = undefined;
                }
            }
        }
        remap.set(oldId, newId ?? fallbackId);
    }

    const remapRef = (ref: ModelRef): ModelRef => {
        const mapped = remap.get(ref.connectionId);
        return mapped ? { ...ref, connectionId: mapped } : ref;
    };
    for (const character of data.characters) {
        character.model = remapRef(character.model);
    }
    for (const group of data.groups) {
        group.director = { ...group.director, model: remapRef(group.director.model) };
        group.actors = group.actors.map((actor) => (
            actor.type === 'temporary' && actor.model
                ? { ...actor, model: remapRef(actor.model) }
                : actor
        ));
    }
    for (const memory of data.memories) {
        const record = memory as { embeddingConnectionId?: string };
        const mapped = record.embeddingConnectionId ? remap.get(record.embeddingConnectionId) : undefined;
        if (mapped) record.embeddingConnectionId = mapped;
    }
}

export function createBackupSlice(set: StoreSet, get: StoreGet): BackupSlice {
    return {
        mergeBackup: async (data) => {
            await remapBackupConnectionIds(data, get);
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
            await remapBackupConnectionIds(data, get);
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
