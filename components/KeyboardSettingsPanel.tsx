import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import {
    DEFAULT_KEYBOARD_SHORTCUTS,
    getKeyboardShortcutLabels,
    keyboardShortcutListEquals,
    useStore,
    type KeyboardShortcut,
    type KeyboardShortcutAction,
} from '../lib/store';
import { keyboardShortcutFromEvent } from '../lib/keyboardShortcuts';

const SHORTCUT_ROWS: readonly {
    action: KeyboardShortcutAction;
    label: string;
    description: string;
}[] = [
    {
        action: 'sendMessage',
        label: 'メッセージを送信',
        description: 'チャット画面で入力されたメッセージを送信します。',
    },
    {
        action: 'advanceTypewriter',
        label: '文字送りをスキップ',
        description: 'ゲームモードでの文字送りをスキップします。',
    },
    {
        action: 'closeDialog',
        label: 'ダイアログを閉じる',
        description: '最前面のダイアログや設定画面を閉じます。',
    },
    {
        action: 'openShortcutHelp',
        label: 'ショートカットを表示',
        description: 'このショートカット設定を開きます。',
    },
];

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
                    <p>変更する項目を選び、新しいキーの組み合わせを入力してください。</p>
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
                    <RotateCcw size={15} />
                    すべて初期設定に戻す
                </button>
            </div>

            <div className="keyboard-shortcut-list">
                {SHORTCUT_ROWS.map(({ action, label, description }) => {
                    const isCapturing = capturingAction === action;
                    return (
                        <div className={`keyboard-shortcut-row ${isCapturing ? 'is-capturing' : ''}`} key={action}>
                            <div className="keyboard-shortcut-copy">
                                <span className="keyboard-shortcut-label">{label}</span>
                                <span className="keyboard-shortcut-description">{description}</span>
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

            <p className={`keyboard-shortcut-hint ${captureError ? 'is-error' : ''}`} aria-live="polite">
                {captureError ?? 'OSやブラウザが使用するキーの組み合わせは動作しないことがあります。'}
            </p>
        </section>
    );
}
