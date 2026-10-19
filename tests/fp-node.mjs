// Node side of image recognition: decodes images with sharp, then uses the
// same fingerprint code as the site (../fingerprint.js).
import { createRequire } from 'node:module';
import sharp from 'sharp';

const FP = createRequire(import.meta.url)('../fingerprint.js');
export { FP };

async function raw(img, w, h) {
  const { data } = await img.clone().resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

// An official image: the card fills it.
export async function fingerprintCard(buf) {
  return FP.fingerprint(await raw(sharp(buf), FP.CARD_W, FP.CARD_H));
}

// A photo: find the card (trying a few tilts), then fingerprint that part only.
export async function fingerprintPhoto(buf) {
  const base = await sharp(buf).rotate().toBuffer(); // honours the phone's orientation flag
  let best = null;
  for (const angle of FP.TILTS) {
    const img = sharp(angle ? await sharp(base).rotate(angle, { background: '#000' }).toBuffer() : base);
    const meta = await img.metadata();
    const W = 160;
    const H = Math.round((meta.height * W) / meta.width);
    const box = FP.findCard(await raw(img, W, H), W, H);
    if (!best || box.score > best.box.score) best = { img, meta, k: meta.width / W, box };
  }
  const { img, meta, k, box } = best;
  const left = Math.max(0, Math.round(box.x * k));
  const top = Math.max(0, Math.round(box.y * k));
  const region = { left, top, width: Math.min(meta.width - left, Math.round(box.w * k)), height: Math.min(meta.height - top, Math.round(box.h * k)) };
  const card = sharp(await img.clone().extract(region).toBuffer());
  return { box: region, crop: card, ...FP.fingerprint(await raw(card, FP.CARD_W, FP.CARD_H)) };
}
