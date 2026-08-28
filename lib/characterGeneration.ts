export interface GeneratedCharacterProfile {
    name: string;
    gender: string;
    firstPerson: string;
    protagonistAddress: string;
    relationship: string;
    protagonistImpression: string;
    occupation: string;
    speechExamples: string[];
    personality: string;
    traits: string;
}

export interface GeneratedCharacterDraft {
    name: string;
    systemPrompt: string;
    speechStyle: string;
    protagonistPrompt: string;
}

type GeneratedCharacterTextField = Exclude<keyof GeneratedCharacterProfile, 'speechExamples'>;

const CHARACTER_FIELD_LABELS: Array<[GeneratedCharacterTextField, string]> = [
    ['name', '名前'],
    ['gender', '性別'],
    ['occupation', '職業'],
    ['firstPerson', '一人称'],
    ['personality', '性格'],
    ['traits', '特徴'],
];

const PROTAGONIST_FIELD_LABELS: Array<[GeneratedCharacterTextField, string]> = [
    ['protagonistAddress', '主人公への呼び方'],
    ['relationship', '主人公から見た関係性'],
    ['protagonistImpression', '主人公に対する印象'],
];

const pickString = (source: Record<string, unknown>, keys: string[]): string => {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (Array.isArray(value)) {
            const joined = value
                .map((item) => (typeof item === 'string' ? item.trim() : ''))
                .filter(Boolean)
                .join('\n');
            if (joined) return joined;
        }
    }
    return '';
};

const pickSpeechExamples = (source: Record<string, unknown>): string[] => {
    const value = source.speechExamples;
    if (!Array.isArray(value) || value.length !== 3) return [];
    const examples = value.map((item) => (typeof item === 'string' ? item.trim() : ''));
    return examples.every(Boolean) ? examples : [];
};

export function normalizeGeneratedCharacterProfile(value: unknown): GeneratedCharacterProfile | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const profile: GeneratedCharacterProfile = {
        name: pickString(source, ['name', '名前']),
        gender: pickString(source, ['gender', '性別']),
        firstPerson: pickString(source, ['firstPerson', 'first_person', '一人称']),
        protagonistAddress: pickString(source, ['protagonistAddress', 'protagonist_address', '主人公への呼び方', '主人公の呼び方']),
        relationship: pickString(source, ['relationship', '主人公から見た関係性', '関係性']),
        protagonistImpression: pickString(source, ['protagonistImpression', 'protagonist_impression', '主人公に対する印象', '主人公への印象']),
        occupation: pickString(source, ['occupation', 'job', '職業']),
        speechExamples: pickSpeechExamples(source),
        personality: pickString(source, ['personality', '性格']),
        traits: pickString(source, ['traits', 'features', '特徴']),
    };

    if (!profile.name) return null;
    if (
        !profile.gender
        || !profile.firstPerson
        || !profile.protagonistAddress
        || !profile.relationship
        || !profile.protagonistImpression
        || !profile.occupation
        || profile.speechExamples.length !== 3
        || !profile.personality
        || !profile.traits
    ) {
        return null;
    }
    return profile;
}

export function formatGeneratedCharacterPrompt(profile: GeneratedCharacterProfile): string {
    return CHARACTER_FIELD_LABELS
        .map(([key, label]) => `## ${label}\n${profile[key].trim()}`)
        .join('\n\n');
}

export function formatGeneratedProtagonistPrompt(profile: GeneratedCharacterProfile): string {
    return PROTAGONIST_FIELD_LABELS
        .map(([key, label]) => `## ${label}\n${profile[key].trim()}`)
        .join('\n\n');
}

export function formatGeneratedSpeechStyle(profile: GeneratedCharacterProfile): string {
    return profile.speechExamples.map((example) => `- ${example.trim()}`).join('\n');
}
