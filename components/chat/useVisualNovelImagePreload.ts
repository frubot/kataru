import { useEffect, useMemo } from 'react';
import type { Character } from '@/lib/store';
import { preloadVisualNovelImages } from '@/lib/visualNovelImagePreload';
import { getVisualNovelPreloadCandidates } from '@/lib/visualNovelPresentation';

export function useVisualNovelImagePreload({
    character,
    costumeName,
    currentImage,
    backgroundImage,
}: {
    character: Character | null;
    costumeName: string;
    currentImage: string | null;
    backgroundImage?: string;
}) {
    const candidates = useMemo(
        () => getVisualNovelPreloadCandidates(character, costumeName, currentImage),
        [character, costumeName, currentImage],
    );

    useEffect(() => {
        return preloadVisualNovelImages(candidates, [currentImage, backgroundImage]);
    }, [candidates, currentImage, backgroundImage]);
}
