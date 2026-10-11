import { pgTable, text, timestamp, uuid, jsonb, bigint } from 'drizzle-orm/pg-core';
export const clientSystems = pgTable('client_systems', { code: text().primaryKey() });
export const fileAuditEntries = pgTable('file_audit_entries', {
  id: uuid().primaryKey().defaultRandom(), action: text().notNull(), file_id: uuid(),
  system_code: text().notNull(), actor_id: text(),
  detail: jsonb().$type<Record<string, unknown>>(),
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
export const files = pgTable('files', {
  id: uuid().primaryKey().defaultRandom(), filename: text().notNull(), content_type: text().notNull(),
  size: bigint({ mode: 'number' }).notNull(),
  visibility: text().$type<'public' | 'private'>().notNull(),
  retention_type: text().$type<'permanent' | 'temporary'>().notNull(),
  status: text().$type<'pending' | 'active'>().notNull().default('pending'),
  created_by_system: text().notNull(),
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  confirmed_at: timestamp({ withTimezone: true }),
  expires_at: timestamp({ withTimezone: true }),
});
