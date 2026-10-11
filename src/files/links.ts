import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { clientSystems, fileLinks, files } from '../db/schema.ts';
import { writeAudit } from '../audit/write-audit.ts';
import { HttpError } from '../http/errors.ts';
import type { Caller, FileDeps } from './files.ts';
import { isUuid, linkInput } from './schemas.ts';
import type { z } from 'zod';

export type Link = z.output<typeof linkInput>;

export async function checkRecord(db: NodePgDatabase, record: { system: string }) {
  const [known] = await db.select().from(clientSystems).where(eq(clientSystems.code, record.system));
  if (!known) throw new HttpError(400, 'Unknown Link system');
}

export async function insertLink(db: NodePgDatabase, caller: Caller, fileId: string, link: Link) {
  const inserted = await db.insert(fileLinks).values({
    file_id: fileId, system: link.system, entity_type: link.entityType, entity_id: link.entityId, role: link.role,
  }).onConflictDoNothing().returning();
  if (inserted.length) await writeAudit(db, { action: 'file.link.added', fileId, ...caller, detail: { ...link } });
}

export async function changeLink(deps: FileDeps, caller: Caller, id: string, link: Link, operation: 'add' | 'remove') {
  if (!isUuid(id)) throw new HttpError(404, 'File not found');
  await checkRecord(deps.db, link);
  await deps.db.transaction(async tx => {
    const [row] = await tx.select().from(files).where(eq(files.id, id)).for('update');
    if (!row || row.status !== 'active' || (row.expires_at && row.expires_at <= new Date())) throw new HttpError(404, 'File not found');
    if (operation === 'add') {
      await insertLink(tx, caller, id, link);
    } else {
      const removed = await tx.delete(fileLinks).where(and(
        eq(fileLinks.file_id, id), eq(fileLinks.system, link.system),
        eq(fileLinks.entity_type, link.entityType), eq(fileLinks.entity_id, link.entityId), eq(fileLinks.role, link.role),
      )).returning();
      if (removed.length) await writeAudit(tx, { action: 'file.link.removed', fileId: id, ...caller, detail: { ...link } });
    }
  });
}
