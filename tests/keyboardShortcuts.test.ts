import { describe, expect, test } from 'vitest';

import {
    createDefaultKeyboardShortcuts,
    getKeyboardShortcutLabels,
    keyboardShortcutFromEvent,
    matchesAnyKeyboardShortcut,
    normalizeKeyboardShortcuts,
} from '../lib/keyboardShortcuts';

describe('keyboard shortcuts', () => {
    test('captures and matches a key combination exactly', () => {
        const shortcut = keyboardShortcutFromEvent({
            key: 'Enter',
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            metaKey: false,
        });

        expect(shortcut).toEqual({
            key: 'Enter',
            ctrl: true,
            shift: false,
            alt: false,
            meta: false,
        });
        expect(matchesAnyKeyboardShortcut({ key: 'Enter', ctrlKey: true }, [shortcut!])).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: 'Enter' }, [shortcut!])).toBe(false);
        expect(getKeyboardShortcutLabels(shortcut!)).toEqual(['Ctrl', 'Enter']);
    });

    test('normalizes stored shortcuts and falls back per action', () => {
        const normalized = normalizeKeyboardShortcuts({
            sendMessage: [{ key: 'S', ctrl: true }],
            advanceTypewriter: [],
            closeDialog: [{ key: 'Shift', shift: true }],
        });

        expect(normalized.sendMessage).toEqual([{
            key: 's',
            ctrl: true,
            shift: false,
            alt: false,
            meta: false,
        }]);
        expect(normalized.advanceTypewriter).toEqual(createDefaultKeyboardShortcuts().advanceTypewriter);
        expect(normalized.closeDialog).toEqual(createDefaultKeyboardShortcuts().closeDialog);
    });

    test('ignores modifier-only capture events', () => {
        expect(keyboardShortcutFromEvent({ key: 'Control', ctrlKey: true })).toBeNull();
    });
});
