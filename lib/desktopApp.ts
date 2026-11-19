// デスクトップ版（kataru-desktop）のタイトルバーとやり取りする。

export type DesktopMenuName = 'edit' | 'view' | 'help';

export type DesktopShortcut =
    | 'undo'
    | 'redo'
    | 'cut'
    | 'copy'
    | 'paste'
    | 'select-all'
    | 'zoom-in'
    | 'zoom-out'
    | 'zoom-reset';

export type DesktopEvent =
    | { type: 'toggle-sidebar' }
    /** `left` はタイトルバー上の位置（物理ピクセル）。 */
    | { type: 'open-menu'; menu: DesktopMenuName; left: number }
    | { type: 'close-menu' };

type DesktopWindow = Window & {
    kataruDesktop?: boolean;
    ipc?: { postMessage: (message: string) => void };
};

const DESKTOP_EVENT = 'kataru-desktop';

export function isDesktopApp(): boolean {
    return typeof window !== 'undefined' && (window as DesktopWindow).kataruDesktop === true;
}

function postDesktopMessage(message: string): void {
    (window as DesktopWindow).ipc?.postMessage(message);
}

export function sendDesktopShortcut(shortcut: DesktopShortcut): void {
    postDesktopMessage(`shortcut:${shortcut}`);
}

export function notifyDesktopMenuClosed(): void {
    postDesktopMessage('menu-closed');
}

export function subscribeDesktopEvents(handler: (event: DesktopEvent) => void): () => void {
    const listener = (event: Event) => handler((event as CustomEvent<DesktopEvent>).detail);
    window.addEventListener(DESKTOP_EVENT, listener);
    return () => window.removeEventListener(DESKTOP_EVENT, listener);
}
