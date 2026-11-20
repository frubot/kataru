import { describe, expect, test } from 'vitest';
import {
    SIDEBAR_WIDTH_DEFAULT,
    SIDEBAR_WIDTH_MAX,
    SIDEBAR_WIDTH_MIN,
    clampSidebarWidth,
    parseSidebarWidth,
} from '../lib/sidebarWidth';

describe('sidebarWidth', () => {
    test('範囲外の幅を上下限に収める', () => {
        expect(clampSidebarWidth(10)).toBe(SIDEBAR_WIDTH_MIN);
        expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH_MAX);
        expect(clampSidebarWidth(300.6)).toBe(301);
    });

    test('保存値が数値でなければ既定値を使う', () => {
        expect(parseSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH_DEFAULT);
        expect(parseSidebarWidth('300')).toBe(SIDEBAR_WIDTH_DEFAULT);
        expect(parseSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
        expect(parseSidebarWidth(320)).toBe(320);
    });
});
