import { describe, expect, test } from 'vitest';

import {
    acceptsShortcutTargetByDefault,
    shouldIgnoreGlobalShortcut,
} from '../components/useKeyboardShortcut';

describe('global keyboard shortcuts', () => {
    const idle = { defaultPrevented: false, isComposing: false, modalOpen: false, menuOpen: false };

    test('ignores keys handled elsewhere, IME input, dialogs and menus', () => {
        expect(shouldIgnoreGlobalShortcut(idle)).toBe(false);
        expect(shouldIgnoreGlobalShortcut({ ...idle, defaultPrevented: true })).toBe(true);
        expect(shouldIgnoreGlobalShortcut({ ...idle, isComposing: true })).toBe(true);
        expect(shouldIgnoreGlobalShortcut({ ...idle, modalOpen: true })).toBe(true);
        expect(shouldIgnoreGlobalShortcut({ ...idle, menuOpen: true })).toBe(true);
    });

    test('accepts plain keys only outside text fields', () => {
        expect(acceptsShortcutTargetByDefault({ key: 'Escape', editableTarget: false })).toBe(true);
        expect(acceptsShortcutTargetByDefault({ key: 'Escape', editableTarget: true })).toBe(false);
        expect(acceptsShortcutTargetByDefault({ key: 'r', altKey: true, editableTarget: true })).toBe(true);
        expect(acceptsShortcutTargetByDefault({ key: 'k', ctrlKey: true, editableTarget: true })).toBe(true);
    });
});
