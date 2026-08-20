import * as db from '../db';
import { buildConversationBranch } from '../conversationBranch';
import { generateId } from '../id';
import { normalizeMemoryContent } from './memories';
import {
    fire,
    getRoomLoadSequence,
    nextRoomLoadSequence,
    shouldPersistRoom,
    shouldShowRoomInHistory,
    toPreview,
    toStoredRoom,
} from './persistence';
import {
    createDefaultSituationDirector,
    defaultGroupRoomName,
    getSituationActorIds,
    normalizeSituationActor,
    normalizeSituationDirector,
    normalizeSituationMaxHistory,
    normalizeSituationPriorMessages,
    resolveSituationParticipants,
    uniqueSituationActors,
} from './situations';
import type {
    AppState,
    Message,
    Room,
    SummaryRevision,
    Situation,
    SituationActor,
    StoreGet,
    StoreSet,
} from './types';

const SUMMARY_HISTORY_LIMIT = 20;

export function createSummaryRevision(
    text: string,
    checkpointUserMessageId: string | undefined,
    source: SummaryRevision['source'],
    createdAt = Date.now(),
): SummaryRevision {
    return {
        text,
        ...(checkpointUserMessageId ? { checkpointUserMessageId } : {}),
        createdAt,
        source,
    };
}

export function appendSummaryRevision(
    history: SummaryRevision[] | undefined,
    revision: SummaryRevision,
): SummaryRevision[] {
    const current = history ?? [];
    const previous = current[current.length - 1];
    if (
        previous
        && previous.text === revision.text
        && previous.checkpointUserMessageId === revision.checkpointUserMessageId
        && previous.source === revision.source
    ) {
        return current;
    }
    return [...current, revision].slice(-SUMMARY_HISTORY_LIMIT);
}

type ConversationSlice = Pick<
    AppState,
    | 'groups'
    | 'rooms'
    | 'currentRoomId'
    | 'createRoom'
    | 'createSituationRoom'
    | 'createRoomForSituation'
    | 'branchRoomFromMessage'
    | 'deleteRoom'
    | 'deleteSituation'
    | 'duplicateSituation'
    | 'setCurrentRoom'
    | 'updateSituation'
    | 'updateRoomName'
    | 'updateRoomSettings'
    | 'setRoomReplySuggestions'
    | 'setRoomSecretMode'
    | 'addMessage'
    | 'deleteLastMessage'
    | 'deleteMessagesFrom'
    | 'restoreMessagesAt'
    | 'attachMemoriesToMessage'
    | 'updateLastAssistantMessage'
    | 'flushLastAssistantMessage'
    | 'refreshConversationRoom'
    | 'clearRoomMessages'
    | 'clearAllHistory'
    | 'updateRoomSummary'
    | 'compressRoomHistory'
    | 'getCurrentRoom'
    | 'getRoomsForCharacter'
    | 'getRoomsForSituation'
    | 'getSituationParticipants'
>;

export function createConversationSlice(set: StoreSet, get: StoreGet): ConversationSlice {
    return {
        groups: [],
        rooms: [],
        currentRoomId: null,

        createRoom: (characterId, name, options) => {
            const id = generateId();
            const now = Date.now();
            const character = get().characters.find((c) => c.id === characterId);
            const explicitName = name?.trim();
            const roomCountForChar = get().rooms.filter((r) =>
                shouldShowRoomInHistory(r) &&
                r.characterId === characterId &&
                !r.groupId
            ).length;
            const room: Room = {
                id,
                characterId,
                name: explicitName || (get().generateTitleOnFirstReply ? '' : `${character?.name || 'Chat'} ${roomCountForChar + 1}`),
                messages: [],
                viewMode: options?.viewMode,
                isDraft: true,
                createdAt: now,
                updatedAt: now,
            };
            set((state) => ({
                rooms: [...state.rooms.filter((r) => !r.isDraft), room],
                currentRoomId: id,
            }));
            return id;
        },

        createSituationRoom: (input) => {
            const validCharacterIds = new Set(get().characters.map((c) => c.id));
            const actors = uniqueSituationActors(
                input.actors
                    .map((actor) => normalizeSituationActor(actor, validCharacterIds, get().defaultChatModel))
                    .filter((actor): actor is SituationActor => actor != null)
            );
            if (actors.length === 0) return '';

            const groupId = generateId();
            const roomId = generateId();
            const now = Date.now();
            const actorIds = actors.map((actor) => actor.id);
            const explicitRoomName = input.roomName?.trim();
            const characterActorIds = actors
                .filter((actor) => actor.type === 'character')
                .map((actor) => actor.characterId);
            const characterNames = new Map(get().characters.map((character) => [character.id, character.name]));
            const resolvedGroupName = input.name?.trim()
                || characterActorIds.map((id) => characterNames.get(id)).filter(Boolean).join(' & ')
                || 'シチュエーション';
            const group: Situation = {
                id: groupId,
                name: resolvedGroupName,
                situationPrompt: input.situationPrompt?.trim() ?? '',
                priorMessages: normalizeSituationPriorMessages(input.priorMessages, new Set(actorIds)),
                actors,
                director: normalizeSituationDirector({
                    ...createDefaultSituationDirector(get().defaultDirectorModel),
                    ...(input.director ?? {}),
                }, get().defaultDirectorModel),
                memoryMode: input.memoryMode === 'readOnly' ? 'readOnly' : 'off',
                maxHistory: normalizeSituationMaxHistory(input.maxHistory),
                createdAt: now,
                updatedAt: now,
            };
            const room: Room = {
                id: roomId,
                characterId: actorIds[0],
                groupId,
                name: explicitRoomName || (get().generateTitleOnFirstReply ? '' : defaultGroupRoomName(resolvedGroupName, 1)),
                messages: [],
                isDraft: true,
                createdAt: now,
                updatedAt: now,
            };
            set((state) => ({
                groups: [...state.groups, group],
                rooms: [...state.rooms.filter((r) => !r.isDraft), room],
                currentRoomId: roomId,
            }));
            fire(db.putGroup(group));
            return roomId;
        },

        createRoomForSituation: (groupId, name, options) => {
            const group = get().groups.find((g) => g.id === groupId);
            const actorIds = group ? getSituationActorIds(group) : [];
            if (!group || actorIds.length === 0) return '';

            const id = generateId();
            const now = Date.now();
            const explicitName = name?.trim();
            const roomCountForGroup = get().rooms.filter((r) => shouldShowRoomInHistory(r) && r.groupId === groupId).length;
            const room: Room = {
                id,
                characterId: actorIds[0],
                groupId,
                name: explicitName || (get().generateTitleOnFirstReply ? '' : defaultGroupRoomName(group.name, roomCountForGroup + 1)),
                messages: [],
                viewMode: options?.viewMode,
                isDraft: true,
                createdAt: now,
                updatedAt: now,
            };
            const updatedGroup = { ...group, updatedAt: now };
            set((state) => ({
                groups: state.groups.map((g) => (g.id === groupId ? updatedGroup : g)),
                rooms: [...state.rooms.filter((r) => !r.isDraft), room],
                currentRoomId: id,
            }));
            fire(db.putGroup(updatedGroup));
            return id;
        },

        branchRoomFromMessage: async (roomId, messageId) => {
            const state = get();
            const sourceRoom = state.rooms.find((room) => room.id === roomId);
            if (!sourceRoom) {
                throw new Error('分岐元のルームが見つかりませんでした。');
            }
            if (sourceRoom.secretMode === true) {
                throw new Error('シークレットモードの会話は分岐できません。');
            }

            const now = Date.now();
            const branchedRoom = buildConversationBranch(
                sourceRoom,
                state.rooms.map((room) => room.name),
                messageId,
                now,
                generateId,
            );
            const id = branchedRoom.id;
            const messages = branchedRoom.messages;
            branchedRoom.lastMessagePreview = toPreview(messages[messages.length - 1].content);

            await db.bulkWrite({
                rooms: [toStoredRoom(branchedRoom)],
                messages: messages.map((message) => ({ ...message, roomId: id })),
            });

            nextRoomLoadSequence();
            set((current) => ({
                rooms: [
                    ...current.rooms.map((room) => (
                        room.id === roomId ? { ...room, messages: [] } : room
                    )),
                    branchedRoom,
                ],
                currentRoomId: id,
            }));
            fire(db.setMeta('currentRoomId', id));
            return id;
        },

        deleteRoom: (id) => {
            const state = get();
            const roomToDelete = state.rooms.find((r) => r.id === id);
            const shouldDeleteGroup = !!roomToDelete?.groupId &&
                state.rooms.filter((r) => r.groupId === roomToDelete.groupId && r.id !== id).length === 0;
            const nextCurrent = state.currentRoomId === id ? null : state.currentRoomId;
            set({
                groups: shouldDeleteGroup
                    ? state.groups.filter((g) => g.id !== roomToDelete!.groupId)
                    : state.groups,
                rooms: state.rooms.filter((r) => r.id !== id),
                currentRoomId: nextCurrent,
            });
            fire(db.deleteRoom(id));
            if (shouldDeleteGroup) fire(db.deleteGroup(roomToDelete!.groupId!));
            if (nextCurrent !== state.currentRoomId) {
                fire(db.setMeta('currentRoomId', nextCurrent));
            }
        },

        deleteSituation: (id) => {
            const state = get();
            const roomIds = state.rooms.filter((r) => r.groupId === id).map((r) => r.id);
            const nextCurrent = roomIds.includes(state.currentRoomId || '') ? null : state.currentRoomId;
            set({
                groups: state.groups.filter((g) => g.id !== id),
                rooms: state.rooms.filter((r) => r.groupId !== id),
                currentRoomId: nextCurrent,
            });
            fire(db.deleteGroup(id));
            for (const roomId of roomIds) fire(db.deleteRoom(roomId));
            if (nextCurrent !== state.currentRoomId) {
                fire(db.setMeta('currentRoomId', nextCurrent));
            }
        },

        duplicateSituation: (id) => {
            const source = get().groups.find((group) => group.id === id);
            if (!source) return '';

            const newId = generateId();
            const now = Date.now();
            const baseName = source.name.replace(/\s*\(\d+\)$/, '');
            const existingNames = new Set(get().groups.map((group) => group.name));
            let n = 1;
            while (existingNames.has(`${baseName} (${n})`)) n++;

            const next: Situation = {
                ...source,
                id: newId,
                name: `${baseName} (${n})`,
                actors: source.actors.map((actor) => ({ ...actor })),
                director: { ...source.director },
                priorMessages: source.priorMessages?.map((message) => ({ ...message })),
                createdAt: now,
                updatedAt: now,
            };
            set((state) => ({ groups: [...state.groups, next] }));
            fire(db.putGroup(next));
            return newId;
        },

        setCurrentRoom: async (id) => {
            const loadSeq = nextRoomLoadSequence();
            const prevId = get().currentRoomId;

            set((state) => ({
                currentRoomId: id,
                rooms: prevId && prevId !== id
                    ? state.rooms.map((r) => {
                        if (r.id !== prevId) return r;
                        return r.secretMode === true
                            ? { ...r, messages: [], summary: undefined, summaryCheckpointUserMessageId: undefined, summaryHistory: undefined, lastMessagePreview: undefined, lastMessageAt: undefined }
                            : { ...r, messages: [] };
                    })
                    : state.rooms,
            }));
            const selectedRoom = get().rooms.find((r) => r.id === id);
            if (!id) {
                fire(db.setMeta('currentRoomId', null));
            } else if (shouldPersistRoom(selectedRoom)) {
                fire(db.setMeta('currentRoomId', id));
            }

            if (!id || !get().rooms.some((r) => r.id === id)) return;

            const msgs = await db.getMessagesByRoom(id);
            if (loadSeq !== getRoomLoadSequence() || get().currentRoomId !== id) return;

            set((state) => ({
                rooms: state.rooms.map((r) => (r.id === id ? { ...r, messages: msgs } : r)),
            }));
        },

        updateSituation: (id, updates) => {
            let updated: Situation | undefined;
            const updatedRooms: Room[] = [];
            set((state) => ({
                ...(() => {
                    const now = Date.now();
                    const validCharacterIds = new Set(state.characters.map((c) => c.id));
                    const groups = state.groups.map((g) => {
                        if (g.id !== id) return g;
                        const normalizedActors = updates.actors
                            ? uniqueSituationActors(
                                updates.actors
                                    .map((actor) => normalizeSituationActor(actor, validCharacterIds, state.defaultChatModel))
                                    .filter((actor): actor is SituationActor => actor != null)
                            )
                            : g.actors;
                        const nextActors = normalizedActors.length > 0 ? normalizedActors : g.actors;
                        const nextActorIds = new Set(nextActors.map((actor) => actor.id));
                        updated = {
                            ...g,
                            ...updates,
                            actors: nextActors,
                            ...(updates.director ? { director: normalizeSituationDirector(updates.director, state.defaultDirectorModel) } : {}),
                            priorMessages: normalizeSituationPriorMessages(
                                'priorMessages' in updates ? updates.priorMessages : g.priorMessages,
                                nextActorIds,
                            ),
                            memoryMode: updates.memoryMode === 'readOnly' ? 'readOnly' : updates.memoryMode === 'off' ? 'off' : g.memoryMode ?? 'off',
                            maxHistory: 'maxHistory' in updates ? normalizeSituationMaxHistory(updates.maxHistory) : g.maxHistory,
                            updatedAt: now,
                        };
                        return updated;
                    });

                    if (!updated) return { groups };

                    const actorIds = getSituationActorIds(updated);
                    const actorIdSet = new Set(actorIds);
                    if (actorIds.length === 0) return { groups };

                    const rooms = state.rooms.map((r) => {
                        if (r.groupId !== id) return r;
                        const costumeSelections = r.costumeSelections
                            ? Object.fromEntries(
                                Object.entries(r.costumeSelections)
                                    .filter(([actorId]) => actorIdSet.has(actorId))
                            )
                            : undefined;
                        const nextRoom: Room = {
                            ...r,
                            characterId: actorIdSet.has(r.characterId) ? r.characterId : actorIds[0],
                            costumeSelections: costumeSelections && Object.keys(costumeSelections).length > 0 ? costumeSelections : undefined,
                            updatedAt: now,
                        };
                        updatedRooms.push(nextRoom);
                        return nextRoom;
                    });

                    return { groups, rooms };
                })(),
            }));
            if (updated) {
                fire(db.putGroup(updated));
            }
            for (const r of updatedRooms) {
                if (shouldPersistRoom(r)) fire(db.putRoom(toStoredRoom(r)));
            }
        },

        updateRoomName: (id, name) => {
            let updated: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== id) return r;
                    updated = { ...r, name, updatedAt: Date.now() };
                    return updated;
                }),
            }));
            if (shouldPersistRoom(updated)) {
                fire(db.putRoom(toStoredRoom(updated)));
            }
        },

        updateRoomSettings: (id, updates) => {
            let updated: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== id) return r;
                    updated = { ...r, ...updates, updatedAt: Date.now() };
                    return updated;
                }),
            }));
            if (shouldPersistRoom(updated)) {
                fire(db.putRoom(toStoredRoom(updated)));
            }
        },

        setRoomReplySuggestions: (id, replySuggestions) => {
            const normalizedSuggestions = replySuggestions?.suggestions
                .map((suggestion) => suggestion.trim())
                .filter(Boolean);
            const normalized = replySuggestions
                && replySuggestions.sourceMessageId.trim()
                && normalizedSuggestions?.length === 3
                ? {
                    sourceMessageId: replySuggestions.sourceMessageId.trim(),
                    suggestions: normalizedSuggestions,
                }
                : undefined;
            let updatedRoom: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== id) return r;
                    if (normalized) {
                        const latestVisibleMessage = [...r.messages].reverse().find((message) => !message.archived);
                        if (latestVisibleMessage?.role !== 'assistant' || latestVisibleMessage.id !== normalized.sourceMessageId) {
                            return r;
                        }
                    }
                    updatedRoom = { ...r, replySuggestions: normalized };
                    return updatedRoom;
                }),
            }));
            if (shouldPersistRoom(updatedRoom)) {
                fire(db.putRoom(toStoredRoom(updatedRoom)));
            }
        },

        setRoomSecretMode: (id, enabled) => {
            let updatedRoom: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== id || r.messages.length > 0) return r;
                    updatedRoom = {
                        ...r,
                        secretMode: enabled || undefined,
                        summary: enabled ? undefined : r.summary,
                        summaryCheckpointUserMessageId: enabled ? undefined : r.summaryCheckpointUserMessageId,
                        summaryHistory: enabled ? undefined : r.summaryHistory,
                        lastMessagePreview: enabled ? undefined : r.lastMessagePreview,
                        lastMessageAt: enabled ? undefined : r.lastMessageAt,
                    };
                    return updatedRoom;
                }),
            }));
            if (!updatedRoom) return;
            if (enabled) {
                fire(db.deleteRoomHistory(id));
                fire(db.setMeta('currentRoomId', null));
            } else if (shouldPersistRoom(updatedRoom)) {
                fire(db.putRoom(toStoredRoom(updatedRoom)));
                fire(db.setMeta('currentRoomId', id));
            }
        },

        addMessage: (roomId, role, content, characterId, meta) => {
            const now = Date.now();
            const memories = meta?.memories
                ?.map((memory) => memory.trim())
                .filter(Boolean);
            const toCharacterIds = meta?.toCharacterIds
                ?.map((id) => id.trim())
                .filter(Boolean);
            const message: Message = {
                id: generateId(),
                role,
                content,
                ...(characterId ? { characterId } : {}),
                ...(toCharacterIds && toCharacterIds.length > 0 ? { toCharacterIds } : {}),
                ...(meta?.expression ? { expression: meta.expression } : {}),
                ...(memories && memories.length > 0 ? { memories } : {}),
                timestamp: now,
            };
            let updatedRoom: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== roomId) return r;
                    const isSecret = r.secretMode === true;
                    updatedRoom = {
                        ...r,
                        isDraft: isSecret ? r.isDraft : undefined,
                        messages: [...r.messages, message],
                        replySuggestions: undefined,
                        ...(isSecret ? {} : {
                            lastMessagePreview: toPreview(content),
                            lastMessageAt: now,
                            updatedAt: now,
                        }),
                    };
                    return updatedRoom;
                }),
            }));
            if (shouldPersistRoom(updatedRoom)) {
                fire(db.putRoomAndMessage(toStoredRoom(updatedRoom), message));
                fire(db.setMeta('currentRoomId', roomId));
            }
            return message.id;
        },

        deleteLastMessage: (roomId) => {
            let removedId: string | undefined;
            let updatedRoom: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== roomId) return r;
                    const messages = [...r.messages];
                    const removed = messages.pop();
                    removedId = removed?.id;
                    const newLast = messages[messages.length - 1];
                    updatedRoom = r.secretMode === true
                        ? { ...r, messages, replySuggestions: undefined }
                        : {
                            ...r,
                            messages,
                            replySuggestions: undefined,
                            lastMessagePreview: newLast ? toPreview(newLast.content) : undefined,
                            lastMessageAt: newLast?.timestamp,
                            updatedAt: Date.now(),
                        };
                    return updatedRoom;
                }),
            }));
            if (shouldPersistRoom(updatedRoom) && removedId) {
                fire(db.deleteMessage(removedId));
                fire(db.deleteMemoriesBySourceMessageIds([removedId]));
                fire(db.putRoom(toStoredRoom(updatedRoom)));
            }
        },

        deleteMessagesFrom: async (roomId, fromIndex) => {
            let removedIds: string[] = [];
            let removedMessages: Message[] = [];
            let updatedRoom: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== roomId) return r;
                    removedMessages = r.messages.slice(fromIndex);
                    removedIds = removedMessages.map((message) => message.id);
                    const messages = r.messages.slice(0, fromIndex);
                    const newLast = messages[messages.length - 1];
                    updatedRoom = r.secretMode === true
                        ? { ...r, messages, replySuggestions: undefined }
                        : {
                            ...r,
                            messages,
                            replySuggestions: undefined,
                            lastMessagePreview: newLast ? toPreview(newLast.content) : undefined,
                            lastMessageAt: newLast?.timestamp,
                            updatedAt: Date.now(),
                        };
                    return updatedRoom;
                }),
            }));
            if (shouldPersistRoom(updatedRoom)) {
                const sourceMemories = removedIds.length > 0
                    ? await db.getMemoriesBySourceMessageIds(removedIds)
                    : [];
                const legacyMemoryContentsByCharacter = new Map<string, Set<string>>();
                for (const message of removedMessages) {
                    if (message.role !== 'assistant' || !message.characterId) continue;
                    const contents = message.memories?.map(normalizeMemoryContent).filter(Boolean) ?? [];
                    if (contents.length === 0) continue;
                    const existingContents = legacyMemoryContentsByCharacter.get(message.characterId) ?? new Set<string>();
                    for (const content of contents) existingContents.add(content);
                    legacyMemoryContentsByCharacter.set(message.characterId, existingContents);
                }
                const legacyMemories = (await Promise.all(
                    [...legacyMemoryContentsByCharacter].map(async ([characterId, contents]) => {
                        const characterMemories = await db.getMemoriesByCharacter(characterId);
                        return characterMemories.filter((memory) =>
                            (memory.sourceMessageIds ?? []).length === 0 &&
                            contents.has(normalizeMemoryContent(memory.content))
                        );
                    })
                )).flat();
                const removedMemories = [...new Map(
                    [...sourceMemories, ...legacyMemories].map((memory) => [memory.id, memory])
                ).values()];
                await Promise.all([
                    ...(removedIds.length > 0 ? [
                        db.deleteMessagesByIds(removedIds),
                        db.deleteMemoriesBySourceMessageIds(removedIds),
                    ] : []),
                    db.deleteMemories(legacyMemories.map((memory) => memory.id)),
                    db.putRoom(toStoredRoom(updatedRoom)),
                ]);
                return removedMemories;
            }
            return [];
        },

        restoreMessagesAt: async (roomId, fromIndex, messages, memories = []) => {
            let updatedRoom: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== roomId) return r;
                    const restored = [...r.messages.slice(0, fromIndex), ...messages];
                    const newLast = restored[restored.length - 1];
                    updatedRoom = r.secretMode === true
                        ? { ...r, messages: restored, replySuggestions: undefined }
                        : {
                            ...r,
                            messages: restored,
                            replySuggestions: undefined,
                            lastMessagePreview: newLast ? toPreview(newLast.content) : undefined,
                            lastMessageAt: newLast?.timestamp,
                            updatedAt: Date.now(),
                        };
                    return updatedRoom;
                }),
            }));
            if (shouldPersistRoom(updatedRoom)) {
                await Promise.all([
                    db.putRoom(toStoredRoom(updatedRoom)),
                    db.putMessages(roomId, messages),
                    db.putMemories(memories),
                ]);
            }
        },

        attachMemoriesToMessage: (roomId, messageId, memoriesToAttach) => {
            const normalizedMemories = [...new Set(
                memoriesToAttach.map((memory) => normalizeMemoryContent(memory)).filter(Boolean)
            )];
            if (normalizedMemories.length === 0) return;

            let updatedRoom: Room | undefined;
            let updatedMessage: Message | undefined;
            set((state) => ({
                rooms: state.rooms.map((room) => {
                    if (room.id !== roomId) return room;
                    const messages = room.messages.map((message) => {
                        if (message.id !== messageId || message.role !== 'assistant') return message;
                        const nextMemories = [...new Set([...(message.memories ?? []), ...normalizedMemories])];
                        updatedMessage = { ...message, memories: nextMemories };
                        return updatedMessage;
                    });
                    updatedRoom = { ...room, messages };
                    return updatedRoom;
                }),
            }));
            if (shouldPersistRoom(updatedRoom) && updatedMessage) {
                fire(db.putMessage(roomId, updatedMessage));
            }
        },

        updateLastAssistantMessage: (roomId, content, meta) => {
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== roomId) return r;
                    const messages = [...r.messages];
                    const lastIndex = messages.length - 1;
                    if (lastIndex >= 0 && messages[lastIndex].role === 'assistant') {
                        const memories = meta?.memories
                            ?.map((memory) => memory.trim())
                            .filter(Boolean);
                        const toCharacterIds = meta?.toCharacterIds
                            ?.map((id) => id.trim())
                            .filter(Boolean);
                        messages[lastIndex] = {
                            ...messages[lastIndex],
                            content,
                            ...(meta ? {
                                expression: meta.expression,
                                memories: memories && memories.length > 0 ? memories : undefined,
                                toCharacterIds: toCharacterIds && toCharacterIds.length > 0 ? toCharacterIds : undefined,
                            } : {}),
                        };
                    }
                    return { ...r, messages };
                }),
            }));
            // No DB write: streaming updates are memory-only; call flushLastAssistantMessage at stream end.
        },

        flushLastAssistantMessage: (roomId) => {
            let updatedRoom: Room | undefined;
            let lastMessage: Message | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== roomId) return r;
                    const last = r.messages[r.messages.length - 1];
                    if (!last || last.role !== 'assistant') return r;
                    lastMessage = last;
                    if (r.secretMode === true) {
                        updatedRoom = r;
                        return r;
                    }
                    updatedRoom = {
                        ...r,
                        lastMessagePreview: toPreview(last.content),
                        lastMessageAt: last.timestamp,
                    };
                    return updatedRoom;
                }),
            }));
            if (shouldPersistRoom(updatedRoom) && lastMessage) {
                fire(db.putMessage(roomId, lastMessage));
                fire(db.putRoom(toStoredRoom(updatedRoom)));
            }
        },

        refreshConversationRoom: async (roomId) => {
            const loadSeq = getRoomLoadSequence();
            const [storedRooms, messages, usageRecords] = await Promise.all([
                db.getAllRooms(),
                db.getMessagesByRoom(roomId),
                db.getAllUsageRecords(),
            ]);
            if (loadSeq !== getRoomLoadSequence()) return;
            const storedRoom = storedRooms.find((room) => room.id === roomId);
            if (!storedRoom) return;
            set((state) => ({
                rooms: state.rooms.map((room) => {
                    if (room.id !== roomId) return room;
                    return {
                        ...room,
                        ...storedRoom,
                        messages: state.currentRoomId === roomId ? messages : room.messages,
                    };
                }),
                usageRecords,
            }));
        },

        clearRoomMessages: (roomId) => {
            let updatedRoom: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== roomId) return r;
                    updatedRoom = {
                        ...r,
                        messages: [],
                        replySuggestions: undefined,
                        summary: undefined,
                        summaryCheckpointUserMessageId: undefined,
                        summaryHistory: undefined,
                        lastMessagePreview: undefined,
                        lastMessageAt: undefined,
                        updatedAt: Date.now(),
                    };
                    return updatedRoom;
                }),
            }));
            if (shouldPersistRoom(updatedRoom)) {
                fire(db.clearMessagesByRoom(roomId));
                fire(db.putRoom(toStoredRoom(updatedRoom)));
            }
        },

        clearAllHistory: async () => {
            nextRoomLoadSequence();
            await db.clearAllConversationHistory();
            nextRoomLoadSequence();
            set({
                rooms: [],
                currentRoomId: null,
            });
        },

        updateRoomSummary: (roomId, summary, summaryCheckpointUserMessageId, source = 'automatic') => {
            let updated: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== roomId) return r;
                    const revision = createSummaryRevision(
                        summary,
                        summaryCheckpointUserMessageId,
                        source,
                    );
                    const summaryUpdates = summaryCheckpointUserMessageId === undefined
                        ? { summary }
                        : { summary, summaryCheckpointUserMessageId };
                    const summaryHistory = appendSummaryRevision(r.summaryHistory, revision);
                    updated = r.secretMode === true
                        ? { ...r, ...summaryUpdates, summaryHistory }
                        : { ...r, ...summaryUpdates, summaryHistory, updatedAt: Date.now() };
                    return updated;
                }),
            }));
            if (shouldPersistRoom(updated)) {
                fire(db.putRoom(toStoredRoom(updated)));
            }
        },

        compressRoomHistory: (roomId, keepCount) => {
            const changedMessages: Message[] = [];
            let updatedRoom: Room | undefined;
            set((state) => ({
                rooms: state.rooms.map((r) => {
                    if (r.id !== roomId) return r;
                    const cutIndex = r.messages.length - keepCount;
                    const messages = r.messages.map((m, i) => {
                        if (i < cutIndex && !m.archived) {
                            const next = { ...m, archived: true };
                            changedMessages.push(next);
                            return next;
                        }
                        return m;
                    });
                    updatedRoom = r.secretMode === true
                        ? { ...r, messages }
                        : { ...r, messages, updatedAt: Date.now() };
                    return updatedRoom;
                }),
            }));
            if (shouldPersistRoom(updatedRoom)) {
                if (changedMessages.length > 0) fire(db.putMessages(roomId, changedMessages));
                fire(db.putRoom(toStoredRoom(updatedRoom)));
            }
        },

        getCurrentRoom: () => {
            const state = get();
            return state.rooms.find((r) => r.id === state.currentRoomId) || null;
        },

        getRoomsForCharacter: (characterId) => {
            const state = get();
            const groupIds = new Set(state.groups
                .filter((g) => g.actors
                    .some((actor) => actor.type === 'character' && actor.characterId === characterId))
                .map((g) => g.id));
            return state.rooms.filter((r) =>
                r.characterId === characterId ||
                (r.groupId && groupIds.has(r.groupId))
            );
        },

        getRoomsForSituation: (groupId) => {
            return get().rooms.filter((r) => r.groupId === groupId);
        },

        getSituationParticipants: (room) => {
            const state = get();
            const group = room.groupId
                ? state.groups.find((g) => g.id === room.groupId)
                : undefined;
            if (group) return resolveSituationParticipants(group, state.characters, state.defaultChatModel);
            return [];
        },
    };
}
