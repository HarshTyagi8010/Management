/**
 * Recognises the image formats accepted for uploads (logos) from their bytes,
 * never from a file name or a declared type, and reads their pixel size.
 * Anything else (SVG, HTML, GIF, a PNG header in front of something else…) is
 * refused by returning null.
 */
export interface ImageInfo {
  contentType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_END = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function png(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // The first chunk must be IHDR (length 13); a complete file ends with the IEND chunk.
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  if (!bytes.subarray(bytes.length - 8).equals(PNG_END)) return null;
  return { contentType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Start-of-frame markers that carry the image size (baseline, progressive, lossless…; not DHT/JPG/DAC). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (SOF.has(marker)) {
      if (length < 7) return null;
      return { contentType: 'image/jpeg', height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xda) return null; // image data before any frame header
    offset += 2 + length;
  }
  return null;
}

export function inspectImage(bytes: Buffer): ImageInfo | null {
  return png(bytes) ?? jpeg(bytes);
}
