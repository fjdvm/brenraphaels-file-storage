-- Audit entries may name the cron as the actor, which is not a Client System.
ALTER TABLE file_audit_entries DROP CONSTRAINT IF EXISTS file_audit_entries_system_code_fkey;
