// Minimal client-side EXIF reader: JPEG APP1/TIFF IFD0 + Exif sub-IFD, and
// PNG's eXIf chunk (TIFF structure inside). Covers the fields a diff tool
// actually shows; unknown tags are skipped. No dependencies.
const TAGS = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x0132: 'DateTime',
  0x0131: 'Software',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISOSpeedRatings',
  0x9003: 'DateTimeOriginal',
  0x920a: 'FocalLength',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
};

const ORIENT = {
  1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored vertically',
  5: 'Transposed', 6: 'Rotated 90° CW', 7: 'Transversed', 8: 'Rotated 90° CCW',
};

const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

// Walks a TIFF structure rooted at `base` (offset into `view`).
// All IFD/tag offsets inside a TIFF are relative to the TIFF start.
function parseTIFF(view, base, out) {
  if (base + 8 > view.byteLength) return;
  const le = view.getUint16(base) === 0x4949; // 'II' little-endian
  const u16 = (o) => view.getUint16(base + o, le);
  const u32 = (o) => view.getUint32(base + o, le);

  const readValue = (entry) => {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const size = (SIZES[type] ?? 1) * count;
    const rel = size <= 4 ? entry + 8 : u32(entry + 8);
    if (base + rel + size > view.byteLength) return null;
    switch (type) {
      case 2: { // ASCII
        let s = '';
        for (let i = 0; i < count; i++) s += String.fromCharCode(view.getUint8(base + rel + i));
        return s.replace(/\0.*$/, '').trim() || null;
      }
      case 3: return count === 1 ? u16(rel) : null;
      case 4: return count === 1 ? u32(rel) : null;
      case 5: case 10: { // rational (numerator, denominator)
        const num = u32(rel);
        const den = u32(rel + 4);
        return den ? num / den : null;
      }
      default: return null;
    }
  };

  const walkIFD = (ifd) => {
    if (ifd <= 0 || base + ifd + 2 > view.byteLength) return null;
    const n = u16(ifd);
    if (base + ifd + 2 + n * 12 > view.byteLength) return null;
    let next = null;
    for (let i = 0; i < n; i++) {
      const entry = ifd + 2 + i * 12;
      const tag = u16(entry);
      if (tag === 0x8769) { next = u32(entry + 8); continue; } // Exif sub-IFD
      const name = TAGS[tag];
      if (!name) continue;
      const v = readValue(entry);
      if (v !== null && v !== undefined) out[name] = v;
    }
    return next;
  };

  const exifIfd = walkIFD(u32(4));
  if (exifIfd) walkIFD(exifIfd);
}

export function parseExif(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  try {
    // JPEG: scan segments for APP1 "Exif\0\0"
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 4 < bytes.length) {
        if (bytes[i] !== 0xff) break;
        const marker = bytes[i + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker === 0xe1 && len >= 8) {
          const s = i + 4;
          const isExif = bytes[s] === 0x45 && bytes[s + 1] === 0x78
            && bytes[s + 2] === 0x69 && bytes[s + 3] === 0x66
            && bytes[s + 4] === 0 && bytes[s + 5] === 0;
          if (isExif) {
            const out = {};
            parseTIFF(view, s + 6, out);
            return out;
          }
        }
        if (marker === 0xda) break; // start of scan
        i += 2 + len;
      }
      return {};
    }
    // PNG: eXIf chunk carries a bare TIFF structure
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      let i = 8;
      while (i + 8 < bytes.length) {
        const len = view.getUint32(i);
        const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
        if (type === 'eXIf') {
          const out = {};
          parseTIFF(view, i + 8, out);
          return out;
        }
        if (type === 'IDAT' || type === 'IEND') break;
        i += 12 + len;
      }
      return {};
    }
    return {};
  } catch {
    return {};
  }
}

// Human-readable formatting for the details panels.
export function formatExif(exif) {
  const f = {};
  if (exif.Make) f['Camera make'] = exif.Make;
  if (exif.Model) f['Camera model'] = exif.Model;
  if (exif.Software) f['Software'] = exif.Software;
  if (exif.Orientation) f['Orientation'] = ORIENT[exif.Orientation] ?? String(exif.Orientation);
  if (exif.DateTime) f['Captured (file)'] = exif.DateTime;
  if (exif.DateTimeOriginal) f['Captured'] = exif.DateTimeOriginal;
  if (typeof exif.ExposureTime === 'number' && exif.ExposureTime > 0) {
    f['Exposure'] = exif.ExposureTime >= 1
      ? `${exif.ExposureTime.toFixed(1)} s`
      : `1/${Math.round(1 / exif.ExposureTime)} s`;
  }
  if (typeof exif.FNumber === 'number' && exif.FNumber > 0) f['Aperture'] = `f/${exif.FNumber}`;
  if (typeof exif.ISOSpeedRatings === 'number') f['ISO'] = String(exif.ISOSpeedRatings);
  if (typeof exif.FocalLength === 'number') f['Focal length'] = `${Math.round(exif.FocalLength)} mm`;
  if (exif.PixelXDimension && exif.PixelYDimension) {
    f['Sensor size'] = `${exif.PixelXDimension} × ${exif.PixelYDimension}`;
  }
  return f;
}
