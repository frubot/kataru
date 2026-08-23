export function buildSituationBackgroundPrompt(description: string): string {
    return [
        'Create a wide 16:9 background image for a visual novel scene.',
        'Show the environment edge-to-edge as a finished scene background.',
        'Do not include people, characters, text, logos, speech bubbles, borders, or UI elements.',
        '',
        'Scene description:',
        description.trim(),
    ].join('\n');
}
