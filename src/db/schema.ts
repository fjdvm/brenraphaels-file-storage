import { pgTable, text, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';
export const clientSystems = pgTable('client_systems', { code: text().primaryKey() });
export const fileAuditEntries = pgTable('file_audit_entries', {
  id: uuid().primaryKey().defaultRandom(), action: text().notNull(), file_id: uuid(),
  system_code: text().notNull(), actor_id: text(),
  detail: jsonb().$type<Record<string, unknown>>(),
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
