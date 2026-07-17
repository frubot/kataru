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
    ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
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
