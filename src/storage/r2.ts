import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Bucket, ObjectInfo, ObjectStore } from './object-store.ts';

export interface R2Config { accountId: string; accessKeyId: string; secretAccessKey: string; publicBucket: string; privateBucket: string }

export class R2ObjectStore implements ObjectStore {
  private client: S3Client;
  private buckets: Record<Bucket, string>;
  constructor(config: R2Config) {
    this.client = new S3Client({
      region: 'auto', endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    this.buckets = { public: config.publicBucket, private: config.privateBucket };
  }

  // The content type is signed into the address, so the client must send exactly that type.
  presignPut(bucket: Bucket, key: string, { contentType, expiresInSeconds }: { contentType: string; expiresInSeconds: number }) {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.buckets[bucket], Key: key, ContentType: contentType }), { expiresIn: expiresInSeconds });
  }
  presignGet(bucket: Bucket, key: string, { expiresInSeconds }: { expiresInSeconds: number }) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.buckets[bucket], Key: key }), { expiresIn: expiresInSeconds });
  }
  async head(bucket: Bucket, key: string): Promise<ObjectInfo | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.buckets[bucket], Key: key }));
      return { size: result.ContentLength ?? 0, contentType: result.ContentType ?? '' };
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound' || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }
  async get(bucket: Bucket, key: string) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.buckets[bucket], Key: key }));
      return (await result.Body?.transformToByteArray()) ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }
  async put(bucket: Bucket, key: string, body: Uint8Array, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.buckets[bucket], Key: key, Body: body, ContentType: contentType }));
  }
  async copy(bucket: Bucket, fromKey: string, toKey: string) {
    const name = this.buckets[bucket];
    await this.client.send(new CopyObjectCommand({ Bucket: name, Key: toKey, CopySource: `${name}/${fromKey}` }));
  }
  async delete(bucket: Bucket, key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.buckets[bucket], Key: key }));
  }
  async deletePrefix(bucket: Bucket, prefix: string) {
    const name = this.buckets[bucket];
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: name, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).flatMap(object => object.Key ? [{ Key: object.Key }] : []);
      if (keys.length) {
        const result = await this.client.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: keys } }));
        if (result.Errors?.length) throw new Error('R2 could not delete every File object');
      }
      token = page.NextContinuationToken;
    } while (token);
  }
}
