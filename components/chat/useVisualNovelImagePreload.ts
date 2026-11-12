import { useEffect, useMemo } from 'react';
import type { Character } from '@/lib/store';
import { preloadVisualNovelImages } from '@/lib/visualNovelImagePreload';
import { getVisualNovelPreloadCandidates } from '@/lib/visualNovelPresentation';

export function useVisualNovelImagePreload({
    character,
    costumeId,
    currentImage,
    backgroundImage,
}: {
    character: Character | null;
    costumeId: string | null;
    currentImage: string | null;
    backgroundImage?: string;
}) {
    const candidates = useMemo(
        () => getVisualNovelPreloadCandidates(character, costumeId, currentImage),
        [character, costumeId, currentImage],
    );

    useEffect(() => {
        return preloadVisualNovelImages(candidates, [currentImage, backgroundImage]);
    }, [candidates, currentImage, backgroundImage]);
}
