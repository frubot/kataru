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
    /** 'narration' セグメント用のvoice。未指定・空ならprofile.voiceで読む。 */
    narratorVoice?: string;
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
    /** objectUrlsと同じ並び。セグメント境界のpieceの前にだけ短い間を挟む。
     * SSEのチャンク連続再生ではfalseでシームレスに繋ぐ。 */
    gapBefore: boolean[];
    /** 現在audioに読み込んでいるpieceのindex。-1は未再生。 */
    segmentIndex: number;
    byteSize: number;
    /** 全piece到着済みでobjectUrlsが確定したか。部分的な生成途中や
     * 途中で追い出されたエントリはfalseで、キャッシュ再生しない。 */
    complete: boolean;
    /** このエントリの再生を管理するplayNowのgeneration。追い越された
     * playNowが新しい再生の状態を上書きしないための所有権。 */
    playGeneration: number;
    status: TtsPlaybackStatus;
    error: string | null;
}

/** 1回分の連続再生単位。非SSEではセグメントごとのblob、Irodori SSEでは
 * audio_chunkイベントのblobがpieceになる。 */
interface TtsAudioPiece {
    blob: Blob;
    gapBefore: boolean;
}

/** 生成中のfetchを共有するハンドル。pieceは逐次pushされ、subscribeは
 * 受信済みのbacklogも順にreplayする（プリフェッチ途中からの再生追従用）。 */
interface TtsFetchHandle {
    cacheKey: string;
    pieces: TtsAudioPiece[];
    done: Promise<TtsAudioPiece[]>;
    subscribe: (listener: (piece: TtsAudioPiece, index: number) => void) => void;
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
 * playNowが同じストリームに追従するため、音声生成リクエストが重複しない。 */
const inflightFetches = new Map<TtsEntry, TtsFetchHandle>();
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
            gapBefore: [],
            segmentIndex: -1,
            byteSize: 0,
            complete: false,
            playGeneration: 0,
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

function isEventStreamResponse(response: Response): boolean {
    return response.headers.get('content-type')
        ?.toLowerCase().startsWith('text/event-stream') ?? false;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** SSEブロック（event行+data行）1件を解釈する。audio_chunkでemit、
 * errorで例外、doneでtrueを返す。 */
function dispatchTtsSseBlock(
    block: string,
    emit: (blob: Blob) => void,
): 'done' | null {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed.startsWith(':')) continue;
        if (trimmed.startsWith('event:')) {
            event = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('data:')) {
            dataLines.push(trimmed.slice(5).replace(/^ /, ''));
        }
    }
    const data = dataLines.join('\n');
    if (event === 'audio_chunk') {
        const chunk = JSON.parse(data) as {
            audio_base64?: string;
            media_type?: string;
        };
        if (chunk.audio_base64) {
            emit(new Blob([base64ToBytes(chunk.audio_base64)], {
                type: chunk.media_type || 'audio/wav',
            }));
        }
    } else if (event === 'error') {
        const parsed = JSON.parse(data) as { error?: { message?: string } };
        throw new Error(parsed.error?.message || '音声を生成できませんでした。');
    } else if (event === 'done') {
        return 'done';
    }
    return null;
}

/** Irodoriの text/event-stream 応答を読み、audio_chunkごとにemitする。
 * doneイベントを受けずに切断された場合は欠落ありとしてエラーにする。 */
async function consumeTtsEventStream(
    response: Response,
    emit: (blob: Blob) => void,
): Promise<void> {
    const body = response.body;
    if (!body) throw new Error('音声ストリームを受信できませんでした。');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false;
    try {
        while (!sawDone) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let sep = buffer.indexOf('\n\n');
            while (sep >= 0) {
                if (dispatchTtsSseBlock(buffer.slice(0, sep), emit) === 'done') {
                    sawDone = true;
                }
                buffer = buffer.slice(sep + 2);
                sep = buffer.indexOf('\n\n');
            }
        }
        buffer += decoder.decode();
        if (!sawDone && buffer.trim()) {
            sawDone = dispatchTtsSseBlock(buffer, emit) === 'done';
        }
    } finally {
        void reader.cancel().catch(() => {});
    }
    if (!sawDone) {
        throw new Error('音声ストリームが中断されました。');
    }
}

async function fetchTtsAudio(
    params: TtsRequestParams,
    emit: (piece: TtsAudioPiece) => void,
): Promise<void> {
    // セグメントは順に1リクエストずつ送る。単一キューのエンジン（Irodori等）
    // に同時リクエストで待たせないため。pieceは届き次第emitして先行再生する。
    for (const [segmentIndex, segment] of params.segments.entries()) {
        const voice = segment.kind === 'narration' && params.narratorVoice
            ? params.narratorVoice
            : params.profile.voice;
        const response = await fetch('/api/tts', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: segment.text,
                ...(segment.caption ? { caption: segment.caption } : {}),
                captionCfgScale: params.captionCfgScale,
                voice,
                speed: params.profile.speed,
                connectionId: params.profile.connectionId,
                model: params.profile.model || undefined,
                // Irodori接続ではSSEで文単位の音声を逐次受け取る。他の接続先は
                // 無視されて通常の音声応答になる（content-typeで判別する）。
                stream: true,
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
        // セグメント先頭のpieceだけ間を挟む。チャンク連続再生はシームレス。
        let firstPiece = true;
        const emitBlob = (blob: Blob) => {
            emit({ blob, gapBefore: segmentIndex > 0 && firstPiece });
            firstPiece = false;
        };
        if (isEventStreamResponse(response)) {
            await consumeTtsEventStream(response, emitBlob);
        } else {
            emitBlob(await response.blob());
        }
    }
}

/** entryへpieceを1件追加する。index位置が既に埋まっていれば何もしない
 * （fill用と再生用の両方のsubscriberから呼ばれても二重追加にならない）。 */
function appendEntryPiece(entry: TtsEntry, piece: TtsAudioPiece, index: number): void {
    if (entry.objectUrls.length !== index) return;
    entry.objectUrls.push(URL.createObjectURL(piece.blob));
    entry.gapBefore.push(piece.gapBefore);
    entry.byteSize += piece.blob.size;
    cachedAudioBytes += piece.blob.size;
    audioCacheOrder.delete(entry);
    audioCacheOrder.add(entry);
    evictAudioCache();
}

/** entry用の生成fetchを立ち上げ、piece到着ごとにentryへ追記して再生を
 * 進めるsubscriberを繋ぐ。再生が追い越されてもキャッシュの充填は続く。 */
function startTtsFetch(
    entry: TtsEntry,
    params: TtsRequestParams,
    cacheKey: string,
): TtsFetchHandle {
    const pieces: TtsAudioPiece[] = [];
    const listeners = new Set<(piece: TtsAudioPiece, index: number) => void>();
    const handle: TtsFetchHandle = {
        cacheKey,
        pieces,
        done: fetchTtsAudio(params, (piece) => {
            const index = pieces.length;
            pieces.push(piece);
            for (const listener of listeners) listener(piece, index);
        }).then(() => pieces),
        subscribe(listener) {
            for (const [index, piece] of pieces.entries()) listener(piece, index);
            listeners.add(listener);
        },
    };
    // キャッシュ充填+再生駆動。handleがinflightの現役である間だけ追記する
    // （別条件のfetchに置き換わった旧handleのpieceを混ぜないため）。
    handle.subscribe((piece, index) => {
        if (inflightFetches.get(entry) !== handle) return;
        if (entriesByRoom.get(entry.roomId)?.get(entry.messageId) !== entry) return;
        appendEntryPiece(entry, piece, index);
        pumpEntryPlayback(entry);
    });
    handle.done.then(() => {
        if (inflightFetches.get(entry) !== handle) return;
        inflightFetches.delete(entry);
        if (entriesByRoom.get(entry.roomId)?.get(entry.messageId) !== entry) return;
        entry.complete = pieces.length > 0 && entry.objectUrls.length === pieces.length;
        if (entry.complete) entry.cacheKey = cacheKey;
        if (entry === activeEntry) {
            pumpEntryPlayback(entry);
            // 最終pieceの再生が終わって次piece待ちだった場合をここで締める。
            if (audio?.ended
                && entry.segmentIndex + 1 >= entry.objectUrls.length
                && entry.status === 'playing') {
                setEntryStatus(entry, 'paused', null);
                advanceQueue();
            }
            return;
        }
        if (entry.status === 'loading') setEntryStatus(entry, 'paused', null);
    }, () => {
        if (inflightFetches.get(entry) === handle) inflightFetches.delete(entry);
        // プリフェッチ失敗は静かに諦める。再生時に通常経路で再試行される。
        if (entry !== activeEntry && entry.status === 'loading') {
            setEntryStatus(entry, 'paused', null);
        }
    });
    return handle;
}

/** 同条件の生成中fetchがあればそれを返す。pieceはentry.objectUrlsへ常に
 * 先頭から順に追記されるので、両者の長さが一致している時だけ再利用できる
 * （追い出し等で欠けたpieceは二度と届かないため、欠けがあれば新規にする）。 */
function ensureTtsFetch(
    entry: TtsEntry,
    params: TtsRequestParams,
    cacheKey: string,
): TtsFetchHandle {
    const existing = inflightFetches.get(entry);
    if (existing
        && existing.cacheKey === cacheKey
        && existing.pieces.length === entry.objectUrls.length) {
        return existing;
    }
    dropEntryAudio(entry);
    const handle = startTtsFetch(entry, params, cacheKey);
    inflightFetches.set(entry, handle);
    return handle;
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

/** 次のpieceへ進む。セグメント境界のpieceだけ小さな間を挟む（*...* の動作
 * 描写の間）。チャンク間は即時再生して繋げる。 */
function scheduleNextPiece(entry: TtsEntry, nextIndex: number): void {
    if (!audio) return;
    entry.segmentIndex = nextIndex;
    audio.src = entry.objectUrls[nextIndex];
    const gap = entry.gapBefore[nextIndex] ? SEGMENT_GAP_MS : 0;
    if (gap <= 0) {
        void audio.play().catch(() => handleAudioErrorEvent());
        return;
    }
    const generation = playbackGeneration;
    segmentGapTimer = window.setTimeout(() => {
        segmentGapTimer = null;
        if (generation === playbackGeneration
            && activeEntry === entry
            && (entry.status === 'playing' || entry.status === 'loading')
            && audio) {
            void audio.play().catch(() => handleAudioErrorEvent());
        }
    }, gap);
}

/** audioが止まっていて再生可能な次pieceがあれば再生を進める。piece未到着
 * なら何もせず、到着時の呼び出し（またはdone時の締め）に委ねる。 */
function pumpEntryPlayback(entry: TtsEntry): void {
    if (!audio || activeEntry !== entry) return;
    if (entry.status !== 'playing' && entry.status !== 'loading') return;
    if (!audio.paused && !audio.ended) return;
    if (segmentGapTimer !== null) return;
    const nextIndex = entry.segmentIndex + 1;
    if (nextIndex >= entry.objectUrls.length) return;
    scheduleNextPiece(entry, nextIndex);
}

function handleEndedEvent(): void {
    const entry = activeEntry;
    if (entry && entry.status !== 'error') {
        const nextIndex = entry.segmentIndex + 1;
        if (nextIndex < entry.objectUrls.length) {
            scheduleNextPiece(entry, nextIndex);
            return;
        }
        // SSE等でまだpieceが届く途中なら、次piece到着時のpumpに委ねて待つ。
        if (!entry.complete && inflightFetches.has(entry)) return;
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
    return JSON.stringify([params.segments, connectionId, model, voice, speed, params.captionCfgScale, params.narratorVoice]);
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
    entry.gapBefore = [];
    // 部分的なpieceが残っていても完成品ではないので再生キャッシュにしない。
    entry.complete = false;
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
    entry.playGeneration = generation;
    setEntryStatus(entry, 'loading', null);
    // SSEでは最初のpiece到着後にplayするため、ジェスチャが効いているうちに
    // AudioContextを起こしておく（iOSの自動再生制限対策）。
    void audioContext?.resume().catch(() => {});
    const cacheKey = ttsCacheKey(params);
    try {
        // 同一の合成条件で全piece揃いのキャッシュのみ再利用する
        // （同id再生成や設定変更へのガード）。生成途中のpartialは継続利用。
        if (entry.complete && entry.cacheKey === cacheKey && entry.objectUrls.length > 0) {
            // 再利用もLRUの新しい側へ移す。
            audioCacheOrder.delete(entry);
            audioCacheOrder.add(entry);
            entry.segmentIndex = 0;
            element.src = entry.objectUrls[0];
            // resume() must run inside the playback gesture's transient activation
            // on iOS; the 'play' event arrives too late.
            void audioContext?.resume().catch(() => {});
            await element.play();
            if (generation !== playbackGeneration || entry.playGeneration !== generation) {
                if (entry.playGeneration === generation
                    && (entry.status === 'loading' || entry.status === 'playing')) {
                    setEntryStatus(entry, 'paused', null);
                }
                return;
            }
            if (entry.status === 'loading') setEntryStatus(entry, 'playing', null);
            return;
        }
        entry.segmentIndex = -1;
        const handle = ensureTtsFetch(entry, params, cacheKey);
        // プリフェッチ等で既に届いているpieceがあれば即座に再生を始める。
        pumpEntryPlayback(entry);
        await handle.done;
    } catch (error) {
        if (entry.playGeneration !== generation) {
            // 同一entryを別のplayNowが管理中。状態は新しい側が書く。
        } else if (generation === playbackGeneration) {
            setEntryStatus(entry, 'error', ttsErrorMessage(error));
        } else if (entry.status === 'loading') {
            setEntryStatus(entry, 'paused', null);
        }
        throw error;
    }
    if (entry.playGeneration !== generation) return;
    if (generation !== playbackGeneration) {
        if (entry.status === 'loading') setEntryStatus(entry, 'paused', null);
        return;
    }
    if (entry.objectUrls.length === 0) {
        setEntryStatus(entry, 'error', '音声を生成できませんでした。');
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
 * ページ送り時に生成待ちで間が空くのを防ぐプリフェッチ。pieceは到着次第
 * entryへ充填され、playNowは生成途中からでも再生を始められる。 */
export function prefetchTtsAudio(params: TtsRequestParams): void {
    if (typeof window === 'undefined' || params.segments.length === 0) return;
    const entry = ensureEntry(params);
    if (entry === activeEntry) return;
    const cacheKey = ttsCacheKey(params);
    if (entry.complete && entry.cacheKey === cacheKey) return;
    const inflight = inflightFetches.get(entry);
    if (inflight
        && inflight.cacheKey === cacheKey
        && inflight.pieces.length === entry.objectUrls.length) {
        return;
    }
    setEntryStatus(entry, 'loading', null);
    ensureTtsFetch(entry, params, cacheKey);
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
    // 生成途中にpauseされた場合まだpieceを読み込んでいないことがある。
    if (entry.segmentIndex < 0) entry.segmentIndex = 0;
    if (audio.ended && !entry.complete && inflightFetches.has(entry)) {
        // 次piece待ちで終端に達していた場合は、到着済みの次pieceへ進むだけにする。
        const nextIndex = entry.segmentIndex + 1;
        if (nextIndex < entry.objectUrls.length) {
            scheduleNextPiece(entry, nextIndex);
        } else {
            setEntryStatus(entry, 'playing', null);
        }
        return;
    }
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
