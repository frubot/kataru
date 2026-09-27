import { createNameRegistry, reserveUniqueName } from './nameRegistry';

export function createExpressionNameRegistry(names: Iterable<string>): Set<string> {
    return createNameRegistry(names);
}

export function reserveUniqueExpressionName(
    detectedName: string,
    reservedNames: Set<string>,
): string {
    return reserveUniqueName(detectedName, reservedNames, '表情名');
}
