import { splitAssistantMarkdownActions } from './markdownUtils';
import { TTS_SPEED_MAX, TTS_SPEED_MIN, TTS_VOLUME_MAX, TTS_VOLUME_MIN } from './store/settings';
import type { AppState, Character } from './store/types';

export interface TtsProfile {
    connectionId: string;
    model: string;
    voice: string;
    speed: number;
    volume: number;
}

/** Per-character overrides win over global settings. Returns the effective
 * profile; `voice` may be empty when nothing is configured. */
export function resolveTtsProfile(
    state: Pick<AppState, 'ttsConnectionId' | 'ttsModel' | 'ttsVoice' | 'ttsSpeed' | 'ttsVolume'>,
    character?: Pick<Character, 'tts'> | null,
): TtsProfile {
    const tts = character?.tts;
    return {
        connectionId: typeof tts?.connectionId === 'string' && tts.connectionId.trim()
            ? tts.connectionId.trim()
            : state.ttsConnectionId,
        model: typeof tts?.model === 'string' ? tts.model.trim() : state.ttsModel,
        voice: typeof tts?.voice === 'string' && tts.voice.trim()
            ? tts.voice.trim()
            : state.ttsVoice,
        speed: typeof tts?.speed === 'number' && Number.isFinite(tts.speed)
            ? Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, tts.speed))
            : state.ttsSpeed,
        volume: typeof tts?.volume === 'number' && Number.isFinite(tts.volume)
            ? Math.min(TTS_VOLUME_MAX, Math.max(TTS_VOLUME_MIN, tts.volume))
            : state.ttsVolume,
    };
}

/** True when a play/auto-play request makes sense. */
export function isTtsProfilePlayable(profile: TtsProfile): boolean {
    return Boolean(profile.voice.trim()) && Boolean(profile.connectionId.trim());
}

function stripSpeechMarkdown(text: string): string {
    return text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/(\*\*|__|~~)([\s\S]*?)\1/g, '$2')
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
        .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
        .replace(/`+/g, '')
        .replace(/[*_~]/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export interface TtsSpeechSegment {
    text: string;
    /** 直前の *...* 動作描写。Irodori接続では caption として送られ、
     * 動作描写を次のセリフの演技指示にできる。 */
    caption?: string;
}

/** Speech segments = 'text' runs separated by *...* action segments (the
 * actions themselves are dropped), each markdown-stripped to plain text.
 * Keeping runs separate lets the player pause where an action was narrated
 * instead of collapsing everything into one request. The action immediately
 * preceding a run is attached as `caption`. */
export function buildSpeechSegments(content: string, includeActionCaptions = true): TtsSpeechSegment[] {
    const segments: TtsSpeechSegment[] = [];
    let pendingCaption: string | undefined;
    for (const segment of splitAssistantMarkdownActions(content)) {
        if (segment.type === 'action') {
            const action = segment.content.replace(/\s+/g, ' ').trim();
            pendingCaption = action || undefined;
            continue;
        }
        const text = stripSpeechMarkdown(segment.content);
        if (!text) continue;
        segments.push(includeActionCaptions && pendingCaption
            ? { text, caption: pendingCaption }
            : { text });
        pendingCaption = undefined;
    }
    return segments;
}

/** Speech text = 'text' segments only (drops *...* action segments), markdown
 * stripped to plain text, whitespace collapsed. Returns '' when nothing
 * speakable remains. */
export function buildSpeechText(content: string): string {
    return buildSpeechSegments(content).map((segment) => segment.text).join('\n');
}

export interface TtsSpeakerStyle {
    /** VOICEVOXのスタイルIDは数値、Irodoriのvoice IDは文字列。 */
    id: number | string;
    name: string;
}

export interface TtsSpeaker {
    name: string;
    styles: TtsSpeakerStyle[];
}

function isTtsSpeakerStyle(value: unknown): value is TtsSpeakerStyle {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const style = value as Record<string, unknown>;
    return (typeof style.id === 'number'
            || (typeof style.id === 'string' && style.id.length > 0))
        && typeof style.name === 'string';
}

function isTtsSpeakersResponse(value: unknown): value is { speakers: TtsSpeaker[] } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const speakers = (value as Record<string, unknown>).speakers;
    return Array.isArray(speakers) && speakers.every((speaker) => Boolean(
        speaker
        && typeof speaker === 'object'
        && typeof (speaker as Record<string, unknown>).name === 'string'
        && Array.isArray((speaker as Record<string, unknown>).styles)
        && (speaker as { styles: unknown[] }).styles.every(isTtsSpeakerStyle),
    ));
}

/** POST /api/tts/speakers. Throws Error with server `error` message. */
export async function getTtsSpeakers(connectionId: string): Promise<TtsSpeaker[]> {
    const response = await fetch('/api/tts/speakers', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const message = body && typeof body === 'object' && 'error' in body
            && typeof body.error === 'string'
            ? body.error
            : 'TTS話者一覧を取得できませんでした。';
        throw new Error(message);
    }
    if (!isTtsSpeakersResponse(body)) {
        throw new Error('TTS話者一覧の応答形式が不正です。');
    }
    return body.speakers;
}
