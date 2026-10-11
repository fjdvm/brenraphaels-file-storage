import sharp from 'sharp';
import type { Bucket, ObjectStore } from '../storage/object-store.ts';

export interface Variant {
  name: 'small' | 'medium' | 'large';
  status: 'ready' | 'failed';
}

const sizes = { small: 150, medium: 600, large: 1200 } as const;
const pictureTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Public objects are cached by the CDN and browsers for at most this long, so a replaced picture shows within about 5 minutes.
export const PUBLIC_CACHE_CONTROL = 'public, max-age=300';
export const cacheControlFor = (bucket: Bucket) => bucket === 'public' ? PUBLIC_CACHE_CONTROL : undefined;
export const variantKey = (id: string, name: Variant['name']) => `${id}/${name}.webp`;

export async function createVariants(store: ObjectStore, bucket: Bucket, id: string, contentType: string): Promise<Variant[]> {
  if (!pictureTypes.has(contentType)) return [];
  const names = Object.keys(sizes) as Variant['name'][];
  let original: Uint8Array | null;
  try {
    original = await store.get(bucket, `${id}/original`);
  } catch {
    return names.map(name => ({ name, status: 'failed' }));
  }
  if (!original) return names.map(name => ({ name, status: 'failed' }));
  const variants: Variant[] = [];
  for (const name of names) {
    try {
      const body = await sharp(original).rotate().resize({ width: sizes[name], height: sizes[name], fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
      await store.put(bucket, variantKey(id, name), body, 'image/webp', cacheControlFor(bucket));
      variants.push({ name, status: 'ready' });
    } catch {
      variants.push({ name, status: 'failed' });
    }
  }
  return variants;
}
