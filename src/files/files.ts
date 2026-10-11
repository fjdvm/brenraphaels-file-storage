import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { fileLinks, files } from '../db/schema.ts';
import { writeAudit } from '../audit/write-audit.ts';
import { HttpError } from '../http/errors.ts';
import type { Bucket, ObjectStore } from '../storage/object-store.ts';
import { cacheControlFor, createVariants, variantKey } from './variants.ts';
import { checkRecord, insertLink } from './links.ts';
import { isUuid } from './schemas.ts';
import type { editRequest, recordQuery, replacementRequest, uploadRequest } from './schemas.ts';
import type { z } from 'zod';

export const UPLOAD_ADDRESS_SECONDS = 15 * 60;
export const PRIVATE_VIEW_SECONDS = 5 * 60;
export const TEMPORARY_DAYS = 7;

export interface Caller { systemCode: string; actorId: string | null }
export interface FileDeps { db: NodePgDatabase; store: ObjectStore; publicBaseUrl: string }

type Row = typeof files.$inferSelect;
const bucketOf = (row: Pick<Row, 'visibility'>): Bucket => row.visibility;
const keyOf = (id: string) => `${id}/original`;
const stagingKeyOf = (id: string) => `${id}/replacement`;

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

export async function requestUpload(deps: FileDeps, caller: Caller, input: z.output<typeof uploadRequest>) {
  const { db, store } = deps;
  const { filename, contentType, size, visibility, retentionType, link } = input;
  if (link) await checkRecord(db, link);
  return db.transaction(async tx => {
    const [row] = await tx.insert(files).values({
      filename, content_type: contentType, size, visibility, retention_type: retentionType, created_by_system: caller.systemCode,
    }).returning();
    if (!row) throw new Error('Insert returned no row');
    const uploadUrl = await store.presignPut(bucketOf(row), keyOf(row.id), { contentType, expiresInSeconds: UPLOAD_ADDRESS_SECONDS });
    await writeAudit(tx, { action: 'file.requested', fileId: row.id, ...caller, detail: { filename: row.filename, contentType, size, visibility, retentionType } });
    if (link) await insertLink(tx, caller, row.id, link);
    return { ...await present(row, deps), uploadUrl, uploadUrlExpiresInSeconds: UPLOAD_ADDRESS_SECONDS };
  });
}

export async function confirmUpload(deps: FileDeps, caller: Caller, id: string) {
  const { db, store } = deps;
  if (!isUuid(id)) throw new HttpError(404, 'File not found');
  const result = await db.transaction(async tx => {
    // Hold the File lock through generation so another confirm returns the saved result without writing Variants again.
    const [row] = await tx.select().from(files).where(eq(files.id, id)).for('update');
    if (!row || row.status === 'deleted') return new HttpError(404, 'File not found');
    if (row.expires_at && row.expires_at <= new Date()) return new HttpError(404, 'File not found');
    if (row.status === 'active') return row;

    const found = await store.head(bucketOf(row), keyOf(row.id));
    if (!found) return new HttpError(409, 'No uploaded object found; upload to the signed address first');
    if (found.size !== row.size || baseType(found.contentType) !== baseType(row.content_type)) {
      await tx.delete(files).where(eq(files.id, row.id));
      await store.delete(bucketOf(row), keyOf(row.id));
      await writeAudit(tx, { action: 'file.rejected', fileId: row.id, ...caller, detail: { declared: { size: row.size, contentType: row.content_type }, found } });
      // Return the rejection so removal commits before the HTTP error is thrown.
      return new HttpError(422, 'Uploaded object does not match the declared size or type; it was removed');
    }

    const cacheControl = cacheControlFor(bucketOf(row));
    if (cacheControl) await store.copy(bucketOf(row), keyOf(row.id), keyOf(row.id), { contentType: row.content_type, cacheControl });
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

const baseType = (type: string) => type.split(';')[0]?.trim().toLowerCase();
const isLive = (row: Row | undefined): row is Row => !!row && row.status === 'active' && !(row.expires_at && row.expires_at <= new Date());

export async function requestReplacement(deps: FileDeps, caller: Caller, id: string, input: z.output<typeof replacementRequest>) {
  const { db, store } = deps;
  if (!isUuid(id)) throw new HttpError(404, 'File not found');
  const { contentType, size } = input;
  return db.transaction(async tx => {
    const [row] = await tx.select().from(files).where(eq(files.id, id)).for('update');
    if (!isLive(row)) throw new HttpError(404, 'File not found');
    const [updated] = await tx.update(files).set({ replacement: { contentType, size } }).where(eq(files.id, id)).returning();
    if (!updated) throw new Error('File disappeared while locked');
    const uploadUrl = await store.presignPut(bucketOf(row), stagingKeyOf(id), { contentType, expiresInSeconds: UPLOAD_ADDRESS_SECONDS });
    await writeAudit(tx, { action: 'file.replacement_requested', fileId: id, ...caller, detail: { contentType, size } });
    return { ...await present(updated, deps), uploadUrl, uploadUrlExpiresInSeconds: UPLOAD_ADDRESS_SECONDS };
  });
}

export async function confirmReplacement(deps: FileDeps, caller: Caller, id: string) {
  const { db, store } = deps;
  if (!isUuid(id)) throw new HttpError(404, 'File not found');
  const result = await db.transaction(async tx => {
    const [row] = await tx.select().from(files).where(eq(files.id, id)).for('update');
    if (!isLive(row)) return new HttpError(404, 'File not found');
    const bucket = bucketOf(row);
    const declared = row.replacement;
    if (!declared) return new HttpError(409, 'No replacement has been requested');
    const found = await store.head(bucket, stagingKeyOf(id));
    if (!found) return new HttpError(409, 'No uploaded replacement found; upload to the signed address first');
    if (found.size !== declared.size || baseType(found.contentType) !== baseType(declared.contentType)) {
      await store.delete(bucket, stagingKeyOf(id));
      await tx.update(files).set({ replacement: null }).where(eq(files.id, id));
      await writeAudit(tx, { action: 'file.replacement_rejected', fileId: id, ...caller, detail: { declared, found } });
      // Return the rejection so the cleared request commits before the HTTP error is thrown.
      return new HttpError(422, 'Uploaded replacement does not match the declared size or type; it was removed and the File is unchanged');
    }

    await store.copy(bucket, stagingKeyOf(id), keyOf(id), { contentType: declared.contentType, cacheControl: cacheControlFor(bucket) ?? 'private' });
    await store.delete(bucket, stagingKeyOf(id));
    const variants = await createVariants(store, bucket, id, declared.contentType);
    for (const old of row.variants) if (!variants.some(variant => variant.name === old.name)) await store.delete(bucket, variantKey(id, old.name));
    const [updated] = await tx.update(files).set({ content_type: declared.contentType, size: declared.size, variants, replacement: null })
      .where(eq(files.id, id)).returning();
    if (!updated) throw new Error('Replaced File disappeared while locked');
    await writeAudit(tx, { action: 'file.replaced', fileId: id, ...caller, detail: {
      previous: { contentType: row.content_type, size: row.size }, contentType: declared.contentType, size: declared.size,
    } });
    return updated;
  });
  if (result instanceof HttpError) throw result;
  return present(result, deps);
}

export async function editFile(deps: FileDeps, caller: Caller, id: string, input: z.output<typeof editRequest>) {
  if (!isUuid(id)) throw new HttpError(404, 'File not found');
  const { filename, retentionType } = input;
  const edited = await deps.db.transaction(async tx => {
    const [row] = await tx.select().from(files).where(eq(files.id, id)).for('update');
    const now = new Date();
    if (!row || row.status !== 'active' || (row.expires_at && row.expires_at <= now)) throw new HttpError(404, 'File not found');
    const changes = {
      filename: filename ?? row.filename,
      retention_type: retentionType ?? row.retention_type,
      expires_at: retentionType && retentionType !== row.retention_type
        ? retentionType === 'temporary' ? new Date(now.getTime() + TEMPORARY_DAYS * 86_400_000) : null
        : row.expires_at,
    };
    const [updated] = await tx.update(files).set(changes).where(eq(files.id, id)).returning();
    if (!updated) throw new Error('Edited File disappeared while locked');
    await writeAudit(tx, { action: 'file.edited', fileId: id, ...caller, detail: {
      filename: updated.filename, retentionType: updated.retention_type, expiresAt: updated.expires_at?.toISOString() ?? null,
    } });
    return updated;
  });
  return present(edited, deps);
}

export async function deleteFile(deps: FileDeps, caller: Caller, id: string) {
  if (!isUuid(id)) throw new HttpError(404, 'File not found');
  await deps.db.transaction(async tx => {
    // Serialize deletion with confirmation, edits and Link changes.
    const [row] = await tx.select().from(files).where(eq(files.id, id)).for('update');
    if (!row) throw new HttpError(404, 'File not found');
    if (row.status === 'deleted') return;
    // Remove every object before committing Deleted, so a storage failure can be retried.
    await deps.store.deletePrefix(bucketOf(row), `${row.id}/`);
    await tx.delete(fileLinks).where(eq(fileLinks.file_id, id));
    await tx.update(files).set({ status: 'deleted' }).where(eq(files.id, id));
    await writeAudit(tx, { action: 'file.deleted', fileId: id, ...caller });
  });
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

export async function listFiles(deps: FileDeps, query: z.output<typeof recordQuery>) {
  await checkRecord(deps.db, query);
  const { page, role } = query;
  const matchingLinks = deps.db.select({ id: fileLinks.file_id }).from(fileLinks).where(and(
    eq(fileLinks.system, query.system), eq(fileLinks.entity_type, query.entityType),
    eq(fileLinks.entity_id, query.entityId), role === undefined ? undefined : eq(fileLinks.role, role),
  ));
  const rows = await deps.db.select().from(files).where(and(
    inArray(files.id, matchingLinks), eq(files.status, 'active'), page === undefined ? undefined : gt(files.id, page),
    or(isNull(files.expires_at), gt(files.expires_at, new Date())),
  )).orderBy(files.id).limit(51);
  const pageRows = rows.slice(0, 50);
  return {
    files: await Promise.all(pageRows.map(row => present(row, deps))),
    nextPage: rows.length > 50 ? pageRows[49]!.id : null,
  };
}
