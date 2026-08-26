import type { Character, Room, VnTypingSpeed } from './store/types';

export const DEFAULT_COSTUME_NAME = 'default';
const NEUTRAL_EXPRESSION_NAME = 'neutral';

const VN_TYPING_DEFAULT_DELAY_MS = 24;
const VN_TYPING_COMMA_DELAY_MS = 70;
const VN_TYPING_SENTENCE_DELAY_MS = 160;
const VN_TYPING_ITALIC_DELAY_MS = 90;
export const VN_MESSAGE_PAGE_MAX_CHARS = 160;
const VN_TYPING_SPEED_MULTIPLIER: Record<VnTypingSpeed, number> = {
    slow: 1.55,
    default: 1,
    fast: 0.55,
    streaming: 1,
};

export type VisualNovelCostumeOption = {
    name: string;
    image?: string | null;
    expressionCount: number;
};

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

function findCostume(character: Character | null | undefined, costumeName: string | null | undefined) {
    if (!character || !costumeName || costumeName === DEFAULT_COSTUME_NAME) return null;
    return (character.costumes ?? []).find((costume) => costume.name === costumeName) ?? null;
}

function findDefaultCostume(character: Character | null | undefined) {
    return (character?.costumes ?? []).find((costume) => costume.name.toLowerCase() === DEFAULT_COSTUME_NAME) ?? null;
}

export function resolveVisualNovelCostumeName(
    room: Room | null | undefined,
    character: Character | null | undefined,
): string {
    if (!room || !character) return DEFAULT_COSTUME_NAME;
    const selectedName = room.costumeSelections?.[character.id];
    if (!selectedName || selectedName === DEFAULT_COSTUME_NAME) return DEFAULT_COSTUME_NAME;
    return findCostume(character, selectedName) ? selectedName : DEFAULT_COSTUME_NAME;
}

export function resolveVisualNovelExpressionImage(
    character: Character | null | undefined,
    emotion: string | null,
    costumeName = DEFAULT_COSTUME_NAME,
): string | null {
    if (!character) return null;
    const selectedCostume = findCostume(character, costumeName);
    if (selectedCostume) {
        const costumeExpressions = selectedCostume.expressions ?? [];
        const requested = emotion && emotion.toLowerCase() !== NEUTRAL_EXPRESSION_NAME
            ? costumeExpressions.find((expression) => expression.name.toLowerCase() === emotion.toLowerCase())
            : undefined;
        return requested?.image ?? selectedCostume.image ?? character.icon ?? null;
    }

    const expressions = character.expressions ?? [];
    const findExpression = (name: string) => expressions.find(
        (expression) => expression.name.toLowerCase() === name.toLowerCase(),
    );
    const requested = emotion ? findExpression(emotion) : undefined;
    const neutral = findExpression(NEUTRAL_EXPRESSION_NAME);
    return requested?.image ?? neutral?.image ?? expressions[0]?.image ?? character.icon ?? null;
}

export function getVisualNovelCostumeOptions(
    character: Character | null | undefined,
): VisualNovelCostumeOption[] {
    if (!character) return [];
    const defaultImage = findDefaultCostume(character)?.image
        ?? resolveVisualNovelExpressionImage(character, null, DEFAULT_COSTUME_NAME);
    return [
        {
            name: DEFAULT_COSTUME_NAME,
            image: defaultImage,
            expressionCount: character.expressions?.length ?? 0,
        },
        ...(character.costumes ?? [])
            .filter((costume) => costume.name.toLowerCase() !== DEFAULT_COSTUME_NAME)
            .map((costume) => ({
                name: costume.name,
                image: costume.image,
                expressionCount: costume.expressions?.length ?? 0,
            })),
    ];
}

export function getVisualNovelPreloadCandidates(
    character: Character | null | undefined,
    costumeName = DEFAULT_COSTUME_NAME,
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

    const selectedCostume = findCostume(character, costumeName);
    if (selectedCostume) {
        for (const expression of selectedCostume.expressions ?? []) add(expression.image);
        add(selectedCostume.image);
    } else {
        for (const expression of character.expressions ?? []) add(expression.image);
        add(character.icon);
    }

    // Costume changes are user-driven and can happen before the next response, so warm each
    // alternative's base image after the likely expression variants for the active costume.
    for (const costume of character.costumes ?? []) {
        if (costume.name !== selectedCostume?.name) add(costume.image);
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
        }

        const character = Array.from(content.slice(index))[0] ?? '';
        if (!character) break;
        segments.push(character);
        index += character.length;
    }
    return segments;
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
    if ('。.!！？!?…'.includes(current)) return 3;
    if ('」』】）》”’\"\''.includes(current) && '。.!！？!?…'.includes(previous)) return 3;
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
            if (end > start && visibleLength + nextLength > maxChars) break;
            visibleLength += nextLength;
            end++;
            const priority = getVisualNovelPageBreakPriority(segments, end);
            if (priority > 0) preferredBreaks.set(priority, end);
            if (visibleLength >= maxChars) break;
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
