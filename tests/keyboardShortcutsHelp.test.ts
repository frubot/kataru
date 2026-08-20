import { describe, expect, test } from 'vitest';

import { shouldOpenKeyboardShortcutsHelp } from '../components/chat/KeyboardShortcutsHelp';

const defaultContext = {
    key: '/',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    isComposing: false,
    modalOpen: false,
};

describe('keyboard shortcut help', () => {
    test('opens for Ctrl + /', () => {
        expect(shouldOpenKeyboardShortcutsHelp(defaultContext)).toBe(true);
    });

    test('does not open for another key, modifiers, IME input, or another modal', () => {
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, key: '?' })).toBe(false);
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, ctrlKey: false })).toBe(false);
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, isComposing: true })).toBe(false);
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, metaKey: true })).toBe(false);
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, altKey: true })).toBe(false);
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, modalOpen: true })).toBe(false);
    });
});
