export type KeyboardShortcutAction =
    | 'sendMessage'
    | 'advanceTypewriter'
    | 'closeDialog'
    | 'openShortcutHelp';

export type KeyboardShortcut = {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
};

export type KeyboardShortcutSettings = Record<KeyboardShortcutAction, KeyboardShortcut[]>;

type KeyboardEventLike = {
    key: string;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
};

const SHORTCUT_ACTIONS: KeyboardShortcutAction[] = [
    'sendMessage',
    'advanceTypewriter',
    'closeDialog',
    'openShortcutHelp',
];

const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift']);

function shortcut(
    key: string,
    modifiers: Partial<Omit<KeyboardShortcut, 'key'>> = {},
): KeyboardShortcut {
    return {
        key,
        ctrl: modifiers.ctrl === true,
        shift: modifiers.shift === true,
        alt: modifiers.alt === true,
        meta: modifiers.meta === true,
    };
}

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutSettings = {
    sendMessage: [shortcut('Enter')],
    advanceTypewriter: [shortcut('Enter'), shortcut(' ')],
    closeDialog: [shortcut('Escape')],
    openShortcutHelp: [shortcut('/', { ctrl: true })],
};

function cloneShortcut(value: KeyboardShortcut): KeyboardShortcut {
    return { ...value };
}

function normalizeKey(key: string): string {
    return key.length === 1 ? key.toLocaleLowerCase() : key;
}

function normalizeShortcut(value: unknown): KeyboardShortcut | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<KeyboardShortcut>;
    if (typeof candidate.key !== 'string' || candidate.key.length === 0) return null;
    if (MODIFIER_KEYS.has(candidate.key)) return null;
    return shortcut(normalizeKey(candidate.key), {
        ctrl: candidate.ctrl,
        shift: candidate.shift,
        alt: candidate.alt,
        meta: candidate.meta,
    });
}

function shortcutSignature(value: KeyboardShortcut): string {
    return [value.ctrl, value.shift, value.alt, value.meta, normalizeKey(value.key)].join(':');
}

export function createDefaultKeyboardShortcuts(): KeyboardShortcutSettings {
    return {
        sendMessage: DEFAULT_KEYBOARD_SHORTCUTS.sendMessage.map(cloneShortcut),
        advanceTypewriter: DEFAULT_KEYBOARD_SHORTCUTS.advanceTypewriter.map(cloneShortcut),
        closeDialog: DEFAULT_KEYBOARD_SHORTCUTS.closeDialog.map(cloneShortcut),
        openShortcutHelp: DEFAULT_KEYBOARD_SHORTCUTS.openShortcutHelp.map(cloneShortcut),
    };
}

export function normalizeKeyboardShortcuts(value: unknown): KeyboardShortcutSettings {
    const source = value && typeof value === 'object'
        ? value as Partial<Record<KeyboardShortcutAction, unknown>>
        : {};
    const normalized = createDefaultKeyboardShortcuts();

    for (const action of SHORTCUT_ACTIONS) {
        if (!Array.isArray(source[action])) continue;
        const seen = new Set<string>();
        const shortcuts = source[action]
            .map(normalizeShortcut)
            .filter((entry): entry is KeyboardShortcut => {
                if (!entry) return false;
                const signature = shortcutSignature(entry);
                if (seen.has(signature)) return false;
                seen.add(signature);
                return true;
            })
            .slice(0, 4);
        if (shortcuts.length > 0) normalized[action] = shortcuts;
    }

    return normalized;
}

export function keyboardShortcutFromEvent(event: KeyboardEventLike): KeyboardShortcut | null {
    if (!event.key || MODIFIER_KEYS.has(event.key)) return null;
    return shortcut(normalizeKey(event.key), {
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        meta: event.metaKey,
    });
}

export function matchesKeyboardShortcut(
    event: KeyboardEventLike,
    value: KeyboardShortcut,
): boolean {
    return normalizeKey(event.key) === normalizeKey(value.key)
        && Boolean(event.ctrlKey) === value.ctrl
        && Boolean(event.shiftKey) === value.shift
        && Boolean(event.altKey) === value.alt
        && Boolean(event.metaKey) === value.meta;
}

export function matchesAnyKeyboardShortcut(
    event: KeyboardEventLike,
    values: readonly KeyboardShortcut[],
): boolean {
    return values.some((value) => matchesKeyboardShortcut(event, value));
}

export function getKeyboardShortcutKeyLabel(key: string): string {
    const labels: Record<string, string> = {
        ' ': 'Space',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        ArrowUp: '↑',
        Enter: 'Enter',
        Escape: 'Esc',
        Tab: 'Tab',
    };
    return labels[key] ?? (key.length === 1 ? key.toLocaleUpperCase() : key);
}

export function getKeyboardShortcutLabels(value: KeyboardShortcut): string[] {
    return [
        value.ctrl ? 'Ctrl' : null,
        value.shift ? 'Shift' : null,
        value.alt ? 'Alt' : null,
        value.meta ? 'Win' : null,
        getKeyboardShortcutKeyLabel(value.key),
    ].filter((label): label is string => label != null);
}

export function keyboardShortcutListEquals(
    left: readonly KeyboardShortcut[],
    right: readonly KeyboardShortcut[],
): boolean {
    return left.length === right.length
        && left.every((value, index) => shortcutSignature(value) === shortcutSignature(right[index]));
}
