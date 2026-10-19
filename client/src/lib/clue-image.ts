import { CLUE_IMAGE_MAX_DIMENSION, getClueFragmentRects, type ClueImageUpload } from '@city-game/shared';

const THUMBNAIL_MAX_DIMENSION = 240;
const TILE_QUALITY = 0.86;

// Cuts a picture into `fragmentCount` clue fragments in the browser, so the server never needs an
// image library. The picture is scaled down to CLUE_IMAGE_MAX_DIMENSION first; each fragment is its own JPEG.
export async function cutClueImage(file: File, fragmentCount: number): Promise<ClueImageUpload> {
  const bitmap = await loadImage(file);
  try {
    const scale = Math.min(1, CLUE_IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const full = drawToCanvas(bitmap, width, height);

    const tiles = getClueFragmentRects(width, height, fragmentCount).map((rect) => {
      // Round the edges rather than the sizes so neighbouring fragments meet without gaps.
      const left = Math.round(rect.x * width);
      const top = Math.round(rect.y * height);
      const right = Math.round((rect.x + rect.width) * width);
      const bottom = Math.round((rect.y + rect.height) * height);
      const tile = document.createElement('canvas');
      tile.width = Math.max(1, right - left);
      tile.height = Math.max(1, bottom - top);
      tile.getContext('2d')!.drawImage(full, left, top, tile.width, tile.height, 0, 0, tile.width, tile.height);
      return tile.toDataURL('image/jpeg', TILE_QUALITY);
    });

    const thumbScale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(width, height));
    const thumbnail = drawToCanvas(full, Math.max(1, Math.round(width * thumbScale)), Math.max(1, Math.round(height * thumbScale))).toDataURL('image/jpeg', 0.7);

    return { width, height, thumbnail, tiles };
  } finally {
    if ('close' in bitmap) bitmap.close();
  }
}

function drawToCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

// createImageBitmap honours EXIF rotation; fall back to an <img> where it can't decode the file.
async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    } catch {
      throw new Error(file.name + " isn't a picture this browser can read.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
