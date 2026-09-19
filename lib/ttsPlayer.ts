import { useSyncExternalStore } from 'react';

import type { AiApiConfig } from './aiApi';
import type { TtsProfile } from './tts';

export type TtsPlaybackStatus = 'loading' | 'playing' | 'paused' | 'error';

export interface TtsEntryState {
    status: TtsPlaybackStatus | null;
    error: string | null;
}

export interface TtsRequestParams {
    roomId: string;
    messageId: string;
    text: string;
    profile: TtsProfile;
    aiApiConfig: AiApiConfig;
}

interface TtsEntry {
    roomId: string;
    messageId: string;
    text: string;
    objectUrl: string | null;
    status: TtsPlaybackStatus;
    error: string | null;
}

const EMPTY_ENTRY_STATE: TtsEntryState = { status: null, error: null };

const entriesByRoom = new Map<string, Map<string, TtsEntry>>();
const entryStateCache = new Map<string, TtsEntryState>();
const listeners = new Set<() => void>();
const queue: TtsRequestParams[] = [];
let audio: HTMLAudioElement | null = null;
let activeEntry: TtsEntry | null = null;
let playbackGeneration = 0;

function emitTts(): void {
    for (const listener of listeners) listener();
}

export function subscribeTts(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function findEntry(messageId: string): TtsEntry | undefined {
    for (const roomEntries of entriesByRoom.values()) {
        const entry = roomEntries.get(messageId);
        if (entry) return entry;
    }
    return undefined;
}

export function getTtsEntryState(messageId: string): TtsEntryState {
    const entry = findEntry(messageId);
    const status = entry ? entry.status : null;
    const error = entry ? entry.error : null;
    const cached = entryStateCache.get(messageId);
    if (cached && cached.status === status && cached.error === error) return cached;
    const state = status === null && error === null ? EMPTY_ENTRY_STATE : { status, error };
    entryStateCache.set(messageId, state);
    return state;
}

export function useTtsEntry(messageId: string): TtsEntryState {
    return useSyncExternalStore(
        subscribeTts,
        () => getTtsEntryState(messageId),
        () => getTtsEntryState(messageId),
    );
}

function setEntryStatus(entry: TtsEntry, status: TtsPlaybackStatus, error: string | null): void {
    if (entry.status === status && entry.error === error) return;
    entry.status = status;
    entry.error = error;
    emitTts();
}

function ensureEntry(params: TtsRequestParams): TtsEntry {
    let roomEntries = entriesByRoom.get(params.roomId);
    if (!roomEntries) {
        roomEntries = new Map();
        entriesByRoom.set(params.roomId, roomEntries);
    }
    let entry = roomEntries.get(params.messageId);
    if (!entry) {
        entry = {
            roomId: params.roomId,
            messageId: params.messageId,
            text: '',
            objectUrl: null,
            status: 'loading',
            error: null,
        };
        roomEntries.set(params.messageId, entry);
    }
    return entry;
}

function ttsErrorMessage(error: unknown): string {
    return error instanceof Error && error.message
        ? error.message
        : '音声を生成できませんでした。';
}

async function fetchTtsAudio(params: TtsRequestParams): Promise<Blob> {
    const response = await fetch('/api/tts', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: params.text,
            voice: params.profile.voice,
            speed: params.profile.speed,
            connectionId: params.profile.connectionId,
            model: params.profile.model || undefined,
            aiApiConfig: params.aiApiConfig,
        }),
    });
    if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message = body && typeof body === 'object' && 'error' in body
            && typeof body.error === 'string'
            ? body.error
            : '音声を生成できませんでした。';
        throw new Error(message);
    }
    return response.blob();
}

function isPlaybackActive(): boolean {
    return activeEntry !== null
        && (activeEntry.status === 'playing' || activeEntry.status === 'loading');
}

function markActivePaused(): void {
    if (activeEntry && (activeEntry.status === 'playing' || activeEntry.status === 'loading')) {
        setEntryStatus(activeEntry, 'paused', null);
    }
}

function advanceQueue(): void {
    const next = queue.shift();
    if (!next) return;
    void playNow(next).catch(() => advanceQueue());
}

function handlePlayEvent(): void {
    if (activeEntry && activeEntry.status !== 'error' && activeEntry.status !== 'playing') {
        setEntryStatus(activeEntry, 'playing', null);
    }
}

function handleEndedEvent(): void {
    if (activeEntry && activeEntry.status !== 'error') {
        setEntryStatus(activeEntry, 'paused', null);
    }
    advanceQueue();
}

function handleAudioErrorEvent(): void {
    if (activeEntry && activeEntry.status !== 'error') {
        setEntryStatus(activeEntry, 'error', '音声を再生できませんでした。');
    }
    advanceQueue();
}

function getAudio(): HTMLAudioElement | null {
    if (typeof window === 'undefined' || typeof Audio !== 'function') return null;
    if (!audio) {
        audio = new Audio();
        audio.addEventListener('play', handlePlayEvent);
        audio.addEventListener('ended', handleEndedEvent);
        audio.addEventListener('error', handleAudioErrorEvent);
    }
    return audio;
}

async function playNow(params: TtsRequestParams): Promise<void> {
    const element = getAudio();
    if (!element) return;
    const generation = ++playbackGeneration;
    // 常に1本だけ再生する。前のエントリは paused に留める。
    element.pause();
    markActivePaused();
    const entry = ensureEntry(params);
    activeEntry = entry;
    setEntryStatus(entry, 'loading', null);
    try {
        // 同一テキストのキャッシュ済み音声のみ再利用する（同id再生成へのガード）。
        if (!entry.objectUrl || entry.text !== params.text) {
            const blob = await fetchTtsAudio(params);
            // 追い越された結果は破棄する。新しい再生がentryのURLを使っている
            // 可能性があるため、ここでrevoke/上書きはしない。
            if (generation !== playbackGeneration) {
                if (entry.status === 'loading') setEntryStatus(entry, 'paused', null);
                return;
            }
            if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
            entry.objectUrl = URL.createObjectURL(blob);
            entry.text = params.text;
        }
        element.src = entry.objectUrl;
        await element.play();
        if (generation !== playbackGeneration) {
            if (entry.status === 'loading' || entry.status === 'playing') {
                setEntryStatus(entry, 'paused', null);
            }
            return;
        }
        if (entry.status === 'loading') setEntryStatus(entry, 'playing', null);
    } catch (error) {
        if (generation === playbackGeneration) {
            setEntryStatus(entry, 'error', ttsErrorMessage(error));
        } else if (entry.status === 'loading') {
            setEntryStatus(entry, 'paused', null);
        }
        throw error;
    }
}

/** Plays immediately; stops whatever is currently playing. Uses the cache
 * when an entry for the same messageId+text is already 'ready'. */
export function requestTtsPlayback(params: TtsRequestParams): Promise<void> {
    if (typeof window === 'undefined') return Promise.resolve();
    queue.length = 0;
    return playNow(params);
}

/** Queues behind anything playing/queued (for sequential auto-play of
 * multiple arriving messages). */
export function enqueueTtsPlayback(params: TtsRequestParams): void {
    if (typeof window === 'undefined') return;
    if (queue.length > 0 || isPlaybackActive()) {
        queue.push(params);
        return;
    }
    void playNow(params).catch(() => advanceQueue());
}

export function pauseTtsPlayback(): void {
    if (typeof window === 'undefined') return;
    // 取得中のfetchが解決しても再生へ進まず paused に留まるようにする。
    playbackGeneration += 1;
    if (audio) audio.pause();
    markActivePaused();
}

export function resumeTtsPlayback(): void {
    if (typeof window === 'undefined' || !audio) return;
    const entry = activeEntry;
    if (!entry || entry.status !== 'paused' || !entry.objectUrl) return;
    if (audio.src !== entry.objectUrl) audio.src = entry.objectUrl;
    void audio.play().catch((error: unknown) => {
        if (activeEntry === entry) setEntryStatus(entry, 'error', ttsErrorMessage(error));
    });
}

export function stopTtsPlayback(): void {
    if (typeof window === 'undefined') return;
    queue.length = 0;
    playbackGeneration += 1;
    if (audio) audio.pause();
    markActivePaused();
}

export function clearTtsRoom(roomId: string): void {
    if (typeof window === 'undefined') return;
    const roomEntries = entriesByRoom.get(roomId);
    if (!roomEntries) return;
    if (activeEntry && roomEntries.get(activeEntry.messageId) === activeEntry) {
        stopTtsPlayback();
    }
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].roomId === roomId) queue.splice(i, 1);
    }
    for (const [messageId, entry] of roomEntries) {
        if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
        entryStateCache.delete(messageId);
    }
    entriesByRoom.delete(roomId);
    emitTts();
}

export function clearAllTts(): void {
    if (typeof window === 'undefined') return;
    queue.length = 0;
    stopTtsPlayback();
    for (const roomEntries of entriesByRoom.values()) {
        for (const entry of roomEntries.values()) {
            if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
        }
    }
    entriesByRoom.clear();
    entryStateCache.clear();
    emitTts();
}
