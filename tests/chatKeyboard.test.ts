import { describe, expect, test } from 'vitest';

import {
    shouldAdvanceTypewriter,
    shouldIgnoreDocumentChatShortcut,
    shouldRedirectChatInput,
} from '../components/chat/useChatKeyboard';

describe('chat keyboard shortcuts', () => {
    test('redirects plain text and Backspace to the chat input', () => {
        expect(shouldRedirectChatInput({ key: 'a', metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
        expect(shouldRedirectChatInput({ key: 'あ', metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
        expect(shouldRedirectChatInput({ key: 'Backspace', metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
    });

    test('does not redirect navigation or modified shortcuts', () => {
        expect(shouldRedirectChatInput({ key: '?', metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
        expect(shouldRedirectChatInput({ key: 'Enter', metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
        expect(shouldRedirectChatInput({ key: 'ArrowDown', metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
        expect(shouldRedirectChatInput({ key: 'a', metaKey: false, ctrlKey: true, altKey: false })).toBe(false);
        expect(shouldRedirectChatInput({ key: 'a', metaKey: true, ctrlKey: false, altKey: false })).toBe(false);
        expect(shouldRedirectChatInput({ key: 'a', metaKey: false, ctrlKey: false, altKey: true })).toBe(false);
    });

    test('advances typewriter only with Enter or Space', () => {
        expect(shouldAdvanceTypewriter({ key: 'Enter' })).toBe(true);
        expect(shouldAdvanceTypewriter({ key: ' ' })).toBe(true);
        expect(shouldAdvanceTypewriter({ key: 'Escape' })).toBe(false);
    });

    test('uses a customized typewriter shortcut with exact modifiers', () => {
        const shortcuts = [{ key: 'a', ctrl: true, shift: false, alt: false, meta: false }];
        expect(shouldAdvanceTypewriter({ key: 'a', ctrlKey: true }, shortcuts)).toBe(true);
        expect(shouldAdvanceTypewriter({ key: 'a' }, shortcuts)).toBe(false);
    });

    test('ignores document shortcuts after another handler or while a modal is open', () => {
        expect(shouldIgnoreDocumentChatShortcut({ defaultPrevented: true, modalOpen: false })).toBe(true);
        expect(shouldIgnoreDocumentChatShortcut({ defaultPrevented: false, modalOpen: true })).toBe(true);
        expect(shouldIgnoreDocumentChatShortcut({ defaultPrevented: false, modalOpen: false })).toBe(false);
    });
});
