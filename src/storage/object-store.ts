export type Bucket = 'public' | 'private';
export interface ObjectInfo { size: number; contentType: string }

// The only thing the service knows about R2. Production uses r2.ts; tests use an in-memory fake.
export interface ObjectStore {
  presignPut(bucket: Bucket, key: string, options: { contentType: string; expiresInSeconds: number }): Promise<string>;
  presignGet(bucket: Bucket, key: string, options: { expiresInSeconds: number }): Promise<string>;
  head(bucket: Bucket, key: string): Promise<ObjectInfo | null>;
  get(bucket: Bucket, key: string): Promise<Uint8Array | null>;
  put(bucket: Bucket, key: string, body: Uint8Array, contentType: string, cacheControl?: string): Promise<void>;
  copy(bucket: Bucket, fromKey: string, toKey: string, options?: { contentType: string; cacheControl: string }): Promise<void>;
  delete(bucket: Bucket, key: string): Promise<void>;
  deletePrefix(bucket: Bucket, prefix: string): Promise<void>;
}
