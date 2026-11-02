/**
 * シチュエーションで場面全体のナレーションを担当する仮の話者のid。
 * サーバー（src/conversation/prompts.rs の NARRATOR_ID）と同じ値で、
 * ナレーションのメッセージは `characterId` にこのidを持つ。
 */
export const NARRATOR_CHARACTER_ID = 'narrator';

export function isNarratorCharacterId(characterId: string | undefined | null): boolean {
    return characterId === NARRATOR_CHARACTER_ID;
}

export function isNarrationMessage(message: { role: string; characterId?: string }): boolean {
    return message.role === 'assistant' && isNarratorCharacterId(message.characterId);
}

/** ゲームモードの台詞枠で、ナレーションの話者名として出す表示名。 */
export const NARRATOR_DISPLAY_NAME = 'ナレーション';

/**
 * ゲームモードの台詞枠に出すナレーション本文。キャラクターの台詞と区別できるよう
 * 全体を（）で囲む。空文字や、すでに括弧で囲まれている本文はそのまま返す。
 */
export function wrapNarrationForDialogue(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) return content;
    if (/^[（(][\s\S]*[）)]$/.test(trimmed)) return trimmed;
    return `（${trimmed}）`;
}
