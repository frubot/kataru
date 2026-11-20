// デスクトップ表示でのサイドバー幅。meta に保存する。

export const SIDEBAR_WIDTH_META_KEY = 'sidebarWidth';
export const SIDEBAR_WIDTH_DEFAULT = 265;
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_KEYBOARD_STEP = 16;

export function clampSidebarWidth(value: number): number {
    if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
    return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value)));
}

export function parseSidebarWidth(value: unknown): number {
    return typeof value === 'number' ? clampSidebarWidth(value) : SIDEBAR_WIDTH_DEFAULT;
}
