import { describe, expect, test } from 'vitest';
import { buildSituationBackgroundPrompt } from '../lib/situationBackgroundGeneration';

describe('buildSituationBackgroundPrompt', () => {
    test('requests a character-free wide visual novel background', () => {
        const prompt = buildSituationBackgroundPrompt('放課後の教室');

        expect(prompt).toContain('16:9');
        expect(prompt).toContain('Do not include people, characters');
        expect(prompt).toContain('放課後の教室');
    });
});
