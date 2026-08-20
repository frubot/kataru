import { describe, expect, test } from 'vitest';

import { shouldOpenKeyboardShortcutsHelp } from '../components/chat/KeyboardShortcutsHelp';

const defaultContext = {
    key: '?',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    editableTarget: false,
    modalOpen: false,
};

describe('keyboard shortcut help', () => {
    test('opens for an unmodified question mark outside an editor', () => {
        expect(shouldOpenKeyboardShortcutsHelp(defaultContext)).toBe(true);
    });

    test('does not interrupt typing, IME input, modifiers, or another modal', () => {
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, editableTarget: true })).toBe(false);
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, isComposing: true })).toBe(false);
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, ctrlKey: true })).toBe(false);
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, modalOpen: true })).toBe(false);
        expect(shouldOpenKeyboardShortcutsHelp({ ...defaultContext, key: '/' })).toBe(false);
    });
});
