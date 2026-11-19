import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { type DesktopShortcut, sendDesktopShortcut } from '../lib/desktopApp';

const MENU_WIDTH = 200;
const ITEM_HEIGHT = 32;
const SEPARATOR_HEIGHT = 9;
const MENU_PADDING = 10;
const VIEWPORT_MARGIN = 8;

type MenuItem =
    | { type: 'separator' }
    | { type: 'item'; label: string; shortcut: string; action: DesktopShortcut; disabled: boolean };

type OpenMenu = { x: number; y: number; items: MenuItem[] };

const separator: MenuItem = { type: 'separator' };

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

/** テキストを編集できる入力欄であれば、その要素を返す。 */
function findEditable(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const element = target.closest<HTMLElement>(EDITABLE_SELECTOR);
    if (!element) return null;
    if (element instanceof HTMLInputElement) {
        // チェックボックスやボタンなど、文字を扱わない種類は対象外にする。
        const textTypes = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
        if (!textTypes.includes(element.type)) return null;
    }
    return element;
}

function hasTextSelection(element: HTMLElement | null): boolean {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        try {
            return element.selectionStart !== null && element.selectionStart !== element.selectionEnd;
        } catch {
            return false;
        }
    }
    const selection = window.getSelection();
    return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}

function isWritable(element: HTMLElement): boolean {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return !element.readOnly && !element.disabled;
    }
    return element.isContentEditable;
}

function buildItems(editable: HTMLElement | null): MenuItem[] | null {
    const selected = hasTextSelection(editable);
    if (!editable) {
        // 入力欄以外では、文字を選んでいるときだけコピーできるようにする。
        return selected
            ? [{ type: 'item', label: 'コピー', shortcut: 'Ctrl+C', action: 'copy', disabled: false }]
            : null;
    }
    const writable = isWritable(editable);
    return [
        { type: 'item', label: '元に戻す', shortcut: 'Ctrl+Z', action: 'undo', disabled: !writable },
        { type: 'item', label: 'やり直し', shortcut: 'Ctrl+Y', action: 'redo', disabled: !writable },
        separator,
        { type: 'item', label: '切り取り', shortcut: 'Ctrl+X', action: 'cut', disabled: !writable || !selected },
        { type: 'item', label: 'コピー', shortcut: 'Ctrl+C', action: 'copy', disabled: !selected },
        { type: 'item', label: '貼り付け', shortcut: 'Ctrl+V', action: 'paste', disabled: !writable },
        separator,
        { type: 'item', label: 'すべて選択', shortcut: 'Ctrl+A', action: 'select-all', disabled: false },
    ];
}

function clamp(value: number, size: number, viewportSize: number): number {
    const max = Math.max(VIEWPORT_MARGIN, viewportSize - size - VIEWPORT_MARGIN);
    return Math.min(Math.max(value, VIEWPORT_MARGIN), max);
}

/** デスクトップ版で、入力欄や選択した文字を右クリックしたときに開く編集メニュー。 */
export default function DesktopTextContextMenu() {
    const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const close = useCallback(() => setOpenMenu(null), []);

    useEffect(() => {
        const handleContextMenu = (event: MouseEvent) => {
            // 画面側で独自のメニューを開いた場合はそちらを優先する。
            if (event.defaultPrevented) return;
            if (menuRef.current?.contains(event.target as Node)) {
                event.preventDefault();
                return;
            }
            const items = buildItems(findEditable(event.target));
            if (!items) {
                setOpenMenu(null);
                return;
            }
            event.preventDefault();
            const height = items.reduce(
                (total, item) => total + (item.type === 'separator' ? SEPARATOR_HEIGHT : ITEM_HEIGHT),
                MENU_PADDING,
            );
            setOpenMenu({
                x: clamp(event.clientX, MENU_WIDTH, window.innerWidth),
                y: clamp(event.clientY, height, window.innerHeight),
                items,
            });
        };
        document.addEventListener('contextmenu', handleContextMenu);
        return () => document.removeEventListener('contextmenu', handleContextMenu);
    }, []);

    useEffect(() => {
        if (!openMenu) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) close();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close();
        };
        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
            window.removeEventListener('blur', close);
        };
    }, [close, openMenu]);

    if (!openMenu) return null;

    return (
        <div
            ref={menuRef}
            role="menu"
            aria-label="編集"
            className="desktop-menu desktop-text-menu"
            style={{ left: openMenu.x, top: openMenu.y, width: MENU_WIDTH }}
        >
            {openMenu.items.map((item, index) => (
                <Fragment key={index}>
                    {item.type === 'separator' ? (
                        <div className="desktop-menu-separator" role="separator" />
                    ) : (
                        <button
                            type="button"
                            role="menuitem"
                            className="desktop-menu-item"
                            disabled={item.disabled}
                            // 編集操作の対象（入力欄など）からフォーカスを奪わないようにする。
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                                close();
                                sendDesktopShortcut(item.action);
                            }}
                        >
                            <span className="desktop-menu-label">{item.label}</span>
                            <span className="desktop-menu-shortcut">{item.shortcut}</span>
                        </button>
                    )}
                </Fragment>
            ))}
        </div>
    );
}
