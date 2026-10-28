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
