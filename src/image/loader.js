// Image loading + metadata. Files stay local: we decode in-browser via
// createImageBitmap and keep an object URL only as a decode fallback.
// Nothing ever uploads.
import { parseExif, formatExif } from './exif.js';

export class ImageAsset {
  constructor(file, bitmap, exif) {
    this.file = file;
    this.name = file.name;
    this.bytes = file.size;
    this.mime = file.type || 'application/octet-stream';
    this.lastModified = file.lastModified;
    this.bitmap = bitmap;
    this.w = bitmap.width;
    this.h = bitmap.height;
    this.exif = formatExif(parseExif(exif));
    this.url = null;
    this.hash = null; // perceptual hash [hi, lo], filled by the queue
  }

  static async fromFile(file) {
    if (!file.type.startsWith('image/')) {
      throw new Error(`${file.name} is not an image`);
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // older engines: no options bag or no createImageBitmap
      bitmap = await decodeViaImg(file);
    }
    let exif;
    try {
      // EXIF lives in the file header; never read a multi-hundred-MB image
      // into memory just to inspect its metadata.
      exif = await file.slice(0, 256 * 1024).arrayBuffer();
    } catch { exif = new ArrayBuffer(0); }
    return new ImageAsset(file, bitmap, exif);
  }

  release() {
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.bitmap.close?.();
  }
}

function decodeViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`cannot decode ${file.name}`));
    };
    img.src = url;
  });
}

// 20×20 cover-crop thumbnail canvas for the queue rail.
export function makeThumb(asset) {
  const c = document.createElement('canvas');
  c.width = 20;
  c.height = 20;
  c.className = 'qrow-thumb';
  const ctx = c.getContext('2d');
  const s = Math.max(20 / asset.w, 20 / asset.h);
  const w = asset.w * s, hgt = asset.h * s;
  ctx.drawImage(asset.bitmap, (20 - w) / 2, (20 - hgt) / 2, w, hgt);
  return c;
}
