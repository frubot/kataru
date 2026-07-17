export interface GeneratedCharacterProfile {
    name: string;
    gender: string;
    firstPerson: string;
    protagonistAddress: string;
    relationship: string;
    details: string;
}

const CHARACTER_FIELD_LABELS: Array<[keyof GeneratedCharacterProfile, string]> = [
    ['name', '名前'],
    ['gender', '性別'],
    ['firstPerson', '一人称'],
    ['details', '詳細'],
];

const PROTAGONIST_FIELD_LABELS: Array<[keyof GeneratedCharacterProfile, string]> = [
    ['protagonistAddress', '主人公への呼び方'],
    ['relationship', '主人公から見た関係性'],
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

export function normalizeGeneratedCharacterProfile(value: unknown): GeneratedCharacterProfile | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const profile: GeneratedCharacterProfile = {
        name: pickString(source, ['name', '名前']),
        gender: pickString(source, ['gender', '性別']),
        firstPerson: pickString(source, ['firstPerson', 'first_person', '一人称']),
        protagonistAddress: pickString(source, ['protagonistAddress', 'protagonist_address', '主人公への呼び方', '主人公の呼び方']),
        relationship: pickString(source, ['relationship', '主人公から見た関係性', '関係性']),
        details: pickString(source, ['details', '詳細']),
    };

    if (!profile.name) return null;
    if (!profile.gender || !profile.firstPerson || !profile.protagonistAddress || !profile.relationship || !profile.details) {
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
