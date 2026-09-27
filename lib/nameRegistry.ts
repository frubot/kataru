const MAX_NAME_LENGTH = 64;

export function createNameRegistry(names: Iterable<string>): Set<string> {
    return new Set(Array.from(names, (name) => name.toLowerCase()));
}

export function reserveUniqueName(
    detectedName: string,
    reservedNames: Set<string>,
    errorLabel: string,
): string {
    const baseName = detectedName
        .slice(0, MAX_NAME_LENGTH)
        .replace(/_+$/, '');
    let candidate = baseName;
    let suffixNumber = 2;

    while (reservedNames.has(candidate.toLowerCase())) {
        if (suffixNumber >= 1000) {
            throw new Error(`重複しない${errorLabel}を作成できませんでした。`);
        }
        const suffix = `_${suffixNumber}`;
        const suffixedBase = baseName
            .slice(0, MAX_NAME_LENGTH - suffix.length)
            .replace(/_+$/, '');
        candidate = `${suffixedBase}${suffix}`;
        suffixNumber += 1;
    }

    reservedNames.add(candidate.toLowerCase());
    return candidate;
}
