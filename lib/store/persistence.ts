import * as db from '../db';
import type { Room, Situation, StoreGet, StoreSet } from './types';

export function fire(promise: Promise<unknown>): void {
    promise.catch((error) => console.error('[db]', error));
}

export async function persistGroup(set: StoreSet, get: StoreGet, submitted: Situation): Promise<void> {
    const stored = await db.putGroup(submitted);
    // Release imported binary data from state once the server has returned asset references.
    // A later edit must never be overwritten by an older save response.
    if (stored && get().groups.some((group) => group === submitted)) {
        set((state) => ({
            groups: state.groups.map((group) => (group === submitted ? stored : group)),
        }));
    }
}

export function toStoredRoom(room: Room): db.StoredRoom {
    const stored: Partial<Room> = { ...room };
    delete stored.messages;
    delete stored.secretMode;
    delete stored.isDraft;
    if (room.secretMode) {
        delete stored.summary;
        delete stored.summaryCheckpointUserMessageId;
        delete stored.summaryHistory;
        delete stored.lastMessagePreview;
        delete stored.lastMessageAt;
    }
    return stored as db.StoredRoom;
}

export function shouldPersistRoom(room: Room | undefined): room is Room {
    return !!room && room.secretMode !== true && room.isDraft !== true;
}

export function shouldShowRoomInHistory(room: Room): boolean {
    return room.secretMode !== true && room.isDraft !== true;
}

const PREVIEW_MAX = 50;
const MEMORY_TAG_REGEX = /<memory>[\s\S]*?<\/memory>/gi;
const EMOTION_TAG_REGEX = /^\s*\[emotion:[^\]\n]+\]\s*/i;

export function toPreview(content: string): string {
    const stripped = content
        .replace(MEMORY_TAG_REGEX, '')
        .replace(EMOTION_TAG_REGEX, '')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.length > PREVIEW_MAX ? stripped.slice(0, PREVIEW_MAX) : stripped;
}

let currentRoomLoadSequence = 0;

export function nextRoomLoadSequence(): number {
    currentRoomLoadSequence += 1;
    return currentRoomLoadSequence;
}

export function getRoomLoadSequence(): number {
    return currentRoomLoadSequence;
}
