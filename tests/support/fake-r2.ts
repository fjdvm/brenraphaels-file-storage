import type { Bucket, ObjectInfo, ObjectStore } from '../../src/storage/object-store.ts';

interface Stored { body: Uint8Array; contentType: string; cacheControl?: string }

// In-memory stand-in for R2. Signed addresses point at fake://, and `upload` plays the client sending bytes to one.
export class FakeR2 implements ObjectStore {
  objects = new Map<string, Stored>();
  private pendingUploads = new Map<string, { contentType: string; expiresAt: number }>();
  private slot(bucket: Bucket, key: string) { return `${bucket}/${key}`; }

  async presignPut(bucket: Bucket, key: string, options: { contentType: string; expiresInSeconds: number }) {
    const url = `fake://${this.slot(bucket, key)}?put&expires=${options.expiresInSeconds}`;
    this.pendingUploads.set(url, { contentType: options.contentType, expiresAt: Date.now() + options.expiresInSeconds * 1000 });
    return url;
  }
  async presignGet(bucket: Bucket, key: string, options: { expiresInSeconds: number }) {
    return `fake://${this.slot(bucket, key)}?get&expires=${options.expiresInSeconds}`;
  }
  // What a client does with a presigned PUT: the type must match the one the address was pinned to.
  upload(url: string, body: Uint8Array, contentType: string) {
    const pending = this.pendingUploads.get(url);
    if (!pending) throw new Error('Unknown upload address');
    if (Date.now() > pending.expiresAt) throw new Error('Upload address expired');
    if (contentType !== pending.contentType) throw new Error('Content type does not match the signed address');
    this.objects.set(new URL(url).host + new URL(url).pathname, { body, contentType });
  }
  async head(bucket: Bucket, key: string): Promise<ObjectInfo | null> {
    const stored = this.objects.get(this.slot(bucket, key));
    return stored ? { size: stored.body.byteLength, contentType: stored.contentType } : null;
  }
  async get(bucket: Bucket, key: string) { return this.objects.get(this.slot(bucket, key))?.body ?? null; }
  async put(bucket: Bucket, key: string, body: Uint8Array, contentType: string, cacheControl?: string) { this.objects.set(this.slot(bucket, key), { body, contentType, cacheControl }); }
  async copy(bucket: Bucket, fromKey: string, toKey: string, options?: { contentType: string; cacheControl: string }) {
    const stored = this.objects.get(this.slot(bucket, fromKey));
    if (!stored) throw new Error('Source object not found');
    this.objects.set(this.slot(bucket, toKey), options ? { ...stored, ...options } : stored);
  }
  async delete(bucket: Bucket, key: string) { this.objects.delete(this.slot(bucket, key)); }
  async deletePrefix(bucket: Bucket, prefix: string) {
    for (const slot of [...this.objects.keys()]) if (slot.startsWith(this.slot(bucket, prefix))) this.objects.delete(slot);
  }
}
