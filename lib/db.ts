import type { Character, MemoryRecord, Message, Room, Situation, UsageRecord } from './store';

export type StoredRoom = Omit<Room, 'messages' | 'secretMode'>;
export type StoredMessage = Message & { roomId: string };

type StorageRequest = {
    op: string;
    [key: string]: unknown;
};

type StorageResponse<T> = {
    result: T;
};

type BulkWriteParams = {
    characters?: Character[];
    groups?: Situation[];
    rooms?: StoredRoom[];
    messages?: StoredMessage[];
    memories?: MemoryRecord[];
    usageRecords?: UsageRecord[];
};

async function storage<T>(request: StorageRequest): Promise<T> {
    const response = await fetch('/api/storage', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: unknown } | null;
        const detail = typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`;
        throw new Error(`保存処理に失敗しました: ${detail}`);
    }
    const data = await response.json() as StorageResponse<T>;
    return data.result;
}

// 独立版は別originのため、旧アプリのIndexedDBは自動参照しません。
// データ移行には旧アプリのJSONバックアップを使用します。
export async function migrateLegacyDatabase(): Promise<boolean> {
    return false;
}

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
    const result = await storage<T | null>({ op: 'get_meta', key });
    return result === null ? undefined : result;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
    await storage<null>({ op: 'set_meta', key, value });
}

export async function deleteMeta(key: string): Promise<void> {
    await storage<null>({ op: 'delete_meta', key });
}

export async function getAllCharacters(): Promise<Character[]> {
    return storage<Character[]>({ op: 'get_all_characters' });
}

export async function putCharacter(value: Character): Promise<void> {
    await storage<null>({ op: 'put_character', value });
}

export async function deleteCharacter(id: string): Promise<void> {
    await storage<null>({ op: 'delete_character', id });
}

export async function getAllGroups(): Promise<Situation[]> {
    return storage<Situation[]>({ op: 'get_all_situations' });
}

export async function putGroup(value: Situation): Promise<void> {
    await storage<null>({ op: 'put_situation', value });
}

export async function deleteGroup(id: string): Promise<void> {
    await storage<null>({ op: 'delete_situation', id });
}

export async function getAllRooms(): Promise<StoredRoom[]> {
    return storage<StoredRoom[]>({ op: 'get_all_rooms' });
}

export async function putRoom(value: StoredRoom): Promise<void> {
    await storage<null>({ op: 'put_room', value });
}

export async function deleteRoom(id: string): Promise<void> {
    await storage<null>({ op: 'delete_room', id });
}

export async function deleteRoomHistory(id: string): Promise<void> {
    await storage<null>({ op: 'delete_room_history', id });
}

export async function getAllMessages(): Promise<StoredMessage[]> {
    return storage<StoredMessage[]>({ op: 'get_all_messages' });
}

export async function getMessagesByRoom(roomId: string): Promise<Message[]> {
    return storage<Message[]>({ op: 'get_messages_by_room', room_id: roomId });
}

export async function putMessage(roomId: string, value: Message): Promise<void> {
    await storage<null>({ op: 'put_message', room_id: roomId, value });
}

export async function putMessages(roomId: string, values: Message[]): Promise<void> {
    if (values.length === 0) return;
    await storage<null>({ op: 'put_messages', room_id: roomId, messages: values });
}

export async function deleteMessage(id: string): Promise<void> {
    await storage<null>({ op: 'delete_message', id });
}

export async function deleteMessagesByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await storage<null>({ op: 'delete_messages_by_ids', message_ids: ids });
}

export async function doMessagesExist(ids: string[]): Promise<boolean> {
    return storage<boolean>({ op: 'do_messages_exist', message_ids: ids });
}

export async function clearMessagesByRoom(roomId: string): Promise<void> {
    await storage<null>({ op: 'clear_messages_by_room', room_id: roomId });
}

export async function clearAllMessagesAndPutRooms(rooms: StoredRoom[]): Promise<void> {
    await storage<null>({ op: 'clear_all_messages_and_put_rooms', rooms });
}

export async function getAllMemories(): Promise<MemoryRecord[]> {
    return storage<MemoryRecord[]>({ op: 'get_all_memories' });
}

export async function getMemory(id: string): Promise<MemoryRecord | undefined> {
    const result = await storage<MemoryRecord | null>({ op: 'get_memory', id });
    return result ?? undefined;
}

export async function getMemoriesBySourceMessageIds(messageIds: string[]): Promise<MemoryRecord[]> {
    if (messageIds.length === 0) return [];
    return storage<MemoryRecord[]>({
        op: 'get_memories_by_source_message_ids',
        message_ids: messageIds,
    });
}

export async function getMemoriesByCharacter(characterId: string): Promise<MemoryRecord[]> {
    return storage<MemoryRecord[]>({
        op: 'get_memories_by_character',
        character_id: characterId,
    });
}

export async function getSearchableMemories(params: {
    characterId: string;
    roomId?: string;
    recentMessageIds?: string[];
}): Promise<MemoryRecord[]> {
    return storage<MemoryRecord[]>({
        op: 'get_searchable_memories',
        character_id: params.characterId,
        room_id: params.roomId,
        recent_message_ids: params.recentMessageIds ?? [],
    });
}

export async function putMemory(value: MemoryRecord): Promise<void> {
    await storage<null>({ op: 'put_memory', value });
}

export async function putMemories(values: MemoryRecord[]): Promise<void> {
    if (values.length === 0) return;
    await storage<null>({ op: 'put_memories', memories: values });
}

export async function deleteMemory(id: string): Promise<void> {
    await storage<null>({ op: 'delete_memory', id });
}

export async function deleteMemories(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await storage<null>({ op: 'delete_memories', memory_ids: ids });
}

export async function removeMemoryContentsFromMessages(
    characterId: string,
    contents: string[],
): Promise<void> {
    if (!characterId || contents.length === 0) return;
    await storage<null>({
        op: 'remove_memory_contents_from_messages',
        character_id: characterId,
        contents,
    });
}

export async function deleteMemoriesByCharacter(characterId: string): Promise<void> {
    await storage<null>({
        op: 'delete_memories_by_character',
        character_id: characterId,
    });
}

export async function deleteMemoriesByCharacterAndContent(
    characterId: string,
    contents: string[],
): Promise<void> {
    if (contents.length === 0) return;
    await storage<null>({
        op: 'delete_memories_by_character_and_content',
        character_id: characterId,
        contents,
    });
}

export async function deleteMemoriesBySourceMessageIds(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await storage<null>({
        op: 'delete_memories_by_source_message_ids',
        message_ids: messageIds,
    });
}

export async function touchMemories(ids: string[], timestamp = Date.now()): Promise<void> {
    if (ids.length === 0) return;
    await storage<null>({ op: 'touch_memories', memory_ids: ids, timestamp });
}

export async function getAllUsageRecords(): Promise<UsageRecord[]> {
    return storage<UsageRecord[]>({ op: 'get_all_usage_records' });
}

export async function putUsageRecord(value: UsageRecord): Promise<void> {
    await storage<null>({ op: 'put_usage_record', value });
}

export async function deleteUsageRecordsOlderThan(timestamp: number): Promise<void> {
    await storage<null>({ op: 'delete_usage_records_older_than', timestamp });
}

export async function clearAll(): Promise<void> {
    await storage<null>({ op: 'clear_all' });
}

export async function bulkWrite(params: BulkWriteParams): Promise<void> {
    await storage<null>({
        op: 'bulk_write',
        characters: params.characters ?? [],
        situations: params.groups ?? [],
        rooms: params.rooms ?? [],
        messages: params.messages ?? [],
        memories: params.memories ?? [],
        usage_records: params.usageRecords ?? [],
    });
}

export async function replaceAll(
    params: BulkWriteParams & {
        currentRoomId?: string | null;
    },
): Promise<void> {
    await storage<null>({
        op: 'replace_all',
        characters: params.characters ?? [],
        situations: params.groups ?? [],
        rooms: params.rooms ?? [],
        messages: params.messages ?? [],
        memories: params.memories ?? [],
        usage_records: params.usageRecords ?? [],
        current_room_id: params.currentRoomId ?? null,
    });
}
