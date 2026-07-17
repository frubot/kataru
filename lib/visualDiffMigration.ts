import type { Character, Costume } from './store';

const DEFAULT_COSTUME_NAME = 'default';
const NEUTRAL_EXPRESSION_NAME = 'neutral';

const matchesReservedName = (value: string | undefined, reservedName: string) =>
    value?.trim().toLowerCase() === reservedName;

export function normalizeCharacterCostumeDiffs(character: Character): Character {
    const neutral = (character.expressions ?? []).find((expression) =>
        matchesReservedName(expression.name, NEUTRAL_EXPRESSION_NAME)
    );
    if (!neutral?.image) return character;

    const costumes = character.costumes ?? [];
    const hasDefaultCostume = costumes.some((costume) =>
        matchesReservedName(costume.name, DEFAULT_COSTUME_NAME)
    );
    if (hasDefaultCostume) return character;

    const defaultCostume: Costume = {
        name: DEFAULT_COSTUME_NAME,
        image: neutral.image,
    };

    return {
        ...character,
        costumes: [defaultCostume, ...costumes],
    };
}

export function normalizeCharactersForCostumeDiffs(characters: Character[]): Character[] {
    let changed = false;
    const normalized = characters.map((character) => {
        const next = normalizeCharacterCostumeDiffs(character);
        if (next !== character) changed = true;
        return next;
    });
    return changed ? normalized : characters;
}
