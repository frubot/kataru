import type {
    Character,
    MemoryRecord,
    Message,
    ParsedBackup,
    Room,
    Situation,
    UsageRecord,
} from './store/types';
import * as db from './db';
import { normalizeCharactersForCostumeDiffs } from './visualDiffMigration';
import { generateId } from './id';

export type { ParsedBackup } from './store/types';

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

export type SharedCharacter = Omit<Character, 'id' | 'favorite' | 'createdAt' | 'updatedAt'>;

export interface CharacterBackup {
    version: 1;
    exportedAt: number;
    type: 'character';
    data: {
        character: SharedCharacter;
    };
}

export interface ParsedImport {
    type: 'full' | 'character';
    data: ParsedBackup;
}

function copySharedCharacter(character: SharedCharacter): SharedCharacter {
    return {
        name: character.name,
        systemPrompt: character.systemPrompt,
        model: character.model,
        ...(character.speechStyle !== undefined ? { speechStyle: character.speechStyle } : {}),
        ...(character.protagonistPrompt !== undefined ? { protagonistPrompt: character.protagonistPrompt } : {}),
        ...(character.userConstraints !== undefined ? { userConstraints: character.userConstraints } : {}),
        ...(character.icon !== undefined ? { icon: character.icon } : {}),
        ...(character.maxCharacters !== undefined ? { maxCharacters: character.maxCharacters } : {}),
        ...(character.maxHistory !== undefined ? { maxHistory: character.maxHistory } : {}),
        ...(character.temperature !== undefined ? { temperature: character.temperature } : {}),
        ...(character.topP !== undefined ? { topP: character.topP } : {}),
        ...(character.topK !== undefined ? { topK: character.topK } : {}),
        ...(character.enableThinking !== undefined ? { enableThinking: character.enableThinking } : {}),
        ...(character.enableMemory !== undefined ? { enableMemory: character.enableMemory } : {}),
        ...(character.enableSummary !== undefined ? { enableSummary: character.enableSummary } : {}),
        ...(character.expressions !== undefined ? {
            expressions: character.expressions.map((expression) => ({ ...expression })),
        } : {}),
        ...(character.costumes !== undefined ? {
            costumes: character.costumes.map((costume) => ({
                ...costume,
                ...(costume.expressions ? {
                    expressions: costume.expressions.map((expression) => ({ ...expression })),
                } : {}),
            })),
        } : {}),
    };
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
        db.getAllCharactersWithImages(),
        db.getAllGroupsWithImages(),
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

export async function createCharacterBackup(characterId: string): Promise<string> {
    const character = await db.getCharacterWithImages(characterId);
    if (!character) {
        throw new Error('共有するキャラクターが見つかりません');
    }
    const backup: CharacterBackup = {
        version: 1,
        exportedAt: Date.now(),
        type: 'character',
        data: {
            character: copySharedCharacter(character),
        },
    };
    return JSON.stringify(backup, null, 2);
}

export function createCharacterBackupFilename(name: string): string {
    const normalized = Array.from(name.normalize('NFKC'), (character) => (
        character.charCodeAt(0) <= 0x1f || '<>:"/\\|?*'.includes(character)
            ? '_'
            : character
    )).join('')
        .replace(/[. ]+$/g, '')
        .trim();
    const safeName = (normalized || 'character').slice(0, 80);
    return `${safeName}.kataru-character.json`;
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

export async function shareJsonFile(
    json: string,
    filename: string,
    title: string,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
    if (typeof navigator !== 'undefined' && typeof File === 'function' && typeof navigator.share === 'function') {
        const file = new File([json], filename, { type: 'application/json' });
        const shareData: ShareData = { files: [file], title };
        let canShareFiles = true;
        if (typeof navigator.canShare === 'function') {
            try {
                canShareFiles = navigator.canShare(shareData);
            } catch {
                canShareFiles = false;
            }
        }
        if (canShareFiles) {
            try {
                await navigator.share(shareData);
                return 'shared';
            } catch (error) {
                if (
                    typeof error === 'object'
                    && error !== null
                    && 'name' in error
                    && error.name === 'AbortError'
                ) {
                    return 'cancelled';
                }
            }
        }
    }

    downloadJson(json, filename);
    return 'downloaded';
}

// IndexedDB では大容量保存が可能だが、実運用上の安全圏として上限を設ける
const MAX_IMPORT_SIZE_MB = 256;
const MAX_IMPORT_SIZE = MAX_IMPORT_SIZE_MB * 1024 * 1024;

function parseBackupJson(json: string): unknown {
    if (json.length > MAX_IMPORT_SIZE) {
        throw new Error(`インポートデータが大きすぎます（${(json.length / 1024 / 1024).toFixed(1)}MB）。${MAX_IMPORT_SIZE_MB}MB以下にしてください。`);
    }

    try {
        return JSON.parse(json) as unknown;
    } catch {
        throw new Error('JSONの解析に失敗しました');
    }
}

function parseFullBackupValue(parsed: unknown): ParsedBackup {
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
    return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
    return value === undefined || typeof value === 'boolean';
}

function isValidSharedImageSource(value: unknown): boolean {
    return typeof value === 'string'
        && value.length > 0
        && !value.startsWith('asset:');
}

function isOptionalNumber(
    value: unknown,
    { min, max, integer = false }: { min?: number; max?: number; integer?: boolean } = {},
): boolean {
    if (value === undefined) return true;
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (integer && !Number.isInteger(value)) return false;
    if (min !== undefined && value < min) return false;
    if (max !== undefined && value > max) return false;
    return true;
}

function isValidExpression(value: unknown): boolean {
    return isRecord(value)
        && typeof value.name === 'string'
        && value.name.trim().length > 0
        && isOptionalString(value.promptDetail)
        && isValidSharedImageSource(value.image);
}

function isValidCostume(value: unknown): boolean {
    return isRecord(value)
        && typeof value.name === 'string'
        && value.name.trim().length > 0
        && isOptionalString(value.promptDetail)
        && isValidSharedImageSource(value.image)
        && (value.expressions === undefined
            || (Array.isArray(value.expressions) && value.expressions.every(isValidExpression)));
}

function isValidSharedCharacter(value: unknown): value is SharedCharacter {
    if (!isRecord(value)) return false;
    return typeof value.name === 'string'
        && value.name.trim().length > 0
        && typeof value.systemPrompt === 'string'
        && typeof value.model === 'string'
        && value.model.trim().length > 0
        && isOptionalString(value.speechStyle)
        && isOptionalString(value.protagonistPrompt)
        && isOptionalString(value.userConstraints)
        && (value.icon === undefined || isValidSharedImageSource(value.icon))
        && isOptionalNumber(value.maxCharacters, { min: 1, integer: true })
        && isOptionalNumber(value.maxHistory, { min: 1, max: 100, integer: true })
        && isOptionalNumber(value.temperature, { min: 0, max: 2 })
        && isOptionalNumber(value.topP, { min: 0, max: 1 })
        && isOptionalNumber(value.topK, { min: 0, max: 100, integer: true })
        && isOptionalBoolean(value.enableThinking)
        && isOptionalBoolean(value.enableMemory)
        && isOptionalBoolean(value.enableSummary)
        && (value.expressions === undefined
            || (Array.isArray(value.expressions) && value.expressions.every(isValidExpression)))
        && (value.costumes === undefined
            || (Array.isArray(value.costumes) && value.costumes.every(isValidCostume)));
}

function parseCharacterBackupValue(parsed: unknown): ParsedBackup {
    if (
        !isRecord(parsed)
        || parsed.version !== 1
        || parsed.type !== 'character'
        || typeof parsed.exportedAt !== 'number'
        || !Number.isFinite(parsed.exportedAt)
        || !isRecord(parsed.data)
        || !isValidSharedCharacter(parsed.data.character)
    ) {
        throw new Error('キャラクターファイルの形式が正しくありません');
    }

    const now = Date.now();
    const character: Character = {
        id: generateId(),
        ...copySharedCharacter(parsed.data.character),
        createdAt: now,
        updatedAt: now,
    };
    return {
        characters: [character],
        groups: [],
        rooms: [],
        memories: [],
        usageRecords: [],
    };
}

export function parseFullBackup(json: string): ParsedBackup {
    return parseFullBackupValue(parseBackupJson(json));
}

export function parseCharacterBackup(json: string): ParsedBackup {
    return parseCharacterBackupValue(parseBackupJson(json));
}

export function parseImportFile(json: string): ParsedImport {
    const parsed = parseBackupJson(json);
    if (isRecord(parsed) && parsed.type === 'full') {
        return { type: 'full', data: parseFullBackupValue(parsed) };
    }
    if (isRecord(parsed) && parsed.type === 'character') {
        return { type: 'character', data: parseCharacterBackupValue(parsed) };
    }
    throw new Error('インポートファイルの形式が正しくありません');
}

// IDを全て再生成してマージ時の衝突を防ぐ
export function reassignIds(parsed: ParsedBackup): ParsedBackup {
    const charIdMap = new Map<string, string>();
    const groupIdMap = new Map<string, string>();
    const actorIdMap = new Map<string, string>();
    const roomIdMap = new Map<string, string>();
    const messageIdMap = new Map<string, string>();
    const memoryIdMap = new Map<string, string>();

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

    for (const room of parsed.rooms) {
        roomIdMap.set(room.id, generateId());
        for (const message of room.messages ?? []) {
            messageIdMap.set(message.id, generateId());
        }
    }
    for (const memory of parsed.memories) {
        memoryIdMap.set(memory.id, generateId());
    }

    const rooms = parsed.rooms.map((r) => {
        const newRoomId = roomIdMap.get(r.id) ?? generateId();
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
            summaryCheckpointUserMessageId: r.summaryCheckpointUserMessageId
                ? messageIdMap.get(r.summaryCheckpointUserMessageId) ?? r.summaryCheckpointUserMessageId
                : undefined,
            summaryHistory: r.summaryHistory?.map((revision) => ({
                ...revision,
                ...(revision.checkpointUserMessageId ? {
                    checkpointUserMessageId: messageIdMap.get(revision.checkpointUserMessageId)
                        ?? revision.checkpointUserMessageId,
                } : {}),
            })),
            messages: (r.messages ?? []).map((m) => {
                return {
                    ...m,
                    id: messageIdMap.get(m.id) ?? generateId(),
                    characterId: m.characterId
                        ? actorIdMap.get(m.characterId) ?? charIdMap.get(m.characterId) ?? m.characterId
                        : undefined,
                    toCharacterIds: m.toCharacterIds?.map((id) => actorIdMap.get(id) ?? charIdMap.get(id) ?? id),
                    usedMemoryIds: m.usedMemoryIds?.map((id) => memoryIdMap.get(id) ?? id),
                };
            }),
        };
    });

    const memories = parsed.memories.map((memory) => ({
        ...memory,
        id: memoryIdMap.get(memory.id) ?? generateId(),
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
