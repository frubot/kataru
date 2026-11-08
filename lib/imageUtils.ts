// Resize an image dataURL so its longest edge is <= maxEdge. Returns PNG dataURL.
export async function resizeToMaxEdge(dataUrl: string, maxEdge: number): Promise<string> {
    const img = await loadImage(dataUrl);
    const { width, height } = img;
    const longest = Math.max(width, height);
    if (longest <= maxEdge) {
        // Re-encode to PNG to ensure consistent format
        return drawToCanvas(img, width, height).toDataURL('image/png');
    }
    const scale = maxEdge / longest;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    return drawToCanvas(img, w, h).toDataURL('image/png');
}

// Create a metadata-free JPEG copy for lightweight image analysis requests.
export async function resizeToMaxEdgeAsJpeg(
    dataUrl: string,
    maxEdge: number,
    quality = 0.85,
): Promise<string> {
    const img = await loadImage(dataUrl);
    const longest = Math.max(img.width, img.height);
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    return drawToCanvas(img, width, height).toDataURL('image/jpeg', quality);
}

// Crop a square region (in original image coordinates) and downscale to outSize x outSize JPEG.
export async function cropSquareToJpeg(
    dataUrl: string,
    sx: number,
    sy: number,
    sSize: number,
    outSize: number,
    quality = 0.85,
): Promise<string> {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, outSize, outSize);
    return canvas.toDataURL('image/jpeg', quality);
}

export async function cropSquareToPng(
    dataUrl: string,
    sx: number,
    sy: number,
    sSize: number,
    outSize: number,
): Promise<string> {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, outSize, outSize);
    return canvas.toDataURL('image/png');
}

// Crop a rectangle in original image coordinates. The rectangle may extend
// beyond the image; the area outside the image stays transparent.
export async function cropRectToPng(
    dataUrl: string,
    sx: number,
    sy: number,
    sWidth: number,
    sHeight: number,
): Promise<string> {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sWidth));
    canvas.height = Math.max(1, Math.round(sHeight));
    const ctx = canvas.getContext('2d')!;
    const kx = canvas.width / sWidth;
    const ky = canvas.height / sHeight;
    const ix0 = Math.max(sx, 0);
    const iy0 = Math.max(sy, 0);
    const ix1 = Math.min(sx + sWidth, img.width);
    const iy1 = Math.min(sy + sHeight, img.height);
    if (ix1 > ix0 && iy1 > iy0) {
        ctx.drawImage(
            img,
            ix0, iy0, ix1 - ix0, iy1 - iy0,
            (ix0 - sx) * kx, (iy0 - sy) * ky, (ix1 - ix0) * kx, (iy1 - iy0) * ky,
        );
    }
    return canvas.toDataURL('image/png');
}

export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
        img.src = src;
    });
}

function drawToCanvas(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
}
