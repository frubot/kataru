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
        description: '入力欄で送信します。送信に割り当てていないEnterは改行になります。',
    },
    {
        action: 'advanceTypewriter',
        label: 'ゲームモードの文字送り',
        description: '表示中のメッセージを最後まで表示します。',
    },
    {
        action: 'closeDialog',
        label: 'ダイアログを閉じる',
        description: '最前面のダイアログや設定画面を閉じます。',
    },
    {
        action: 'openShortcutHelp',
        label: 'ショートカットを表示',
        description: 'このショートカット設定をモーダルで開きます。',
    },
];

function ShortcutKeys({ shortcuts }: { shortcuts: readonly KeyboardShortcut[] }) {
    return (
        <span className="keyboard-shortcut-values">
            {shortcuts.map((shortcut, shortcutIndex) => (
                <span className="keyboard-shortcut-value" key={JSON.stringify(shortcut)}>
                    {shortcutIndex > 0 && (
                        <span className="keyboard-shortcut-or" aria-hidden="true">または</span>
                    )}
                    <span aria-label={getKeyboardShortcutLabels(shortcut).join(' + ')}>
                        {getKeyboardShortcutLabels(shortcut).map((label, labelIndex) => (
                            <span key={`${label}-${labelIndex}`}>
                                {labelIndex > 0 && <span className="keyboard-shortcut-plus" aria-hidden="true">+</span>}
                                <kbd>{label}</kbd>
                            </span>
                        ))}
                    </span>
                </span>
            ))}
        </span>
    );
}

export default function KeyboardSettingsPanel() {
    const {
        keyboardShortcuts,
        setKeyboardShortcut,
        resetKeyboardShortcut,
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
                    const isDefault = keyboardShortcutListEquals(
                        keyboardShortcuts[action],
                        DEFAULT_KEYBOARD_SHORTCUTS[action],
                    );
                    return (
                        <div className={`keyboard-shortcut-row ${isCapturing ? 'is-capturing' : ''}`} key={action}>
                            <div className="keyboard-shortcut-copy">
                                <span className="keyboard-shortcut-label">{label}</span>
                                <span className="keyboard-shortcut-description">{description}</span>
                            </div>
                            <ShortcutKeys shortcuts={keyboardShortcuts[action]} />
                            <div className="keyboard-shortcut-actions">
                                <button
                                    type="button"
                                    className={`btn ${isCapturing ? 'btn-primary' : 'btn-secondary'} keyboard-shortcut-capture`}
                                    aria-label={`${label}のキーを変更`}
                                    onClick={() => beginCapture(action)}
                                    onKeyDown={(event) => handleCapture(event, action)}
                                >
                                    {isCapturing ? 'キーを入力…' : '変更'}
                                </button>
                                {isCapturing ? (
                                    <button
                                        type="button"
                                        className="btn btn-ghost keyboard-shortcut-reset"
                                        onClick={() => {
                                            setCapturingAction(null);
                                            setCaptureError(null);
                                        }}
                                    >
                                        キャンセル
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="btn btn-ghost keyboard-shortcut-reset"
                                        onClick={() => resetKeyboardShortcut(action)}
                                        disabled={isDefault}
                                    >
                                        初期設定
                                    </button>
                                )}
                            </div>
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
