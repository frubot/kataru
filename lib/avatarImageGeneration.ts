import { loadImage } from './imageUtils';

export const AVATAR_CHROMA_KEY_HEX = '#00FF00';

const AVATAR_CHROMA_KEY = { red: 0, green: 255, blue: 0 } as const;
const HARD_KEY_TOLERANCE = 84;
const SOFT_KEY_TOLERANCE = 260;

export interface ChromaKeyResult {
    dataUrl: string;
    transparentPixels: number;
    featheredPixels: number;
}

export interface ChromaKeyStats {
    transparentPixels: number;
    featheredPixels: number;
}

export function buildTransparentFullBodyPrompt(characterDescription: string): string {
    return [
        characterDescription.trim(),
        'Mandatory composition and background requirements:',
        '- Draw exactly one character as a full-body standing illustration, centered and facing the viewer.',
        '- Show the complete character from the top of the head through both feet. Do not crop hair, clothing, hands, legs, or feet.',
        '- Leave a clear margin around the entire silhouette. Use a simple neutral standing pose.',
        `- Fill the entire background edge-to-edge with one perfectly flat, uniform chroma-key green: ${AVATAR_CHROMA_KEY_HEX}.`,
        '- The background must contain no scenery, floor, horizon, shadow, gradient, texture, pattern, border, text, or props.',
        `- Do not use ${AVATAR_CHROMA_KEY_HEX} or a matching chroma-key green anywhere on the character, clothing, accessories, eyes, or effects.`,
    ].join('\n');
}

export function applyAvatarChromaKey(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
): ChromaKeyStats {
    const pixelCount = width * height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new RangeError('画像サイズが不正です。');
    }
    if (pixels.length !== pixelCount * 4) {
        throw new RangeError('ピクセル数と画像サイズが一致しません。');
    }

    const hardKeyMask = new Uint8Array(pixelCount);
    let transparentPixels = 0;
    let featheredPixels = 0;

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        const offset = pixelIndex * 4;
        if (pixels[offset + 3] === 0) continue;
        if (colorDistanceFromKey(pixels, offset) > HARD_KEY_TOLERANCE) continue;

        hardKeyMask[pixelIndex] = 1;
        pixels[offset + 3] = 0;
        transparentPixels += 1;
    }

    // Only feather pixels beside confirmed key-colored background. This removes the
    // anti-aliased green fringe without erasing similarly colored details elsewhere.
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const pixelIndex = y * width + x;
            if (hardKeyMask[pixelIndex] || !hasHardKeyNeighbor(hardKeyMask, width, height, x, y)) {
                continue;
            }

            const offset = pixelIndex * 4;
            const originalAlpha = pixels[offset + 3];
            if (originalAlpha === 0) continue;

            const distance = colorDistanceFromKey(pixels, offset);
            if (distance >= SOFT_KEY_TOLERANCE) continue;

            const opacity = Math.max(
                0,
                Math.min(1, (distance - HARD_KEY_TOLERANCE) / (SOFT_KEY_TOLERANCE - HARD_KEY_TOLERANCE)),
            );
            const nextAlpha = Math.round(originalAlpha * opacity);
            if (nextAlpha >= originalAlpha) continue;

            pixels[offset + 3] = nextAlpha;
            featheredPixels += 1;
        }
    }

    return { transparentPixels, featheredPixels };
}

export async function removeAvatarChromaKeyBackground(dataUrl: string): Promise<ChromaKeyResult> {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像の透過処理を開始できませんでした。');

    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const stats = applyAvatarChromaKey(imageData.data, canvas.width, canvas.height);
    context.putImageData(imageData, 0, 0);

    return {
        dataUrl: canvas.toDataURL('image/png'),
        ...stats,
    };
}

function colorDistanceFromKey(pixels: Uint8ClampedArray, offset: number): number {
    const redDelta = pixels[offset] - AVATAR_CHROMA_KEY.red;
    const greenDelta = pixels[offset + 1] - AVATAR_CHROMA_KEY.green;
    const blueDelta = pixels[offset + 2] - AVATAR_CHROMA_KEY.blue;
    return Math.hypot(redDelta, greenDelta, blueDelta);
}

function hasHardKeyNeighbor(
    hardKeyMask: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
): boolean {
    const minX = Math.max(0, x - 1);
    const maxX = Math.min(width - 1, x + 1);
    const minY = Math.max(0, y - 1);
    const maxY = Math.min(height - 1, y + 1);

    for (let neighborY = minY; neighborY <= maxY; neighborY += 1) {
        for (let neighborX = minX; neighborX <= maxX; neighborX += 1) {
            if (neighborX === x && neighborY === y) continue;
            if (hardKeyMask[neighborY * width + neighborX]) return true;
        }
    }
    return false;
}
