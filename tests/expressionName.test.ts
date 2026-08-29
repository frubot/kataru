import { describe, expect, test } from 'vitest';
import {
    createExpressionNameRegistry,
    reserveUniqueExpressionName,
} from '../lib/expressionName';

describe('expression name reservation', () => {
    test('avoids existing names and names reserved earlier in the same batch', () => {
        const reservedNames = createExpressionNameRegistry(['neutral', 'happy']);

        expect(reserveUniqueExpressionName('happy', reservedNames)).toBe('happy_2');
        expect(reserveUniqueExpressionName('happy', reservedNames)).toBe('happy_3');
    });

    test('keeps suffixed names within the expression name length limit', () => {
        const detectedName = `expression_${'a'.repeat(53)}`;
        const reservedNames = createExpressionNameRegistry([detectedName]);
        const uniqueName = reserveUniqueExpressionName(detectedName, reservedNames);

        expect(uniqueName).toHaveLength(64);
        expect(uniqueName.endsWith('_2')).toBe(true);
    });
});
