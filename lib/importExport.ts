import type { Character, MemoryRecord, Message, Room, Situation, UsageRecord } from './store';
import * as db from './db';
import { normalizeCharactersForCostumeDiffs } from './visualDiffMigration';
import { generateId } from './id';

type StoredRoom = Omit<Room, 'messages'>;
type StoredMessage = Message & { roomId: string };

export interface FullBackup {
    version: 1;
    exportedAt: number;
    type: 'full';
    data: {
        characters: Character[];
        situations: Situation[];
        rooms: StoredRoom[];
        messages: StoredMessage[];
        memories: MemoryRecord[];
        usageRecords: UsageRecord[];
    };
}

export interface ParsedBackup {
    characters: Character[];
    groups: Situation[];
    rooms: Room[];
    memories: MemoryRecord[];
    usageRecords: UsageRecord[];
}

function getSituationActorIds(situation: Situation): string[] {
    return situation.actors
        .map((actor) => actor.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function isValidSituation(situation: Situation, characterIds: Set<string>): boolean {
    if (!Array.isArray(situation.actors) || situation.actors.length === 0) return false;
    const actorIds = getSituationActorIds(situation);
    if (actorIds.length === 0) return false;
    if (new Set(actorIds).size !== actorIds.length) return false;

    return situation.actors.every((actor) => {
        if (actor.type === 'character') {
            return typeof actor.id === 'string' &&
                typeof actor.characterId === 'string' &&
                characterIds.has(actor.characterId);
        }
        if (actor.type === 'temporary') {
            return typeof actor.id === 'string' &&
                typeof actor.name === 'string' &&
                actor.name.trim().length > 0;
        }
        return false;
    });
}

export async function createFullBackup(): Promise<string> {
    const [characters, groups, rooms, messagesAll, memories, usageRecords] = await Promise.all([
        db.getAllCharacters(),
        db.getAllGroups(),
        db.getAllRooms(),
        db.getAllMessages(),
        db.getAllMemories(),
        db.getAllUsageRecords(),
    ]);
    const backup: FullBackup = {
        version: 1,
        exportedAt: Date.now(),
        type: 'full',
        data: { characters, situations: groups, rooms, messages: messagesAll, memories, usageRecords },
    };
    return JSON.stringify(backup, null, 2);
}

export function downloadJson(json: string, filename: string) {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// IndexedDB では大容量保存が可能だが、実運用上の安全圏として上限を設ける
const MAX_IMPORT_SIZE_MB = 256;
const MAX_IMPORT_SIZE = MAX_IMPORT_SIZE_MB * 1024 * 1024;

export function parseFullBackup(json: string): ParsedBackup {
    if (json.length > MAX_IMPORT_SIZE) {
        throw new Error(`インポートデータが大きすぎます（${(json.length / 1024 / 1024).toFixed(1)}MB）。${MAX_IMPORT_SIZE_MB}MB以下にしてください。`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error('JSONの解析に失敗しました');
    }

    const b = parsed as FullBackup;
    if (
        typeof b !== 'object' ||
        b === null ||
        b.version !== 1 ||
        b.type !== 'full' ||
        !Array.isArray(b.data?.characters) ||
        !Array.isArray(b.data?.situations) ||
        !Array.isArray(b.data?.rooms) ||
        !Array.isArray(b.data?.messages) ||
        !Array.isArray(b.data?.memories) ||
        !Array.isArray(b.data?.usageRecords)
    ) {
        throw new Error('バックアップファイルの形式が正しくありません');
    }

    const characters: Character[] = normalizeCharactersForCostumeDiffs(b.data.characters);
    const groups = b.data.situations;
    const messagesByRoom = new Map<string, Message[]>();
    for (const m of b.data.messages) {
        const { roomId, ...msg } = m;
        if (!messagesByRoom.has(roomId)) messagesByRoom.set(roomId, []);
        messagesByRoom.get(roomId)!.push(msg);
    }
    for (const messages of messagesByRoom.values()) {
        messages.sort((a, b) => a.timestamp - b.timestamp);
    }
    const rooms: Room[] = b.data.rooms.map((room) => ({
        ...room,
        messages: messagesByRoom.get(room.id) ?? [],
    }));
    const usageRecords = b.data.usageRecords;
    const memories = b.data.memories;

    for (const c of characters) {
        if (typeof c.id !== 'string' || typeof c.name !== 'string') {
            throw new Error(`キャラクターデータが不正です: ${c.name ?? '(不明)'}`);
        }
    }

    const characterIds = new Set(characters.map((c) => c.id));
    const orphanedGroups = groups.filter((g) => !isValidSituation(g, characterIds));
    if (orphanedGroups.length > 0) {
        throw new Error(`${orphanedGroups.length}件のシチュエーションが存在しないキャラクターを参照しています`);
    }

    const groupIds = new Set(groups.map((g) => g.id));
    const actorIdsByGroup = new Map(groups.map((g) => [g.id, new Set(getSituationActorIds(g))]));
    const validUsageCharacterIds = new Set(characterIds);
    for (const group of groups) {
        for (const actorId of getSituationActorIds(group)) {
            validUsageCharacterIds.add(actorId);
        }
        validUsageCharacterIds.add(`${group.id}:director`);
    }

    const orphanedRooms = rooms.filter((r) => {
        if (r.groupId) {
            const actorIds = actorIdsByGroup.get(r.groupId);
            return !actorIds || !actorIds.has(r.characterId);
        }
        return !characterIds.has(r.characterId);
    });
    if (orphanedRooms.length > 0) {
        throw new Error(`${orphanedRooms.length}件のルームが存在しないキャラクターを参照しています`);
    }

    const orphanedGroupRefs = rooms.filter((r) =>
        r.groupId && !groupIds.has(r.groupId)
    );
    if (orphanedGroupRefs.length > 0) {
        throw new Error(`${orphanedGroupRefs.length}件のシチュエーションルームが存在しない参加者を参照しています`);
    }

    const orphanedMessageRefs = rooms.flatMap((r) =>
        (r.messages ?? [])
            .filter((m) => {
                const validSpeakerIds = r.groupId
                    ? actorIdsByGroup.get(r.groupId) ?? new Set<string>()
                    : characterIds;
                return (m.characterId && !validSpeakerIds.has(m.characterId)) ||
                    (m.toCharacterIds ?? []).some((id) => !validSpeakerIds.has(id));
            })
            .map((m) => ({ roomId: r.id, messageId: m.id }))
    );
    if (orphanedMessageRefs.length > 0) {
        throw new Error(`${orphanedMessageRefs.length}件のメッセージが存在しないキャラクターを参照しています`);
    }

    const orphanedRecords = usageRecords.filter((u) => !validUsageCharacterIds.has(u.characterId));
    const roomIds = new Set(rooms.map((r) => r.id));
    const orphanedMemories = memories.filter((memory) =>
        (memory.characterId && !characterIds.has(memory.characterId)) ||
        (memory.roomId && !roomIds.has(memory.roomId)) ||
        (memory.sourceRoomId && !roomIds.has(memory.sourceRoomId))
    );
    const validMemories = memories.filter((memory) => !orphanedMemories.includes(memory));
    if (orphanedRecords.length > 0) {
        return {
            characters,
            groups,
            rooms,
            memories: validMemories,
            usageRecords: usageRecords.filter((u) => validUsageCharacterIds.has(u.characterId)),
        };
    }

    return { characters, groups, rooms, memories: validMemories, usageRecords };
}

// IDを全て再生成してマージ時の衝突を防ぐ
export function reassignIds(parsed: ParsedBackup): ParsedBackup {
    const charIdMap = new Map<string, string>();
    const groupIdMap = new Map<string, string>();
    const actorIdMap = new Map<string, string>();
    const roomIdMap = new Map<string, string>();
    const messageIdMap = new Map<string, string>();

    const characters = parsed.characters.map((c) => {
        const newId = generateId();
        charIdMap.set(c.id, newId);
        return { ...c, id: newId };
    });

    const groups = parsed.groups.map((g) => {
        const newId = generateId();
        groupIdMap.set(g.id, newId);
        const actors = g.actors.map((actor) => {
            const newActorId = actor.type === 'character'
                ? actor.id === actor.characterId
                    ? charIdMap.get(actor.characterId) ?? generateId()
                    : generateId()
                : generateId();
            actorIdMap.set(actor.id, newActorId);
            if (actor.type === 'character') {
                return {
                    ...actor,
                    id: newActorId,
                    characterId: charIdMap.get(actor.characterId) ?? actor.characterId,
                };
            }
            return {
                ...actor,
                id: newActorId,
            };
        });
        const priorMessages = g.priorMessages?.map((message) => (
            message.role === 'assistant'
                ? { ...message, actorId: actorIdMap.get(message.actorId) ?? message.actorId }
                : message
        ));
        return {
            ...g,
            id: newId,
            actors,
            ...(priorMessages ? { priorMessages } : {}),
        };
    });

    const rooms = parsed.rooms.map((r) => {
        const newRoomId = generateId();
        roomIdMap.set(r.id, newRoomId);
        const costumeSelections = r.costumeSelections
            ? Object.fromEntries(
                Object.entries(r.costumeSelections).map(([characterId, costumeName]) => [
                    actorIdMap.get(characterId) ?? charIdMap.get(characterId) ?? characterId,
                    costumeName,
                ])
            )
            : undefined;
        const isSituationRoom = !!r.groupId;

        return {
            ...r,
            id: newRoomId,
            characterId: isSituationRoom
                ? actorIdMap.get(r.characterId) ?? charIdMap.get(r.characterId) ?? r.characterId
                : charIdMap.get(r.characterId) ?? r.characterId,
            groupId: r.groupId ? groupIdMap.get(r.groupId) ?? r.groupId : undefined,
            costumeSelections,
            messages: (r.messages ?? []).map((m) => {
                const newMessageId = generateId();
                messageIdMap.set(m.id, newMessageId);
                return {
                    ...m,
                    id: newMessageId,
                    characterId: m.characterId
                        ? actorIdMap.get(m.characterId) ?? charIdMap.get(m.characterId) ?? m.characterId
                        : undefined,
                    toCharacterIds: m.toCharacterIds?.map((id) => actorIdMap.get(id) ?? charIdMap.get(id) ?? id),
                };
            }),
        };
    });

    const memories = parsed.memories.map((memory) => ({
        ...memory,
        id: generateId(),
        characterId: memory.characterId ? charIdMap.get(memory.characterId) ?? memory.characterId : undefined,
        roomId: memory.roomId ? roomIdMap.get(memory.roomId) ?? memory.roomId : undefined,
        sourceRoomId: memory.sourceRoomId ? roomIdMap.get(memory.sourceRoomId) ?? memory.sourceRoomId : undefined,
        sourceMessageIds: memory.sourceMessageIds.map((id) => messageIdMap.get(id) ?? id),
    }));

    const usageRecords = parsed.usageRecords.map((u) => ({
        ...u,
        id: generateId(),
        characterId: actorIdMap.get(u.characterId) ?? charIdMap.get(u.characterId) ?? u.characterId,
    }));

    return { characters, groups, rooms, memories, usageRecords };
}
