import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { fileAuditEntries } from '../db/schema.ts';

export interface AuditEntry {
  action: string;
  fileId?: string;
  systemCode: string;
  actorId?: string | null;
  detail?: Record<string, unknown>;
}

// The only place file audit entries are created.
export async function writeAudit(db: NodePgDatabase, entry: AuditEntry): Promise<void> {
  await db.insert(fileAuditEntries).values({
    action: entry.action, file_id: entry.fileId ?? null, system_code: entry.systemCode,
    actor_id: entry.actorId ?? null, detail: entry.detail ?? null,
  });
}
