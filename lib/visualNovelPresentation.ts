import {
    NEUTRAL_EXPRESSION_NAME,
    resolveActiveCostume,
    resolveDefaultCostume,
    type CostumeOwner,
} from './costumes';
import type { Character, Costume, Room, VnTypingSpeed } from './store/types';
import { getVrmExpressionNames, getVrmMotionNames } from './vrm';

const VN_TYPING_DEFAULT_DELAY_MS = 24;
const VN_TYPING_COMMA_DELAY_MS = 70;
const VN_TYPING_SENTENCE_DELAY_MS = 160;
const VN_TYPING_ITALIC_DELAY_MS = 90;
export const VN_MESSAGE_PAGE_MAX_CHARS = 160;
const VN_TYPING_SPEED_MULTIPLIER: Record<VnTypingSpeed, number> = {
    slow: 1.55,
    default: 1,
    fast: 0.55,
};

export type VisualNovelCostumeOption = {
    id: string;
    name: string;
    kind?: 'image' | 'vrm';
    image?: string | null;
    expressionCount: number;
    isDefault: boolean;
};

type VisualNovelExpressionSource = CostumeOwner;
type VisualNovelMotionSource = CostumeOwner;

export type VisualNovelBounceSnapshot = {
    contextKey: string | null;
    messageKey: string | null;
};

export function shouldTriggerVisualNovelBounce(
    previous: VisualNovelBounceSnapshot | null,
    current: VisualNovelBounceSnapshot,
): boolean {
    return previous != null
        && current.contextKey != null
        && current.messageKey != null
        && previous.contextKey === current.contextKey
        && previous.messageKey !== current.messageKey;
}

/** 選択中（無効ならデフォルト）の衣装。衣装が無ければ null。 */
export function findVisualNovelCostume(
    character: CostumeOwner | null | undefined,
    costumeId?: string | null,
): Costume | null {
    return resolveActiveCostume(character, costumeId);
}

/**
 * 部屋で表示する衣装の id。部屋の選択が有効ならそれを、未選択・削除済みなら
 * キャラクターのデフォルト衣装を返す。衣装が無ければ null。
 */
export function resolveVisualNovelCostumeId(
    room: Room | null | undefined,
    character: (CostumeOwner & Pick<Character, 'id'>) | null | undefined,
): string | null {
    if (!character) return null;
    const selectedId = room?.costumeSelections?.[character.id];
    return resolveActiveCostume(character, selectedId)?.id ?? null;
}

export function resolveVisualNovelExpressionImage(
    character: CostumeOwner | null | undefined,
    emotion: string | null,
    costumeId?: string | null,
): string | null {
    const costume = resolveActiveCostume(character, costumeId);
    if (!costume) return null;
    const requested = emotion && emotion.toLowerCase() !== NEUTRAL_EXPRESSION_NAME
        ? (costume.expressions ?? []).find((expression) => expression.name.toLowerCase() === emotion.toLowerCase())
        : undefined;
    return requested?.image ?? costume.image ?? null;
}

export function getVisualNovelCostumeOptions(
    character: CostumeOwner | null | undefined,
): VisualNovelCostumeOption[] {
    if (!character) return [];
    const defaultCostumeId = resolveDefaultCostume(character)?.id;
    return (character.costumes ?? []).map((costume) => ({
        id: costume.id,
        name: costume.name,
        ...(costume.kind ? { kind: costume.kind } : {}),
        image: costume.image,
        expressionCount: costume.kind === 'vrm' && costume.vrm
            ? getVrmExpressionNames(costume.vrm).length - 1
            : (costume.expressions ?? []).filter((expression) => expression.name.toLowerCase() !== NEUTRAL_EXPRESSION_NAME).length,
        isDefault: costume.id === defaultCostumeId,
    }));
}

export function getVisualNovelExpressionNames(
    character: VisualNovelExpressionSource | null | undefined,
    costumeId?: string | null,
): string[] {
    const activeCostume = resolveActiveCostume(character, costumeId);
    if (!activeCostume) return [];
    // A 3D costume exposes the names of its expression map rather than 2D variants.
    const names = activeCostume.kind === 'vrm' && activeCostume.vrm
        ? getVrmExpressionNames(activeCostume.vrm)
        : [NEUTRAL_EXPRESSION_NAME, ...(activeCostume.expressions ?? []).map((expression) => expression.name)];
    const seen = new Set<string>();
    return names
        .map((name) => name.trim())
        .filter((name) => {
            const key = name.toLowerCase();
            if (!name || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

export function getVisualNovelMotionNames(
    character: VisualNovelMotionSource | null | undefined,
    costumeId?: string | null,
): string[] {
    // One-shot motions only exist on VRM avatars; 2D costumes never expose names.
    const activeCostume = resolveActiveCostume(character, costumeId);
    const names = activeCostume?.kind === 'vrm' && activeCostume.vrm
        ? getVrmMotionNames(activeCostume.vrm)
        : [];
    const seen = new Set<string>();
    return names
        .map((name) => name.trim())
        .filter((name) => {
            const key = name.toLowerCase();
            if (!name || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

export function getVisualNovelPreloadCandidates(
    character: CostumeOwner | null | undefined,
    costumeId?: string | null,
    currentImage?: string | null,
    limit = 24,
): string[] {
    if (!character || limit <= 0) return [];

    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (source?: string | null) => {
        if (!source || source === currentImage || seen.has(source) || candidates.length >= limit) return;
        seen.add(source);
        candidates.push(source);
    };

    const activeCostume = resolveActiveCostume(character, costumeId);
    if (activeCostume) {
        for (const expression of activeCostume.expressions ?? []) add(expression.image);
        add(activeCostume.image);
    }

    // Costume changes are user-driven and can happen before the next response, so warm each
    // alternative's base image after the likely expression variants for the active costume.
    for (const costume of character.costumes ?? []) {
        if (costume.id !== activeCostume?.id) add(costume.image);
    }

    return candidates;
}

function isEscapedMarker(content: string, index: number): boolean {
    let slashCount = 0;
    for (let current = index - 1; current >= 0 && content[current] === '\\'; current--) {
        slashCount++;
    }
    return slashCount % 2 === 1;
}

function isSingleItalicMarker(content: string, index: number): boolean {
    return content[index] === '*'
        && content[index - 1] !== '*'
        && content[index + 1] !== '*'
        && !isEscapedMarker(content, index);
}

function findClosingItalicMarker(content: string, start: number): number {
    for (let index = start + 1; index < content.length; index++) {
        if (isSingleItalicMarker(content, index)) return index;
    }
    return -1;
}

export function buildVisualNovelTypingSegments(content: string): string[] {
    const segments: string[] = [];
    let index = 0;
    while (index < content.length) {
        if (isSingleItalicMarker(content, index)) {
            const closing = findClosingItalicMarker(content, index);
            if (closing > index + 1) {
                segments.push(content.slice(index, closing + 1));
                index = closing + 1;
                continue;
            }
            // Keep an in-progress action together. This lets streaming pagination show the
            // unfinished Markdown literally without ever fixing a page break inside it.
            segments.push(content.slice(index));
            break;
        }

        const character = Array.from(content.slice(index))[0] ?? '';
        if (!character) break;
        segments.push(character);
        index += character.length;
    }
    return segments;
}

export type StreamingVisualNovelPage = {
    content: string;
    complete: boolean;
    end: number;
};

export type StreamingVisualNovelPagination = {
    content: string;
    pages: StreamingVisualNovelPage[];
};

// Sanitization removes only a few markers, so a larger difference means the text
// is no longer the one the boundaries were computed for.
const VN_ALIGNMENT_MIN_MISMATCH_ALLOWANCE = 4;
const VN_ALIGNMENT_MAX_MISMATCH_RATIO = 0.1;
const VN_PAGE_CLOSING_ONLY = /^[\s」』】）》”’"'。、．，.,!！？?‼⁉…]*$/u;
const VN_SENTENCE_PUNCTUATION = '。.!！？?‼⁉';
const VN_CLOSING_MARKS = '」』】）》”’"\'';

/**
 * True when the segment at `index` extends the punctuation run before it, as in
 * "！？" or "。」". A page must not break inside such a run.
 */
function continuesVisualNovelPunctuation(segments: string[], index: number): boolean {
    const current = segments[index];
    const previous = segments[index - 1];
    if (!current || !previous || current.length !== 1 || previous.length !== 1) return false;
    const trailing = VN_SENTENCE_PUNCTUATION + VN_CLOSING_MARKS;
    return trailing.includes(current) && trailing.includes(previous);
}

// Final responses can remove quotation/Markdown markers and unescape line breaks.
// Align those edits before reusing source offsets; page numbers alone lose text.
// Returns null when the texts diverge beyond such cleanup.
function mapVisualNovelPageEnds(before: string, after: string, ends: number[]): number[] | null {
    if (after.startsWith(before)) return ends;

    const region = Math.max(0, ...ends);
    const offsets = new Map<number, number>([[0, 0]]);
    let source = 0;
    let target = 0;
    let mismatches = 0;
    while (source < before.length) {
        if (before[source] === after[target]) {
            source++;
            target++;
        } else if (before.startsWith('\\n', source) && after[target] === '\n') {
            source += 2;
            target++;
        } else if (before.startsWith('\\r', source) && after[target] === '\r') {
            source += 2;
            target++;
        } else {
            // Sanitization deletes characters, rather than rewriting the reply. On an
            // unexpected insertion, preserve the matching suffix instead of its old index.
            const nextSource = before.indexOf(after[target] ?? '', source + 1);
            const nextTarget = after.indexOf(before[source], target + 1);
            if (nextTarget >= 0 && (nextSource < 0 || nextTarget - target < nextSource - source)) {
                if (source < region) mismatches += nextTarget - target;
                target = nextTarget;
                continue;
            }
            if (source < region) mismatches++;
            source++;
        }
        offsets.set(source, target);
    }
    const allowance = Math.max(
        VN_ALIGNMENT_MIN_MISMATCH_ALLOWANCE,
        Math.ceil(region * VN_ALIGNMENT_MAX_MISMATCH_RATIO),
    );
    if (mismatches > allowance) return null;
    return ends.map((end) => offsets.get(end) ?? offsets.get(end - 1) ?? 0);
}

/** Keep the read prefix aligned when the final response removes formatting markers. */
export function alignVisualNovelTypedContent(before: string, after: string, visible: string): string {
    const [end] = mapVisualNovelPageEnds(before, after, [visible.length]) ?? [0];
    return after.slice(0, end);
}

/**
 * Reused boundaries must still cut the new text into readable pages. A page that is
 * empty, or holds only a closing quote or punctuation, would render as a blank box.
 */
function areUsableVisualNovelPageEnds(content: string, ends: number[]): boolean {
    let start = 0;
    for (const end of ends) {
        if (end <= start || end > content.length) return false;
        if (VN_PAGE_CLOSING_ONLY.test(content.slice(start, end))) return false;
        start = end;
    }
    const rest = content.slice(start).trim();
    return !rest || !VN_PAGE_CLOSING_ONLY.test(rest);
}

/** Retain confirmed boundaries and paginate only the remaining, unfinished suffix. */
export function updateStreamingVisualNovelPagination(
    content: string,
    complete: boolean,
    previous?: StreamingVisualNovelPagination,
    maxChars = VN_MESSAGE_PAGE_MAX_CHARS,
): StreamingVisualNovelPagination {
    const normalized = content.trim();
    const confirmed = previous?.pages.filter((page) => page.complete) ?? [];
    const mappedEnds = previous
        ? mapVisualNovelPageEnds(previous.content, normalized, confirmed.map((page) => page.end))
        : [];
    // Divergent text starts over rather than inheriting boundaries that no longer fit.
    // Plain growth keeps the boundaries already on screen as they are.
    const realigned = previous != null && !normalized.startsWith(previous.content);
    const ends = mappedEnds && (!realigned || areUsableVisualNovelPageEnds(normalized, mappedEnds))
        ? mappedEnds
        : [];
    let start = 0;
    const pages = ends.map((end) => {
        const page = { content: normalized.slice(start, end).trim(), complete: true, end };
        start = end;
        return page;
    });
    const suffixStart = start + (normalized.slice(start).length - normalized.slice(start).trimStart().length);
    pages.push(...splitStreamingVisualNovelMessage(normalized.slice(suffixStart), complete, maxChars)
        .map((page) => ({ ...page, end: suffixStart + page.end })));
    return { content: normalized, pages };
}

/**
 * Proposes pages for a fresh message or the unfinished suffix of a streaming message.
 * A sufficiently substantial sentence/paragraph can be read immediately. The pagination
 * snapshot retains confirmed boundaries across subsequent chunks and final sanitization.
 */
export function splitStreamingVisualNovelMessage(
    content: string,
    streamComplete: boolean,
    maxChars = VN_MESSAGE_PAGE_MAX_CHARS,
): StreamingVisualNovelPage[] {
    const normalized = content.trim();
    if (!normalized) return [];
    if (!Number.isFinite(maxChars) || maxChars <= 0) {
        return [{ content: normalized, complete: streamComplete, end: normalized.length }];
    }

    const segments = buildVisualNovelTypingSegments(normalized);
    const pages: StreamingVisualNovelPage[] = [];
    const minimumNaturalBreakLength = Math.max(1, Math.floor(maxChars * 0.6));
    let start = 0;
    const offsets = [0];
    for (const segment of segments) offsets.push(offsets[offsets.length - 1] + segment.length);

    while (start < segments.length) {
        let end = start;
        let visibleLength = 0;
        let sentenceCut = 0;
        let clauseCut = 0;
        let ready = false;
        while (end < segments.length) {
            const nextLength = getVisualNovelSegmentLength(segments[end]);
            if (end > start && visibleLength + nextLength > maxChars
                && !continuesVisualNovelPunctuation(segments, end)) {
                // The unfinished sentence has not been displayed yet, so it can move
                // intact to the next page. Only a long single sentence needs a fallback.
                end = sentenceCut || clauseCut || end;
                ready = true;
                break;
            }
            visibleLength += nextLength;
            end++;
            if (isStreamingSentenceEnd(segments, end, streamComplete)) {
                sentenceCut = end;
                if (visibleLength >= minimumNaturalBreakLength) {
                    ready = true;
                    break;
                }
            } else if (getVisualNovelPageBreakPriority(segments, end) === 2) {
                clauseCut = end;
            }
        }
        const page = segments.slice(start, end).join('').trim();
        if (page) pages.push({ content: page, complete: ready || streamComplete, end: offsets[end] });
        if (!ready) break;
        start = end;
        while (segments[start] != null && /^\s$/u.test(segments[start])) start++;
    }

    return pages;
}

// Wait for one character of lookahead after sentence punctuation so a closing
// quote arriving in the next chunk stays attached to the sentence.
function isStreamingSentenceEnd(segments: string[], end: number, complete: boolean): boolean {
    const current = segments[end - 1] ?? '';
    if (current === '\n' || (current.startsWith('*') && current.endsWith('*') && current.length > 2)) return true;
    if (continuesVisualNovelPunctuation(segments, end)) return false;
    let index = end - 1;
    while (index >= 0 && segments[index].length === 1 && VN_CLOSING_MARKS.includes(segments[index])) index--;
    if (index < 0 || segments[index].length !== 1 || !VN_SENTENCE_PUNCTUATION.includes(segments[index])) return false;
    return complete || end < segments.length;
}

/** Expose only complete sentences; retain the raw suffix in the pagination cache. */
export function getStreamingVisualNovelVisibleContent(content: string): string {
    const segments = buildVisualNovelTypingSegments(content);
    let end = 0;
    for (let index = 1; index <= segments.length; index++) {
        if (isStreamingSentenceEnd(segments, index, false)) end = index;
    }
    return segments.slice(0, end).join('').trim();
}

function getVisualNovelSegmentLength(segment: string): number {
    const isItalicSegment = segment.startsWith('*') && segment.endsWith('*') && segment.length > 2;
    return Array.from(isItalicSegment ? segment.slice(1, -1) : segment).length;
}

function getVisualNovelPageBreakPriority(segments: string[], end: number): number {
    const current = segments[end - 1] ?? '';
    const previous = segments[end - 2] ?? '';
    if (current === '\n' && previous === '\n') return 4;
    if (current === '\n') return 3;
    if (continuesVisualNovelPunctuation(segments, end)) return 0;
    if (current.length === 1 && VN_SENTENCE_PUNCTUATION.includes(current)) return 3;
    if (current.length === 1 && VN_CLOSING_MARKS.includes(current)
        && previous.length === 1 && VN_SENTENCE_PUNCTUATION.includes(previous)) return 3;
    if ('、,，;；:：'.includes(current) || /^\s$/u.test(current)) return 2;
    return 0;
}

/**
 * Splits a completed visual-novel message into readable pages. Italic action blocks are
 * kept intact, and paragraph/sentence boundaries are preferred over hard character cuts.
 */
export function splitVisualNovelMessage(
    content: string,
    maxChars = VN_MESSAGE_PAGE_MAX_CHARS,
): string[] {
    const normalized = content.trim();
    if (!normalized) return [];
    if (!Number.isFinite(maxChars) || maxChars <= 0) return [normalized];

    const segments = buildVisualNovelTypingSegments(normalized);
    const pages: string[] = [];
    let start = 0;

    while (start < segments.length) {
        let end = start;
        let visibleLength = 0;
        const preferredBreaks = new Map<number, number>();

        while (end < segments.length) {
            const nextLength = getVisualNovelSegmentLength(segments[end]);
            const continuesPunctuation = continuesVisualNovelPunctuation(segments, end);
            if (end > start && visibleLength + nextLength > maxChars && !continuesPunctuation) break;
            visibleLength += nextLength;
            end++;
            const priority = getVisualNovelPageBreakPriority(segments, end);
            if (priority > 0) preferredBreaks.set(priority, end);
            if (visibleLength >= maxChars && !continuesVisualNovelPunctuation(segments, end)) break;
        }

        if (end >= segments.length) {
            const page = segments.slice(start).join('').trim();
            if (page) pages.push(page);
            break;
        }

        const minimumPreferredLength = Math.max(1, Math.floor(maxChars * 0.4));
        let cut = end;
        for (const priority of [4, 3, 2]) {
            const candidate = preferredBreaks.get(priority);
            if (!candidate) continue;
            const candidateLength = segments
                .slice(start, candidate)
                .reduce((total, segment) => total + getVisualNovelSegmentLength(segment), 0);
            if (priority === 4 || candidateLength >= minimumPreferredLength) {
                cut = candidate;
                break;
            }
        }

        const page = segments.slice(start, cut).join('').trim();
        if (page) pages.push(page);
        start = cut;
        while (segments[start] != null && /^\s$/u.test(segments[start])) start++;
    }

    return pages.length > 0 ? pages : [normalized];
}

function getBaseVisualNovelTypingDelay(segment: string): number {
    if (segment === '\n') return VN_TYPING_SENTENCE_DELAY_MS;

    const isItalicSegment = segment.startsWith('*') && segment.endsWith('*') && segment.length > 2;
    const visibleSegment = isItalicSegment ? segment.slice(1, -1) : segment;
    const lastCharacter = Array.from(visibleSegment.trimEnd()).at(-1);

    if (lastCharacter && '。.!！？!?…'.includes(lastCharacter)) return VN_TYPING_SENTENCE_DELAY_MS;
    if (lastCharacter && '、,'.includes(lastCharacter)) return VN_TYPING_COMMA_DELAY_MS;
    if (isItalicSegment) return VN_TYPING_ITALIC_DELAY_MS;
    return VN_TYPING_DEFAULT_DELAY_MS;
}

export function getVisualNovelTypingDelay(segment: string, speed: VnTypingSpeed): number {
    return Math.max(
        1,
        Math.round(getBaseVisualNovelTypingDelay(segment) * VN_TYPING_SPEED_MULTIPLIER[speed]),
    );
}
