import { useSyncExternalStore } from 'react';

import type { AiApiConfig } from './aiApi';
import type { TtsProfile, TtsSpeechSegment } from './tts';

export type TtsPlaybackStatus = 'loading' | 'playing' | 'paused' | 'error';

export interface TtsEntryState {
    status: TtsPlaybackStatus | null;
    error: string | null;
}

export interface TtsRequestParams {
    roomId: string;
    messageId: string;
    /** 読み上げテキストのセグメント。*...* の動作描写で区切られた箇所ごとに
     * 分割され、順に合成・再生される（動作の分だけ小さな間が入る）。 */
    segments: TtsSpeechSegment[];
    profile: TtsProfile;
    /** Irodoriの caption ガイダンス強度（irodori.cfg_scale_caption）。他の
     * 接続先ではバックエンドが無視する。 */
    captionCfgScale: number;
    aiApiConfig: AiApiConfig;
}

interface TtsEntry {
    roomId: string;
    messageId: string;
    cacheKey: string;
    objectUrls: string[];
    segmentIndex: number;
    byteSize: number;
    status: TtsPlaybackStatus;
    error: string | null;
}

const EMPTY_ENTRY_STATE: TtsEntryState = { status: null, error: null };

/** 音声Blobキャッシュの上限。自動読み上げが長時間続いてもObject URLが
 * 無制限に溜まらないよう、件数と合計サイズでLRU追い出しを行う。 */
const MAX_CACHED_AUDIO_ENTRIES = 100;
const MAX_CACHED_AUDIO_BYTES = 64 * 1024 * 1024;

const entriesByRoom = new Map<string, Map<string, TtsEntry>>();
/** objectUrlを保持するentryを古い順に並べる（Setは挿入順を維持する）。 */
const audioCacheOrder = new Set<TtsEntry>();
let cachedAudioBytes = 0;
const entryStateCache = new Map<string, TtsEntryState>();
const listeners = new Set<() => void>();
const queue: TtsRequestParams[] = [];
let audio: HTMLAudioElement | null = null;
let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;
let playbackVolume = 1;
let analyser: AnalyserNode | null = null;
let analyserSamples: Uint8Array<ArrayBuffer> | null = null;
let activeEntry: TtsEntry | null = null;
let playbackGeneration = 0;
/** 生成中のfetchをentry単位で共有する。プリフェッチ中にページ送りされても
 * playNowが同じpromiseをawaitするため、音声生成リクエストが重複しない。 */
const inflightFetches = new Map<TtsEntry, { cacheKey: string; promise: Promise<Blob[]> }>();
/** *...* で区切られたセグメントの間に挟む小さなポーズ（動作描写の間）。 */
const SEGMENT_GAP_MS = 350;
let segmentGapTimer: number | null = null;

function clearSegmentGap(): void {
    if (segmentGapTimer !== null) {
        window.clearTimeout(segmentGapTimer);
        segmentGapTimer = null;
    }
}

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
            cacheKey: '',
            objectUrls: [],
            segmentIndex: 0,
            byteSize: 0,
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

async function fetchTtsAudio(params: TtsRequestParams): Promise<Blob[]> {
    const blobs: Blob[] = [];
    // セグメントは順に1リクエストずつ送る。単一キューのエンジン（Irodori等）
    // に同時リクエストで待たせないため。
    for (const segment of params.segments) {
        const response = await fetch('/api/tts', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: segment.text,
                ...(segment.caption ? { caption: segment.caption } : {}),
                captionCfgScale: params.captionCfgScale,
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
        blobs.push(await response.blob());
    }
    return blobs;
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
    // The routed element stays silent while the context is suspended; playback
    // is the signal to recover from an autoplay-blocked start.
    void audioContext?.resume().catch(() => {});
    if (activeEntry && activeEntry.status !== 'error' && activeEntry.status !== 'playing') {
        setEntryStatus(activeEntry, 'playing', null);
    }
}

function handleEndedEvent(): void {
    const entry = activeEntry;
    if (entry && entry.status !== 'error') {
        const nextIndex = entry.segmentIndex + 1;
        if (nextIndex < entry.objectUrls.length && audio) {
            // *...* で区切られた次の文へ。動作描写の分だけ小さな間を置く。
            entry.segmentIndex = nextIndex;
            audio.src = entry.objectUrls[nextIndex];
            const generation = playbackGeneration;
            segmentGapTimer = window.setTimeout(() => {
                segmentGapTimer = null;
                if (generation === playbackGeneration
                    && activeEntry === entry
                    && entry.status === 'playing'
                    && audio) {
                    void audio.play().catch(() => handleAudioErrorEvent());
                }
            }, SEGMENT_GAP_MS);
            return;
        }
        setEntryStatus(entry, 'paused', null);
    }
    advanceQueue();
}

function handleAudioErrorEvent(): void {
    clearSegmentGap();
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
        // Route the element through an analyser so the 3D avatar can lip-sync.
        // One element feeds one MediaElementSource for the app's lifetime.
        const ContextClass = window.AudioContext
            ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (ContextClass) {
            audioContext = new ContextClass();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            gainNode = audioContext.createGain();
            gainNode.gain.value = playbackVolume;
            audioContext.createMediaElementSource(audio).connect(gainNode);
            gainNode.connect(analyser);
            analyser.connect(audioContext.destination);
            analyserSamples = new Uint8Array(analyser.fftSize);
        }
    }
    return audio;
}

function clampPlaybackVolume(volume: number): number {
    if (!Number.isFinite(volume)) return 1;
    return Math.min(1, Math.max(0, volume));
}

/** 再生中の音声へ即時反映される音量（0-1）。AudioContextが無い環境では
 * 要素のvolumeへフォールバックする。 */
export function setTtsPlaybackVolume(volume: number): void {
    playbackVolume = clampPlaybackVolume(volume);
    if (gainNode) {
        gainNode.gain.value = playbackVolume;
    } else if (audio) {
        audio.volume = playbackVolume;
    }
}

/** Instantaneous TTS volume (0-1). Returns 0 without a playable element, while
 * paused/ended, or when the context has not been resumed yet. */
export function getTtsAudioLevel(): number {
    if (!audio || !analyser || !analyserSamples || !audio.src || audio.paused) return 0;
    analyser.getByteTimeDomainData(analyserSamples);
    let sum = 0;
    for (const sample of analyserSamples) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
    }
    // Speech RMS typically lands between ~0.02 (quiet) and ~0.2 (loud).
    const rms = Math.sqrt(sum / analyserSamples.length);
    return Math.min(1, Math.max(0, (rms - 0.02) * 6));
}

/** 合成結果を一意に決める入力のキャッシュキー。声・速度・モデル・接続先が
 * 変わったら再生成するため、textだけでなくprofileの合成パラメータを含める。
 * volumeは再生時に反映されるだけなので含めない。 */
function ttsCacheKey(params: TtsRequestParams): string {
    const { connectionId, model, voice, speed } = params.profile;
    return JSON.stringify([params.segments, connectionId, model, voice, speed, params.captionCfgScale]);
}

function dropEntryAudio(entry: TtsEntry): void {
    if (entry.objectUrls.length > 0) {
        for (const url of entry.objectUrls) {
            URL.revokeObjectURL(url);
        }
        cachedAudioBytes -= entry.byteSize;
        entry.objectUrls = [];
        entry.byteSize = 0;
    }
    audioCacheOrder.delete(entry);
}

/** 上限を超えた分だけ、再生中・生成中以外の古い音声から順に解放する。 */
function evictAudioCache(): void {
    for (const entry of audioCacheOrder) {
        if (audioCacheOrder.size <= MAX_CACHED_AUDIO_ENTRIES
            && cachedAudioBytes <= MAX_CACHED_AUDIO_BYTES) {
            return;
        }
        if (entry === activeEntry || entry.status === 'loading') continue;
        dropEntryAudio(entry);
    }
}

async function playNow(params: TtsRequestParams): Promise<void> {
    const element = getAudio();
    if (!element || params.segments.length === 0) return;
    setTtsPlaybackVolume(params.profile.volume);
    const generation = ++playbackGeneration;
    // 常に1本だけ再生する。前のエントリは paused に留める。
    element.pause();
    clearSegmentGap();
    markActivePaused();
    const entry = ensureEntry(params);
    activeEntry = entry;
    setEntryStatus(entry, 'loading', null);
    const cacheKey = ttsCacheKey(params);
    try {
        // 同一の合成条件でキャッシュ済みの音声のみ再利用する
        // （同id再生成や設定変更へのガード）。
        if (entry.objectUrls.length === 0 || entry.cacheKey !== cacheKey) {
            // プリフェッチ中の同条件fetchがあれば待ち合わせて再利用する。
            const inflight = inflightFetches.get(entry);
            const blobs = inflight && inflight.cacheKey === cacheKey
                ? await inflight.promise
                : await fetchTtsAudio(params);
            // 追い越された結果は破棄する。新しい再生がentryのURLを使っている
            // 可能性があるため、ここでrevoke/上書きはしない。
            if (generation !== playbackGeneration) {
                if (entry.status === 'loading') setEntryStatus(entry, 'paused', null);
                return;
            }
            dropEntryAudio(entry);
            entry.objectUrls = blobs.map((blob) => URL.createObjectURL(blob));
            entry.byteSize = blobs.reduce((total, blob) => total + blob.size, 0);
            entry.cacheKey = cacheKey;
            audioCacheOrder.add(entry);
            cachedAudioBytes += entry.byteSize;
            evictAudioCache();
        } else {
            // 再利用もLRUの新しい側へ移す。
            audioCacheOrder.delete(entry);
            audioCacheOrder.add(entry);
        }
        entry.segmentIndex = 0;
        element.src = entry.objectUrls[0];
        // resume() must run inside the playback gesture's transient activation
        // on iOS; the 'play' event arrives too late.
        void audioContext?.resume().catch(() => {});
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
 * when an entry for the same messageId+synthesis parameters is ready. */
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

/** 次に表示されるページの音声を再生せずに先生成してキャッシュする。
 * ページ送り時に生成待ちで間が空くのを防ぐプリフェッチ。生成済み・同一条件で
 * 生成中なら何もしない。再生中のentryはplayNowが管理するので触らない。 */
export function prefetchTtsAudio(params: TtsRequestParams): void {
    if (typeof window === 'undefined' || params.segments.length === 0) return;
    const entry = ensureEntry(params);
    if (entry === activeEntry) return;
    const cacheKey = ttsCacheKey(params);
    if (entry.objectUrls.length > 0 && entry.cacheKey === cacheKey) return;
    if (inflightFetches.get(entry)?.cacheKey === cacheKey) return;
    const promise = fetchTtsAudio(params);
    inflightFetches.set(entry, { cacheKey, promise });
    setEntryStatus(entry, 'loading', null);
    promise.then((blobs) => {
        // 新しいプリフェッチに追い越された結果は捨てる。
        if (inflightFetches.get(entry)?.promise !== promise) return;
        inflightFetches.delete(entry);
        // clearTtsRoom等で抹消されたentryや、playNowが管理するentryには書かない。
        const registered = entriesByRoom.get(entry.roomId)?.get(entry.messageId) === entry;
        if (!registered || entry === activeEntry) return;
        dropEntryAudio(entry);
        entry.objectUrls = blobs.map((blob) => URL.createObjectURL(blob));
        entry.byteSize = blobs.reduce((total, blob) => total + blob.size, 0);
        entry.cacheKey = cacheKey;
        audioCacheOrder.delete(entry);
        audioCacheOrder.add(entry);
        cachedAudioBytes += entry.byteSize;
        evictAudioCache();
        if (entry.status === 'loading') setEntryStatus(entry, 'paused', null);
    }, () => {
        if (inflightFetches.get(entry)?.promise !== promise) return;
        inflightFetches.delete(entry);
        // プリフェッチ失敗は静かに諦める。再生時に通常経路で再試行される。
        if (entry !== activeEntry && entry.status === 'loading') {
            setEntryStatus(entry, 'paused', null);
        }
    });
}

export function pauseTtsPlayback(): void {
    if (typeof window === 'undefined') return;
    // 取得中のfetchが解決しても再生へ進まず paused に留まるようにする。
    playbackGeneration += 1;
    clearSegmentGap();
    if (audio) audio.pause();
    markActivePaused();
}

export function resumeTtsPlayback(): void {
    if (typeof window === 'undefined' || !audio) return;
    const entry = activeEntry;
    if (!entry || entry.status !== 'paused' || entry.objectUrls.length === 0) return;
    const src = entry.objectUrls[entry.segmentIndex];
    if (audio.src !== src) audio.src = src;
    void audioContext?.resume().catch(() => {});
    void audio.play().catch((error: unknown) => {
        if (activeEntry === entry) setEntryStatus(entry, 'error', ttsErrorMessage(error));
    });
}

export function stopTtsPlayback(): void {
    if (typeof window === 'undefined') return;
    queue.length = 0;
    playbackGeneration += 1;
    clearSegmentGap();
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
        dropEntryAudio(entry);
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
            dropEntryAudio(entry);
        }
    }
    entriesByRoom.clear();
    entryStateCache.clear();
    emitTts();
}
