/**
 * Shrinks an image file in the browser before OCR or upload:
 * - Validates file type (JPG, PNG, WEBP)
 * - Scales long edge to at most 2000 px without upscaling
 * - Downscales to minimum 1200 px long edge if needed to fit under 900,000 characters
 * - Compresses JPEG quality from 0.85 down to 0.5
 * - Keeps request payload well under 1 MB
 */

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_LONG_EDGE = 2000;
const MIN_LONG_EDGE = 1200;
const MAX_DATA_URL_LENGTH = 900000;

export async function shrinkImageFile(file) {
  if (!file) throw new Error('No file provided');

  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  const isAllowed = ALLOWED_MIME.includes(type) || /\.(jpe?g|png|webp)$/i.test(name);
  if (!isAllowed) {
    throw new Error('Use a JPG, PNG or WEBP photo');
  }

  // Load image
  const objectUrl = URL.createObjectURL(file);
  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to load image'));
      el.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const origWidth = img.naturalWidth || img.width || 1;
  const origHeight = img.naturalHeight || img.height || 1;

  // Initial sizing: long edge at most 2000 px, never upscale
  let scale = 1;
  const longEdge = Math.max(origWidth, origHeight);
  if (longEdge > MAX_LONG_EDGE) {
    scale = MAX_LONG_EDGE / longEdge;
  }

  let width = Math.round(origWidth * scale);
  let height = Math.round(origHeight * scale);

  const canvas = document.createElement('canvas');
  let q = 0.85;

  while (true) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context not supported');
    }
    ctx.drawImage(img, 0, 0, width, height);

    let dataUrl = canvas.toDataURL('image/jpeg', q);
    if (dataUrl.length <= MAX_DATA_URL_LENGTH) {
      return { dataUrl, name: file.name || 'document.jpg' };
    }

    // Try lowering quality
    if (q > 0.55) {
      q = Math.round((q - 0.1) * 100) / 100;
      continue;
    }

    // Quality hit minimum (0.5). Can we scale down dimensions without going below MIN_LONG_EDGE?
    const currentLongEdge = Math.max(width, height);
    if (currentLongEdge * 0.8 >= MIN_LONG_EDGE) {
      width = Math.round(width * 0.8);
      height = Math.round(height * 0.8);
      q = 0.85;
      continue;
    }

    // Reached minimum scale and minimum quality, try one last pass at min edge
    if (currentLongEdge > MIN_LONG_EDGE) {
      const minScale = MIN_LONG_EDGE / currentLongEdge;
      width = Math.round(width * minScale);
      height = Math.round(height * minScale);
      q = 0.5;
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      dataUrl = canvas.toDataURL('image/jpeg', q);
      if (dataUrl.length <= MAX_DATA_URL_LENGTH) {
        return { dataUrl, name: file.name || 'document.jpg' };
      }
    }

    // Still too large
    throw new Error('This photo is too large. Try a smaller or cropped photo.');
  }
}
