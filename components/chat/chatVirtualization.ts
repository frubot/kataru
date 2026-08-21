export const CHAT_VIRTUALIZATION_THRESHOLD = 80;
export const CHAT_VIRTUAL_ITEM_GAP = 16;
export const CHAT_VIRTUAL_OVERSCAN_PX = 640;
export const CHAT_BOTTOM_FOLLOW_THRESHOLD = 96;

export function shouldFollowChatBottom({
    previousScrollTop,
    scrollTop,
    distanceFromBottom,
    threshold = CHAT_BOTTOM_FOLLOW_THRESHOLD,
}: {
    previousScrollTop: number;
    scrollTop: number;
    distanceFromBottom: number;
    threshold?: number;
}): boolean {
    const scrollingUp = scrollTop < previousScrollTop - 0.5;
    return !scrollingUp && distanceFromBottom <= threshold;
}

export type VirtualLayout = {
    starts: number[];
    sizes: number[];
    totalSize: number;
};

export type VirtualRange = {
    startIndex: number;
    endIndex: number;
};

export function estimateChatMessageHeight(content: string, role: 'user' | 'assistant'): number {
    const explicitLines = content.split('\n').length;
    const wrappedLines = Math.max(1, Math.ceil(content.length / (role === 'assistant' ? 72 : 84)));
    const visualLines = Math.max(explicitLines, wrappedLines);
    const baseHeight = role === 'assistant' ? 74 : 54;
    return Math.min(640, baseHeight + Math.max(0, visualLines - 1) * 24);
}

export function buildVirtualLayout(
    sizes: readonly number[],
    gap = CHAT_VIRTUAL_ITEM_GAP,
): VirtualLayout {
    const starts = new Array<number>(sizes.length);
    let offset = 0;

    for (let index = 0; index < sizes.length; index++) {
        starts[index] = offset;
        offset += Math.max(1, sizes[index]);
        if (index < sizes.length - 1) offset += gap;
    }

    return {
        starts,
        sizes: [...sizes],
        totalSize: offset,
    };
}

function findFirstItemEndingAfter(layout: VirtualLayout, offset: number): number {
    let low = 0;
    let high = layout.starts.length - 1;
    let result = layout.starts.length;

    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const end = layout.starts[middle] + layout.sizes[middle];
        if (end >= offset) {
            result = middle;
            high = middle - 1;
        } else {
            low = middle + 1;
        }
    }

    return result;
}

function findLastItemStartingBefore(layout: VirtualLayout, offset: number): number {
    let low = 0;
    let high = layout.starts.length - 1;
    let result = -1;

    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (layout.starts[middle] <= offset) {
            result = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return result;
}

export function computeVirtualRange(
    layout: VirtualLayout,
    scrollOffset: number,
    viewportSize: number,
    overscan = CHAT_VIRTUAL_OVERSCAN_PX,
): VirtualRange {
    if (layout.starts.length === 0) return { startIndex: 0, endIndex: -1 };

    const rangeStart = Math.max(0, scrollOffset - overscan);
    const rangeEnd = Math.max(rangeStart, scrollOffset + Math.max(0, viewportSize) + overscan);
    const startIndex = Math.min(
        layout.starts.length - 1,
        findFirstItemEndingAfter(layout, rangeStart),
    );
    const endIndex = Math.max(
        startIndex,
        findLastItemStartingBefore(layout, rangeEnd),
    );

    return { startIndex, endIndex };
}

export function getMeasurementScrollAdjustment({
    itemEnd,
    viewportStart,
    previousSize,
    nextSize,
    followingBottom,
}: {
    itemEnd: number;
    viewportStart: number;
    previousSize: number;
    nextSize: number;
    followingBottom: boolean;
}): number {
    if (followingBottom || itemEnd > viewportStart) return 0;
    return nextSize - previousSize;
}
