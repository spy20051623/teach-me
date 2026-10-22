import { nativeImage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Shot } from '../shared/protocol.ts';
import { IMAGE_EDGE } from '../shared/limits.ts';
// The HTTP operation owns these new files until it publishes the result.
export function zoomFiles(source: Shot, id: string) {
  return [
    path.join(path.dirname(source.path), `${id}-zoom.png`),
    path.join(path.dirname(source.path), `${id}-original.png`),
  ] as const;
}
export async function zoomShot(
  source: Shot,
  original: string | undefined,
  rect: [number, number, number, number],
  id: string,
  assertCurrent: () => void,
) {
  assertCurrent();
  const [x, y, w, h] = rect;
  if (x + w > source.width || y + h > source.height) throw new Error('裁切范围超出截图');
  const raw = nativeImage.createFromPath(original || source.path);
  const size = raw.getSize();
  const left = Math.round((x / source.width) * size.width),
    top = Math.round((y / source.height) * size.height);
  const crop = raw.crop({
    x: left,
    y: top,
    width: Math.min(size.width - left, Math.max(1, Math.round((w / source.width) * size.width))),
    height: Math.min(size.height - top, Math.max(1, Math.round((h / source.height) * size.height))),
  });
  const cropped = crop.getSize();
  const ratio = Math.min(1, IMAGE_EDGE / Math.max(cropped.width, cropped.height));
  const image =
    ratio < 1
      ? crop.resize({
          width: Math.max(1, Math.round(cropped.width * ratio)),
          height: Math.max(1, Math.round(cropped.height * ratio)),
        })
      : crop;
  const [file, rawFile] = zoomFiles(source, id);
  await fs.writeFile(file, image.toPNG());
  assertCurrent();
  await fs.writeFile(rawFile, crop.toPNG());
  assertCurrent();
  const base = source.crop || {
    x: 0,
    y: 0,
    width: source.bounds.width,
    height: source.bounds.height,
  };
  const shot: Shot = {
    ...source,
    id,
    path: file,
    ...image.getSize(),
    crop: {
      x: base.x + (x / source.width) * base.width,
      y: base.y + (y / source.height) * base.height,
      width: (w / source.width) * base.width,
      height: (h / source.height) * base.height,
    },
  };
  return { shot, original: rawFile };
}
