import { describe, expect, test } from 'vitest';

import {
    buildVirtualLayout,
    computeVirtualRange,
    estimateChatMessageHeight,
    getMeasurementScrollAdjustment,
    shouldFollowChatBottom,
} from '../components/chat/chatVirtualization';

describe('chat history virtualization', () => {
    test('keeps the rendered window bounded for thousands of variable-height messages', () => {
        const sizes = Array.from({ length: 5_000 }, (_, index) => 56 + (index % 11) * 17);
        const layout = buildVirtualLayout(sizes);
        const range = computeVirtualRange(layout, 240_000, 900, 640);

        expect(range.startIndex).toBeGreaterThan(0);
        expect(range.endIndex).toBeLessThan(sizes.length - 1);
        expect(range.endIndex - range.startIndex + 1).toBeLessThan(40);
    });

    test('uses measured sizes and gaps to position each row', () => {
        const layout = buildVirtualLayout([50, 120, 80], 16);

        expect(layout.starts).toEqual([0, 66, 202]);
        expect(layout.totalSize).toBe(282);
        expect(computeVirtualRange(layout, 70, 20, 0)).toEqual({
            startIndex: 1,
            endIndex: 1,
        });
    });

    test('compensates measurements above the viewport but leaves bottom-following alone', () => {
        expect(getMeasurementScrollAdjustment({
            itemEnd: 200,
            viewportStart: 500,
            previousSize: 100,
            nextSize: 145,
            followingBottom: false,
        })).toBe(45);
        expect(getMeasurementScrollAdjustment({
            itemEnd: 600,
            viewportStart: 500,
            previousSize: 100,
            nextSize: 145,
            followingBottom: false,
        })).toBe(0);
        expect(getMeasurementScrollAdjustment({
            itemEnd: 200,
            viewportStart: 500,
            previousSize: 100,
            nextSize: 145,
            followingBottom: true,
        })).toBe(0);
    });

    test('stops following the bottom as soon as the user scrolls upward', () => {
        expect(shouldFollowChatBottom({
            previousScrollTop: 1_000,
            scrollTop: 980,
            distanceFromBottom: 20,
        })).toBe(false);
        expect(shouldFollowChatBottom({
            previousScrollTop: 900,
            scrollTop: 980,
            distanceFromBottom: 20,
        })).toBe(true);
        expect(shouldFollowChatBottom({
            previousScrollTop: 900,
            scrollTop: 920,
            distanceFromBottom: 120,
        })).toBe(false);
    });

    test('estimates longer assistant messages as taller while capping pathological content', () => {
        expect(estimateChatMessageHeight('short', 'assistant'))
            .toBeGreaterThan(estimateChatMessageHeight('short', 'user'));
        expect(estimateChatMessageHeight('x'.repeat(4_000), 'assistant')).toBe(640);
    });
});
