// Magic-byte sniffing for uploads.
//
// `/api/upload` receives the MIME type from a client-controlled header, so an
// executable can claim to be `image/png`. Sniffing the real content type lets the
// stored metadata reflect the bytes rather than the claim.

const TEXTUAL_CLAIM_PATTERN = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml)|image\/svg\+xml)/;

function startsWith(buffer, bytes, offset = 0) {
  if (!buffer || buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function asciiAt(buffer, offset, length) {
  if (!buffer || buffer.length < offset + length) return '';
  return buffer.toString('latin1', offset, offset + length);
}

const FTYP_BRANDS = new Map([
  ['avif', 'image/avif'],
  ['avis', 'image/avif'],
  ['heic', 'image/heic'],
  ['heix', 'image/heic'],
  ['hevc', 'image/heic'],
  ['heim', 'image/heic'],
  ['mif1', 'image/heif'],
  ['msf1', 'image/heif'],
  ['qt  ', 'video/quicktime'],
  ['isom', 'video/mp4'],
  ['iso2', 'video/mp4'],
  ['mp41', 'video/mp4'],
  ['mp42', 'video/mp4'],
  ['M4V ', 'video/x-m4v'],
]);

/**
 * Returns the detected MIME type, or '' when the bytes are not recognised.
 * Absence of a signature is not evidence of anything: plain text, CSV and source
 * files legitimately have no magic bytes.
 */
export function sniffMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return '';

  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(buffer, [0x42, 0x4d])) return 'image/bmp';
  if (startsWith(buffer, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';

  if (asciiAt(buffer, 0, 4) === 'RIFF') {
    const form = asciiAt(buffer, 8, 4);
    if (form === 'WEBP') return 'image/webp';
    if (form === 'WAVE') return 'audio/wav';
    if (form === 'AVI ') return 'video/x-msvideo';
  }

  if (asciiAt(buffer, 4, 4) === 'ftyp') {
    const brand = asciiAt(buffer, 8, 4);
    if (FTYP_BRANDS.has(brand)) return FTYP_BRANDS.get(brand);
  }

  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(buffer, [0x50, 0x4b, 0x07, 0x08])) return 'application/zip';
  if (startsWith(buffer, [0x1f, 0x8b])) return 'application/gzip';
  if (startsWith(buffer, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  if (startsWith(buffer, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'application/vnd.rar';

  // Executables. These are the reason sniffing exists at all.
  if (startsWith(buffer, [0x4d, 0x5a])) return 'application/vnd.microsoft.portable-executable';
  if (startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-elf';
  if (startsWith(buffer, [0xca, 0xfe, 0xba, 0xbe])
    || startsWith(buffer, [0xcf, 0xfa, 0xed, 0xfe])
    || startsWith(buffer, [0xce, 0xfa, 0xed, 0xfe])) return 'application/x-mach-binary';
  if (startsWith(buffer, [0x23, 0x21])) return 'text/x-shellscript';

  return '';
}

export function normalizeClaimedMimeType(value) {
  return String(value || '').trim().toLowerCase().split(';')[0].slice(0, 127);
}

/**
 * Reconciles the client's claim against the sniffed reality. The sniffed type
 * wins on disagreement so a disguised executable is stored as what it is, while
 * unrecognised bytes leave the claim untouched.
 */
export function reconcileMimeType(claimed, sniffed) {
  const claim = normalizeClaimedMimeType(claimed) || 'application/octet-stream';
  const detected = normalizeClaimedMimeType(sniffed);

  if (!detected) return { mimeType: claim, corrected: false, claimed: claim, sniffed: '' };
  if (detected === claim) return { mimeType: claim, corrected: false, claimed: claim, sniffed: detected };

  // JPEG has two spellings in the wild; treat them as agreement.
  if ((claim === 'image/jpg' && detected === 'image/jpeg') || (claim === 'image/jpeg' && detected === 'image/jpg')) {
    return { mimeType: 'image/jpeg', corrected: false, claimed: claim, sniffed: detected };
  }

  // Office/OpenDocument files and JARs are ZIP containers; the specific claim is
  // more informative than the generic container type.
  if (detected === 'application/zip' && claim !== 'application/octet-stream' && TEXTUAL_CLAIM_PATTERN.test(claim) === false) {
    if (claim.includes('officedocument') || claim.includes('opendocument') || claim.includes('epub') || claim.includes('java-archive')) {
      return { mimeType: claim, corrected: false, claimed: claim, sniffed: detected };
    }
  }

  return { mimeType: detected, corrected: true, claimed: claim, sniffed: detected };
}

export function resolveUploadMimeType(buffer, claimedType) {
  return reconcileMimeType(claimedType, sniffMimeType(buffer));
}
