const ITALIC_ACTION_MARKDOWN = /\*(?!\*)[^*\n]+\*(?!\*)/;
const ITALIC_ACTION_MARKDOWN_GLOBAL = new RegExp(ITALIC_ACTION_MARKDOWN.source, 'g');

export type AssistantMarkdownSegment = {
    type: 'text' | 'action';
    content: string;
};

function isWhitespace(char: string | undefined): boolean {
    return char !== undefined && /\s/.test(char);
}

function isEscapedMarker(content: string, index: number): boolean {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && content[i] === '\\'; i--) {
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
    for (let i = start + 1; i < content.length; i++) {
        if (content[i] === '\n') return -1;
        if (isSingleItalicMarker(content, i)) return i;
    }
    return -1;
}

function pushSegment(segments: AssistantMarkdownSegment[], type: AssistantMarkdownSegment['type'], content: string): void {
    const normalized = content.trim();
    if (!normalized) return;
    segments.push({ type, content: normalized });
}

const DIALOGUE_OPEN = '「';
const DIALOGUE_CLOSE = '」';

/** Drops the 「」 that wrap one dialogue run (text between `*...*` actions).
 * A run that is cut off — still streaming, typing, or split across VN pages —
 * loses only its unmatched opening or closing bracket, so the visible prefix
 * stays stable while the text grows. */
function hideDialogueRunBrackets(run: string): string {
    const first = run.search(/\S/);
    if (first < 0) return run;
    const last = run.search(/\S\s*$/);
    const strip = (from: number, to: number) => run.slice(0, from) + run.slice(from + 1, to) + run.slice(to + 1);

    let depth = 0;
    for (let i = first; i <= last; i++) {
        if (run[i] === DIALOGUE_OPEN) {
            depth++;
        } else if (run[i] === DIALOGUE_CLOSE) {
            depth--;
            if (depth < 0) {
                // Only a lone closing bracket at the very end belongs to a
                // quote that started on an earlier page.
                return i === last ? run.slice(0, last) + run.slice(last + 1) : run;
            }
            if (depth === 0 && run[first] === DIALOGUE_OPEN) {
                return i === last ? strip(first, last) : run;
            }
        }
    }
    if (run[first] !== DIALOGUE_OPEN) return run;
    // The opening bracket never closed: the rest of the quote is not here yet.
    return run.slice(0, first) + run.slice(first + 1);
}

/** Display-only form of an assistant reply. Replies are stored as
 * `*narration* 「dialogue」 *narration*`; the brackets around each dialogue
 * run are hidden on screen, while 「」 quoted inside narration or in the
 * middle of a line stay visible. */
export function hideAssistantDialogueBrackets(content: string): string {
    if (!content.includes(DIALOGUE_OPEN) && !content.includes(DIALOGUE_CLOSE)) return content;
    let result = '';
    let runStart = 0;
    let inAction = false;
    for (let i = 0; i < content.length; i++) {
        if (!isSingleItalicMarker(content, i)) continue;
        const run = content.slice(runStart, i);
        result += inAction ? run : hideDialogueRunBrackets(run);
        result += '*';
        runStart = i + 1;
        inAction = !inAction;
    }
    const tail = content.slice(runStart);
    return result + (inAction ? tail : hideDialogueRunBrackets(tail));
}

export function formatAssistantMarkdown(content: string): string {
    return content
        .replace(/([^*\s])\*\s+\*(?!\s|\*)/g, '$1 ')
        .replace(ITALIC_ACTION_MARKDOWN_GLOBAL, '\n\n$&\n\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function splitAssistantMarkdownActions(content: string): AssistantMarkdownSegment[] {
    const segments: AssistantMarkdownSegment[] = [];
    let textStart = 0;
    let i = 0;

    while (i < content.length) {
        if (!isSingleItalicMarker(content, i)) {
            i++;
            continue;
        }

        const closing = findClosingItalicMarker(content, i);
        if (closing <= i + 1) {
            i++;
            continue;
        }

        let actionContent = content.slice(i + 1, closing);
        let end = closing + 1;
        for (;;) {
            let next = end;
            while (isWhitespace(content[next])) {
                next++;
            }
            if (next === end || !isSingleItalicMarker(content, next)) break;
            const nextClosing = findClosingItalicMarker(content, next);
            if (nextClosing <= next + 1) break;
            actionContent += content.slice(end, next) + content.slice(next + 1, nextClosing);
            end = nextClosing + 1;
        }

        pushSegment(segments, 'text', content.slice(textStart, i));
        pushSegment(segments, 'action', actionContent);
        i = end;
        textStart = i;
    }

    pushSegment(segments, 'text', content.slice(textStart));
    return segments.length > 0 ? segments : [{ type: 'text', content: content.trim() || '...' }];
}
