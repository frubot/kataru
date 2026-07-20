const IMAGE_ASSET_PREFIX = 'asset:';

export function getImageAssetId(source: string): string | null {
    const assetId = source.startsWith(IMAGE_ASSET_PREFIX)
        ? source.slice(IMAGE_ASSET_PREFIX.length)
        : '';
    return /^[a-f0-9]{64}$/.test(assetId) ? assetId : null;
}

export function resolveStoredImageUrl(source: string): string {
    const assetId = getImageAssetId(source);
    return assetId ? `/api/assets/${assetId}` : source;
}

export function buildBaseImageRequest(source: string): {
    baseImage?: string;
    baseImageAssetId?: string;
} {
    const assetId = getImageAssetId(source);
    return assetId ? { baseImageAssetId: assetId } : { baseImage: source };
}
