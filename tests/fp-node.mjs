// Node side of the prototype: decodes images with sharp and builds fingerprints.
import sharp from 'sharp';
import { FP_W, FP_H, GRID_W, GRID_H, phash, colorGrid, findCard, findCardByEdges } from './fingerprint.mjs';

async function raw(img, w, h) {
  const { data } = await img.clone().resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

// An official image: the card fills it.
export async function fingerprintCard(buf) {
  const img = sharp(buf);
  return { hash: phash(await raw(img, FP_W, FP_H)), grid: colorGrid(await raw(img, GRID_W, GRID_H)), fine: colorGrid(await raw(img, 8, 11), 88) };
}

// A photo: find the card first, then fingerprint that part only.
export async function fingerprintPhoto(buf, method = 'edges') {
  const img = sharp(await sharp(buf).rotate().toBuffer()); // honours the phone's orientation flag
  const meta = await img.metadata();
  const W = method === 'edges' ? 160 : 300;
  const H = Math.round((meta.height * W) / meta.width);
  const pixels = await raw(img, W, H);
  const box = method === 'edges' ? findCardByEdges(pixels, W, H) : findCard(pixels, W, H);
  const k = meta.width / W;
  const region = {
    left: Math.max(0, Math.round(box.x * k)),
    top: Math.max(0, Math.round(box.y * k)),
    width: Math.min(meta.width - Math.round(box.x * k), Math.round(box.w * k)),
    height: Math.min(meta.height - Math.round(box.y * k), Math.round(box.h * k)),
  };
  const card = sharp(await img.clone().extract(region).toBuffer());
  return { box: region, crop: card, hash: phash(await raw(card, FP_W, FP_H)), grid: colorGrid(await raw(card, GRID_W, GRID_H)), fine: colorGrid(await raw(card, 8, 11), 88) };
}
