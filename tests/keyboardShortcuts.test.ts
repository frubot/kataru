import { describe, expect, test } from 'vitest';

import {
    createDefaultKeyboardShortcuts,
    getKeyboardShortcutLabels,
    hasCommandModifier,
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

    test('migrates the legacy Enter / Space typewriter default to Enter only', () => {
        const legacy = normalizeKeyboardShortcuts({
            advanceTypewriter: [{ key: 'Enter' }, { key: ' ' }],
        });
        expect(legacy.advanceTypewriter).toEqual([{
            key: 'Enter',
            ctrl: false,
            shift: false,
            alt: false,
            meta: false,
        }]);

        const customized = normalizeKeyboardShortcuts({
            advanceTypewriter: [{ key: ' ' }],
        });
        expect(customized.advanceTypewriter.map((shortcut) => shortcut.key)).toEqual([' ']);
    });

    test('defaults the view mode shortcut to Ctrl + M', () => {
        const defaults = createDefaultKeyboardShortcuts();
        expect(matchesAnyKeyboardShortcut({ key: 'M', ctrlKey: true }, defaults.cycleViewMode)).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: 'm' }, defaults.cycleViewMode)).toBe(false);
        expect(normalizeKeyboardShortcuts({ sendMessage: [{ key: 'Enter' }] }).cycleViewMode)
            .toEqual(defaults.cycleViewMode);
    });

    test('ignores modifier-only capture events', () => {
        expect(keyboardShortcutFromEvent({ key: 'Control', ctrlKey: true })).toBeNull();
    });

    test('defaults the conversation and navigation shortcuts', () => {
        const defaults = createDefaultKeyboardShortcuts();
        expect(matchesAnyKeyboardShortcut({ key: 'Escape' }, defaults.stopGeneration)).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: 'R', altKey: true }, defaults.regenerateReply)).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: 'ArrowUp' }, defaults.editLastMessage)).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: 'ArrowUp', altKey: true }, defaults.editLastMessage)).toBe(false);
        expect(matchesAnyKeyboardShortcut({ key: 'ArrowUp', altKey: true }, defaults.previousChat)).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: 'ArrowDown', altKey: true }, defaults.nextChat)).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: '2', altKey: true }, defaults.selectReplySuggestion2)).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: 'n', altKey: true }, defaults.newChat)).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: 'k', ctrlKey: true }, defaults.openSearch)).toBe(true);
        expect(matchesAnyKeyboardShortcut({ key: 'b', ctrlKey: true }, defaults.toggleSidebar)).toBe(true);
    });

    test('fills shortcuts added after the settings were saved with their defaults', () => {
        const normalized = normalizeKeyboardShortcuts({ cycleViewMode: [{ key: 'v', ctrl: true }] });
        expect(normalized.cycleViewMode.map((shortcut) => shortcut.key)).toEqual(['v']);
        expect(normalized.regenerateReply).toEqual(createDefaultKeyboardShortcuts().regenerateReply);
    });

    test('treats Ctrl, Alt and Win as command modifiers but not Shift', () => {
        expect(hasCommandModifier({ key: 'a', ctrlKey: true })).toBe(true);
        expect(hasCommandModifier({ key: 'a', altKey: true })).toBe(true);
        expect(hasCommandModifier({ key: 'a', metaKey: true })).toBe(true);
        expect(hasCommandModifier({ key: 'A', shiftKey: true })).toBe(false);
    });
});
