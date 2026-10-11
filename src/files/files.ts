import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { files } from '../db/schema.ts';
import { writeAudit } from '../audit/write-audit.ts';
import { HttpError } from '../http/errors.ts';
import type { Bucket, ObjectStore } from '../storage/object-store.ts';
import { createVariants, variantKey } from './variants.ts';

export const MAX_SIZE = 25 * 1024 * 1024;
export const UPLOAD_ADDRESS_SECONDS = 15 * 60;
export const PRIVATE_VIEW_SECONDS = 5 * 60;
export const TEMPORARY_DAYS = 7;
export const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface Caller { systemCode: string; actorId: string | null }
export interface FileDeps { db: NodePgDatabase; store: ObjectStore; publicBaseUrl: string }

type Row = typeof files.$inferSelect;
const bucketOf = (row: Pick<Row, 'visibility'>): Bucket => row.visibility;
const keyOf = (id: string) => `${id}/original`;
const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

function address({ store, publicBaseUrl }: FileDeps, row: Row, key: string) {
  return row.visibility === 'public'
    ? `${publicBaseUrl.replace(/\/+$/, '')}/${key}`
    : store.presignGet('private', key, { expiresInSeconds: PRIVATE_VIEW_SECONDS });
}

async function present(row: Row, deps: FileDeps) {
  return {
    id: row.id, status: row.status, filename: row.filename, contentType: row.content_type, size: row.size,
    visibility: row.visibility, retentionType: row.retention_type, expiresAt: row.expires_at?.toISOString() ?? null,
    variants: await Promise.all(row.variants.map(async variant => ({
      ...variant, url: variant.status === 'ready' ? await address(deps, row, variantKey(row.id, variant.name)) : null,
    }))),
  };
}

function oneOf<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = body[field];
  if (value === undefined || value === null || value === '') throw new HttpError(400, `${field} is required (${allowed.join(' or ')})`);
  if (!allowed.includes(value as T)) throw new HttpError(400, `${field} must be ${allowed.join(' or ')}`);
  return value as T;
}

export async function requestUpload(deps: FileDeps, caller: Caller, input: unknown) {
  const { db, store } = deps;
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const visibility = oneOf(body, 'visibility', ['public', 'private']);
  const retentionType = oneOf(body, 'retentionType', ['permanent', 'temporary']);
  const { filename, contentType, size } = body;
  if (typeof filename !== 'string' || !filename.trim()) throw new HttpError(400, 'filename is required');
  if (typeof contentType !== 'string' || !ALLOWED_TYPES.has(contentType)) throw new HttpError(400, 'contentType is not an allowed file type');
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) throw new HttpError(400, 'size must be a positive number of bytes');
  if (size > MAX_SIZE) throw new HttpError(400, 'size must be 25 MB or less');

  const [row] = await db.insert(files).values({
    filename: filename.trim(), content_type: contentType, size, visibility, retention_type: retentionType, created_by_system: caller.systemCode,
  }).returning();
  if (!row) throw new Error('Insert returned no row');
  const uploadUrl = await store.presignPut(bucketOf(row), keyOf(row.id), { contentType, expiresInSeconds: UPLOAD_ADDRESS_SECONDS });
  await writeAudit(db, { action: 'file.requested', fileId: row.id, ...caller, detail: { filename: row.filename, contentType, size, visibility, retentionType } });
  return { ...await present(row, deps), uploadUrl, uploadUrlExpiresInSeconds: UPLOAD_ADDRESS_SECONDS };
}

export async function confirmUpload(deps: FileDeps, caller: Caller, id: string) {
  const { db, store } = deps;
  if (!isUuid(id)) throw new HttpError(404, 'File not found');
  const result = await db.transaction(async tx => {
    // Hold the File lock through generation so another confirm returns the saved result without writing Variants again.
    const [row] = await tx.select().from(files).where(eq(files.id, id)).for('update');
    if (!row) return new HttpError(404, 'File not found');
    if (row.expires_at && row.expires_at <= new Date()) return new HttpError(404, 'File not found');
    if (row.status === 'active') return row;

    const found = await store.head(bucketOf(row), keyOf(row.id));
    if (!found) return new HttpError(409, 'No uploaded object found; upload to the signed address first');
    const baseType = (type: string) => type.split(';')[0]?.trim().toLowerCase();
    if (found.size !== row.size || baseType(found.contentType) !== baseType(row.content_type)) {
      await tx.delete(files).where(eq(files.id, row.id));
      await store.delete(bucketOf(row), keyOf(row.id));
      await writeAudit(tx, { action: 'file.rejected', fileId: row.id, ...caller, detail: { declared: { size: row.size, contentType: row.content_type }, found } });
      // Return the rejection so removal commits before the HTTP error is thrown.
      return new HttpError(422, 'Uploaded object does not match the declared size or type; it was removed');
    }

    const variants = await createVariants(store, bucketOf(row), row.id, row.content_type);
    const now = new Date();
    const expiresAt = row.retention_type === 'temporary' ? new Date(now.getTime() + TEMPORARY_DAYS * 86_400_000) : null;
    const [active] = await tx.update(files).set({ status: 'active', confirmed_at: now, expires_at: expiresAt, variants })
      .where(eq(files.id, row.id)).returning();
    if (!active) throw new Error('Confirmed File disappeared while locked');
    await writeAudit(tx, { action: 'file.confirmed', fileId: row.id, ...caller });
    return active;
  });
  if (result instanceof HttpError) throw result;
  return present(result, deps);
}

export async function viewFile(deps: FileDeps, caller: Caller, id: string) {
  const { db } = deps;
  const [row] = isUuid(id)
    ? await db.select().from(files).where(and(eq(files.id, id), eq(files.status, 'active'), or(isNull(files.expires_at), gt(files.expires_at, new Date()))))
    : [];
  if (!row) throw new HttpError(404, 'File not found');
  const url = await address(deps, row, keyOf(row.id));
  await writeAudit(db, { action: 'file.viewed', fileId: row.id, ...caller });
  return { ...await present(row, deps), url };
}
