import { and, eq, isNotNull, lte, lt, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { fileLinks, files } from '../db/schema.ts';
import { writeAudit } from '../audit/write-audit.ts';
import type { Caller } from './files.ts';
import type { Bucket, ObjectStore } from '../storage/object-store.ts';

export const STALE_UPLOAD_HOURS = 24;
// Bounds one run so it fits a serverless time limit; anything left over is picked up by the next run.
export const BATCH_SIZE = 200;
export const CRON_CALLER: Caller = { systemCode: 'CRON', actorId: 'cron' };

export interface CleanupResult { expiredDeleted: number; pendingDiscarded: number; replacementsDiscarded: number; failures: number }

// Each File is handled in its own transaction under its row lock, re-checking the condition so a concurrent
// confirm, promotion or replacement is never undone. A failure on one File does not stop the others.
export async function runCleanup(deps: { db: NodePgDatabase; store: ObjectStore }, now = new Date()): Promise<CleanupResult> {
  const { db, store } = deps;
  const staleBefore = new Date(now.getTime() - STALE_UPLOAD_HOURS * 3_600_000);
  const result: CleanupResult = { expiredDeleted: 0, pendingDiscarded: 0, replacementsDiscarded: 0, failures: 0 };
  const tally = async (counter: 'expiredDeleted' | 'pendingDiscarded' | 'replacementsDiscarded', work: () => Promise<boolean>) => {
    try { if (await work()) result[counter]++; } catch (error) { result.failures++; console.error(error); }
  };
  const lockFile = (tx: NodePgDatabase, id: string) => tx.select().from(files).where(eq(files.id, id)).for('update').then(rows => rows[0]);

  const expired = await db.select({ id: files.id }).from(files)
    .where(and(eq(files.retention_type, 'temporary'), isNotNull(files.expires_at), lte(files.expires_at, now), or(eq(files.status, 'active'), eq(files.status, 'pending')))).limit(BATCH_SIZE);
  for (const { id } of expired) await tally('expiredDeleted', () => db.transaction(async tx => {
    const row = await lockFile(tx, id);
    if (!row || row.status === 'deleted' || !row.expires_at || row.expires_at > now) return false;
    await store.deletePrefix(row.visibility as Bucket, `${id}/`);
    await tx.delete(fileLinks).where(eq(fileLinks.file_id, id));
    await tx.update(files).set({ status: 'deleted' }).where(eq(files.id, id));
    await writeAudit(tx, { action: 'file.deleted', fileId: id, ...CRON_CALLER, detail: { reason: 'expired' } });
    return true;
  }));

  const stale = await db.select({ id: files.id }).from(files).where(and(eq(files.status, 'pending'), lt(files.created_at, staleBefore))).limit(BATCH_SIZE);
  for (const { id } of stale) await tally('pendingDiscarded', () => db.transaction(async tx => {
    const row = await lockFile(tx, id);
    if (!row || row.status !== 'pending' || row.created_at >= staleBefore) return false;
    await store.deletePrefix(row.visibility as Bucket, `${id}/`);
    await tx.delete(files).where(eq(files.id, id));
    await writeAudit(tx, { action: 'file.pending_discarded', fileId: id, ...CRON_CALLER });
    return true;
  }));

  const replacing = await db.select({ id: files.id }).from(files).where(and(eq(files.status, 'active'), isNotNull(files.replacement))).limit(BATCH_SIZE);
  for (const { id } of replacing) await tally('replacementsDiscarded', () => db.transaction(async tx => {
    const row = await lockFile(tx, id);
    const requested = row?.replacement;
    if (!row || row.status !== 'active' || !requested) return false;
    if (!requested.requestedAt) {
      // Requested before the time was recorded: start its 24 hours now rather than risk discarding an upload in flight.
      await tx.update(files).set({ replacement: { ...requested, requestedAt: now.toISOString() } }).where(eq(files.id, id));
      return false;
    }
    if (new Date(requested.requestedAt) >= staleBefore) return false;
    await store.delete(row.visibility as Bucket, `${id}/replacement`);
    await tx.update(files).set({ replacement: null }).where(eq(files.id, id));
    await writeAudit(tx, { action: 'file.replacement_discarded', fileId: id, ...CRON_CALLER });
    return true;
  }));
  return result;
}
