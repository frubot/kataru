import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
    DEFAULT_KEYBOARD_SHORTCUTS,
    getKeyboardShortcutLabels,
    keyboardShortcutListEquals,
    useStore,
    type KeyboardShortcut,
    type KeyboardShortcutAction,
} from '../lib/store';
import { keyboardShortcutFromEvent } from '../lib/keyboardShortcuts';

type ShortcutRow = {
    action: KeyboardShortcutAction;
    label: string;
};

const SHORTCUT_GROUPS: readonly {
    title: string;
    rows: readonly ShortcutRow[];
}[] = [
    {
        title: '会話',
        rows: [
            { action: 'sendMessage', label: 'メッセージを送信' },
            { action: 'stopGeneration', label: '生成を中断' },
            { action: 'regenerateReply', label: '回答を再生成' },
            { action: 'editLastMessage', label: '直前の入力を編集' },
            { action: 'selectReplySuggestion1', label: '返答候補1を送信' },
            { action: 'selectReplySuggestion2', label: '返答候補2を送信' },
            { action: 'selectReplySuggestion3', label: '返答候補3を送信' },
            { action: 'advanceTypewriter', label: '文字送りをスキップ' },
        ],
    },
    {
        title: '移動',
        rows: [
            { action: 'newChat', label: '新しいチャット' },
            { action: 'previousChat', label: '前のチャット' },
            { action: 'nextChat', label: '次のチャット' },
            { action: 'openSearch', label: '検索' },
            { action: 'toggleSidebar', label: 'サイドバーを開閉' },
            { action: 'cycleViewMode', label: 'モードを切り替え' },
        ],
    },
    {
        title: 'そのほか',
        rows: [
            { action: 'closeDialog', label: 'ダイアログを閉じる' },
            { action: 'openShortcutHelp', label: 'ショートカットを表示' },
        ],
    },
];

const SHORTCUT_ROWS = SHORTCUT_GROUPS.flatMap((group) => group.rows);

function ShortcutKeys({
    shortcuts,
    label,
    isCapturing,
    onClick,
    onKeyDown,
}: {
    shortcuts: readonly KeyboardShortcut[];
    label: string;
    isCapturing: boolean;
    onClick: () => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
    return (
        <span className="keyboard-shortcut-values">
            {shortcuts.map((shortcut, shortcutIndex) => (
                <span className="keyboard-shortcut-value" key={JSON.stringify(shortcut)}>
                    {shortcutIndex > 0 && (
                        <span className="keyboard-shortcut-or" aria-hidden="true">または</span>
                    )}
                    <button
                        type="button"
                        className={`keyboard-shortcut-key ${isCapturing ? 'is-capturing' : ''}`}
                        aria-label={`${label}（${getKeyboardShortcutLabels(shortcut).join(' + ')}）を変更`}
                        onClick={onClick}
                        onKeyDown={onKeyDown}
                    >
                        {getKeyboardShortcutLabels(shortcut).map((label, labelIndex) => (
                            <span key={`${label}-${labelIndex}`}>
                                {labelIndex > 0 && <span className="keyboard-shortcut-plus" aria-hidden="true">+</span>}
                                <kbd>{label}</kbd>
                            </span>
                        ))}
                    </button>
                </span>
            ))}
        </span>
    );
}

export default function KeyboardSettingsPanel() {
    const {
        keyboardShortcuts,
        setKeyboardShortcut,
        resetKeyboardShortcuts,
    } = useStore();
    const [capturingAction, setCapturingAction] = useState<KeyboardShortcutAction | null>(null);
    const [captureError, setCaptureError] = useState<string | null>(null);
    const allDefaults = SHORTCUT_ROWS.every(({ action }) => (
        keyboardShortcutListEquals(keyboardShortcuts[action], DEFAULT_KEYBOARD_SHORTCUTS[action])
    ));

    const beginCapture = (action: KeyboardShortcutAction) => {
        setCapturingAction(action);
        setCaptureError(null);
    };

    const handleCapture = (
        event: ReactKeyboardEvent<HTMLButtonElement>,
        action: KeyboardShortcutAction,
    ) => {
        if (capturingAction !== action || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        const shortcut = keyboardShortcutFromEvent(event);
        if (!shortcut) {
            setCaptureError('修飾キーと組み合わせるキーを入力してください。');
            return;
        }
        setKeyboardShortcut(action, shortcut);
        setCapturingAction(null);
        setCaptureError(null);
    };

    return (
        <section className="keyboard-settings-panel" aria-labelledby="keyboard-settings-heading">
            <div className="keyboard-settings-heading-row">
                <div>
                    <h3 id="keyboard-settings-heading">キーボードショートカット</h3>
                </div>
                <button
                    type="button"
                    className="btn btn-secondary keyboard-shortcuts-reset-all"
                    onClick={() => {
                        resetKeyboardShortcuts();
                        setCapturingAction(null);
                        setCaptureError(null);
                    }}
                    disabled={allDefaults}
                >
                    すべて初期設定に戻す
                </button>
            </div>

            {SHORTCUT_GROUPS.map((group) => (
                <div className="keyboard-shortcut-group" key={group.title}>
                    <h4 className="keyboard-shortcut-group-title">{group.title}</h4>
                    <div className="keyboard-shortcut-list">
                        {group.rows.map(({ action, label }) => {
                            const isCapturing = capturingAction === action;
                            return (
                                <div className={`keyboard-shortcut-row ${isCapturing ? 'is-capturing' : ''}`} key={action}>
                                    <div className="keyboard-shortcut-copy">
                                        <span className="keyboard-shortcut-label">{label}</span>
                                    </div>
                                    <ShortcutKeys
                                        shortcuts={keyboardShortcuts[action]}
                                        label={label}
                                        isCapturing={isCapturing}
                                        onClick={() => beginCapture(action)}
                                        onKeyDown={(event) => handleCapture(event, action)}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}

            <p className={`keyboard-shortcut-hint ${captureError ? 'is-error' : ''}`} aria-live="polite">
                {captureError}
            </p>
        </section>
    );
}
