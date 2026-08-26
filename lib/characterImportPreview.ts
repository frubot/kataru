import type { Character } from './store/types';

const DEFAULT_COSTUME_NAME = 'default';
const NEUTRAL_EXPRESSION_NAME = 'neutral';

export function resolveCharacterImportPreviewImage(character: Character): string | null {
    const defaultCostume = (character.costumes ?? []).find(
        (costume) => costume.name.trim().toLowerCase() === DEFAULT_COSTUME_NAME,
    );
    const defaultNeutral = (defaultCostume?.expressions ?? []).find(
        (expression) => expression.name.trim().toLowerCase() === NEUTRAL_EXPRESSION_NAME,
    );
    const neutral = (character.expressions ?? []).find(
        (expression) => expression.name.trim().toLowerCase() === NEUTRAL_EXPRESSION_NAME,
    );

    return defaultNeutral?.image
        ?? defaultCostume?.image
        ?? neutral?.image
        ?? character.icon
        ?? null;
}
