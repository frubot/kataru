const ITALIC_ACTION_MARKDOWN = /\*(?!\*)[^*\n]+\*(?!\*)/;
const ITALIC_ACTION_MARKDOWN_GLOBAL = new RegExp(ITALIC_ACTION_MARKDOWN.source, 'g');

export type AssistantMarkdownSegment = {
    type: 'text' | 'action';
    content: string;
};

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

export function formatAssistantMarkdown(content: string): string {
    return content
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

        pushSegment(segments, 'text', content.slice(textStart, i));
        pushSegment(segments, 'action', content.slice(i + 1, closing));
        i = closing + 1;
        textStart = i;
    }

    pushSegment(segments, 'text', content.slice(textStart));
    return segments.length > 0 ? segments : [{ type: 'text', content: content.trim() || '...' }];
}
