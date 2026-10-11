import { pgTable, text, timestamp, uuid, jsonb, bigint, primaryKey, index } from 'drizzle-orm/pg-core';
import type { Variant } from '../files/variants.ts';
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
  variants: jsonb().$type<Variant[]>().notNull().default([]),
  replacement: jsonb().$type<{ contentType: string; size: number }>(),
});

export const fileLinks = pgTable('file_links', {
  file_id: uuid().notNull().references(() => files.id, { onDelete: 'cascade' }),
  system: text().notNull().references(() => clientSystems.code),
  entity_type: text().notNull(), entity_id: text().notNull(), role: text().notNull(),
}, table => [
  primaryKey({ columns: [table.file_id, table.system, table.entity_type, table.entity_id, table.role] }),
  index('file_links_record').on(table.system, table.entity_type, table.entity_id, table.role, table.file_id),
]);
