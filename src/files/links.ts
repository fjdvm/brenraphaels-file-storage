import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { clientSystems, fileLinks, files } from '../db/schema.ts';
import { writeAudit } from '../audit/write-audit.ts';
import { HttpError } from '../http/errors.ts';
import type { Caller, FileDeps } from './files.ts';

export interface Link { system: string; entityType: string; entityId: string; role: string }

export function requiredText(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string`);
  return value.trim();
}

export async function parseRecord(db: NodePgDatabase, input: Record<string, unknown>) {
  const system = requiredText(input, 'system');
  const entityType = requiredText(input, 'entityType');
  const entityId = requiredText(input, 'entityId');
  const [known] = await db.select().from(clientSystems).where(eq(clientSystems.code, system));
  if (!known) throw new HttpError(400, 'Unknown Link system');
  return { system, entityType, entityId };
}

export async function parseLink(db: NodePgDatabase, input: unknown): Promise<Link> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'link must be an object');
  const body = input as Record<string, unknown>;
  return { ...await parseRecord(db, body), role: requiredText(body, 'role') };
}

export async function insertLink(db: NodePgDatabase, caller: Caller, fileId: string, link: Link) {
  const inserted = await db.insert(fileLinks).values({
    file_id: fileId, system: link.system, entity_type: link.entityType, entity_id: link.entityId, role: link.role,
  }).onConflictDoNothing().returning();
  if (inserted.length) await writeAudit(db, { action: 'file.link.added', fileId, ...caller, detail: { ...link } });
}

export async function changeLink(deps: FileDeps, caller: Caller, id: string, input: unknown, operation: 'add' | 'remove') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(404, 'File not found');
  const link = await parseLink(deps.db, input);
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
