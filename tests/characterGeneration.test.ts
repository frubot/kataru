import { describe, expect, test } from 'vitest';

import {
    formatGeneratedCharacterPrompt,
    formatGeneratedProtagonistPrompt,
    formatGeneratedSpeechStyle,
    normalizeGeneratedCharacterProfile,
} from '../lib/characterGeneration';

const generatedProfile = {
    name: 'ミナ',
    gender: '女性',
    firstPerson: '私',
    protagonistAddress: '先輩',
    relationship: '同じ部活の後輩',
    protagonistImpression: '頼りになるが、少し無理をしすぎる人',
    occupation: '高校生・天文部員',
    speechExamples: [
        '「先輩、今夜は流星群が見られるんですよ！」',
        '「もう、また無理してるじゃないですか」',
        '「ほら、こっちです。早く早く！」',
    ],
    personality: '好奇心旺盛で世話焼き',
    traits: '星座に詳しく、考え事をすると髪を指で巻く',
};

describe('character generation profile', () => {
    test('normalizes the explicit profile fields without a details field', () => {
        expect(normalizeGeneratedCharacterProfile(generatedProfile)).toEqual(generatedProfile);
    });

    test('requires exactly three speech examples', () => {
        expect(normalizeGeneratedCharacterProfile({
            ...generatedProfile,
            speechExamples: generatedProfile.speechExamples.slice(0, 2),
        })).toBeNull();
    });

    test('rejects a profile that only has the removed details field', () => {
        expect(normalizeGeneratedCharacterProfile({
            ...generatedProfile,
            traits: undefined,
            details: '特徴: 星座に詳しい',
        })).toBeNull();
    });

    test('separates character and protagonist prompt sections', () => {
        const characterPrompt = formatGeneratedCharacterPrompt(generatedProfile);
        const speechStyle = formatGeneratedSpeechStyle(generatedProfile);
        const protagonistPrompt = formatGeneratedProtagonistPrompt(generatedProfile);

        expect(characterPrompt).toContain('## 職業\n高校生・天文部員');
        expect(characterPrompt).toContain('## 性格\n好奇心旺盛で世話焼き');
        expect(characterPrompt).toContain('## 特徴\n星座に詳しく');
        expect(characterPrompt).not.toContain('口調');
        expect(characterPrompt).not.toContain('## 詳細');
        expect(speechStyle).toBe([
            '- 「先輩、今夜は流星群が見られるんですよ！」',
            '- 「もう、また無理してるじゃないですか」',
            '- 「ほら、こっちです。早く早く！」',
        ].join('\n'));
        expect(protagonistPrompt).toContain('## 主人公に対する印象\n頼りになるが');
        expect(characterPrompt).not.toContain('主人公に対する印象');
    });
});
