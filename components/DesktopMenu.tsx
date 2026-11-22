import { Check } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
    type DesktopMenuName,
    type DesktopShortcut,
    notifyDesktopMenuClosed,
    sendDesktopShortcut,
    subscribeDesktopEvents,
} from '../lib/desktopApp';
import { getKeyboardShortcutLabels } from '../lib/keyboardShortcuts';
import { useStore } from '../lib/store';

const REPOSITORY_URL = 'https://github.com/frubot/kataru';
const MENU_WIDTH = 232;
const VIEWPORT_MARGIN = 8;

type MenuItem =
    | { type: 'separator' }
    | {
        type: 'item';
        label: string;
        shortcut?: string;
        checked?: boolean;
        onSelect: () => void;
    };

type OpenMenu = { menu: DesktopMenuName; left: number };

interface DesktopMenuProps {
    sidebarVisible: () => boolean;
    onToggleSidebar: () => void;
    onOpenSettings: () => void;
    onShowOnboarding: () => void;
}

const separator: MenuItem = { type: 'separator' };

function shortcutItem(label: string, shortcut: string, action: DesktopShortcut): MenuItem {
    return { type: 'item', label, shortcut, onSelect: () => sendDesktopShortcut(action) };
}

/** デスクトップ版のタイトルバーから開くメニュー。タイトルバーのすぐ下に表示する。 */
export default function DesktopMenu({
    sidebarVisible,
    onToggleSidebar,
    onOpenSettings,
    onShowOnboarding,
}: DesktopMenuProps) {
    const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
    const toggleSidebarShortcut = useStore((state) => state.keyboardShortcuts.toggleSidebar[0]);
    const menuRef = useRef<HTMLDivElement>(null);
    const isOpenRef = useRef(false);

    const close = useCallback(() => {
        if (!isOpenRef.current) return;
        isOpenRef.current = false;
        setOpenMenu(null);
        notifyDesktopMenuClosed();
    }, []);

    useEffect(() => subscribeDesktopEvents((event) => {
        if (event.type === 'open-menu') {
            isOpenRef.current = true;
            // タイトルバーとアプリ画面は拡大率が異なることがあるため、物理ピクセルから換算する。
            setOpenMenu({ menu: event.menu, left: event.left / window.devicePixelRatio });
        } else if (event.type === 'close-menu') {
            close();
        }
    }), [close]);

    useEffect(() => {
        if (!openMenu) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) close();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            // メニューを閉じるだけにして、生成の中断などほかのショートカットに渡さない。
            event.preventDefault();
            close();
        };
        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [close, openMenu]);

    if (!openMenu) return null;

    const menus: Record<DesktopMenuName, { label: string; items: MenuItem[] }> = {
        edit: {
            label: '編集',
            items: [
                shortcutItem('元に戻す', 'Ctrl+Z', 'undo'),
                shortcutItem('やり直し', 'Ctrl+Y', 'redo'),
                separator,
                shortcutItem('切り取り', 'Ctrl+X', 'cut'),
                shortcutItem('コピー', 'Ctrl+C', 'copy'),
                shortcutItem('貼り付け', 'Ctrl+V', 'paste'),
                separator,
                shortcutItem('すべて選択', 'Ctrl+A', 'select-all'),
                separator,
                { type: 'item', label: '設定', onSelect: onOpenSettings },
            ],
        },
        view: {
            label: '表示',
            items: [
                {
                    type: 'item',
                    label: 'サイドバー',
                    shortcut: toggleSidebarShortcut
                        ? getKeyboardShortcutLabels(toggleSidebarShortcut).join('+')
                        : undefined,
                    checked: sidebarVisible(),
                    onSelect: onToggleSidebar,
                },
                separator,
                shortcutItem('拡大', 'Ctrl++', 'zoom-in'),
                shortcutItem('縮小', 'Ctrl+-', 'zoom-out'),
                shortcutItem('実際のサイズ', 'Ctrl+0', 'zoom-reset'),
            ],
        },
        help: {
            label: 'ヘルプ',
            items: [
                { type: 'item', label: 'はじめかたを表示', onSelect: onShowOnboarding },
                {
                    type: 'item',
                    label: 'GitHubを開く',
                    onSelect: () => window.open(REPOSITORY_URL, '_blank', 'noopener,noreferrer'),
                },
            ],
        },
    };
    const { label, items } = menus[openMenu.menu];
    const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(openMenu.left, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
    );

    return (
        <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            className="desktop-menu"
            style={{ left, width: MENU_WIDTH }}
            onContextMenu={(event) => event.preventDefault()}
        >
            {items.map((item, index) => (
                <Fragment key={index}>
                    {item.type === 'separator' ? (
                        <div className="desktop-menu-separator" role="separator" />
                    ) : (
                        <button
                            type="button"
                            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                            aria-checked={item.checked}
                            className="desktop-menu-item"
                            // 編集操作の対象（入力欄など）からフォーカスを奪わないようにする。
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                                close();
                                item.onSelect();
                            }}
                        >
                            <span className="desktop-menu-check" aria-hidden="true">
                                {item.checked && <Check size={14} />}
                            </span>
                            <span className="desktop-menu-label">{item.label}</span>
                            {item.shortcut && <span className="desktop-menu-shortcut">{item.shortcut}</span>}
                        </button>
                    )}
                </Fragment>
            ))}
        </div>
    );
}
