CREATE TABLE client_systems (
  code text PRIMARY KEY
);
INSERT INTO client_systems (code) VALUES ('POS'), ('CRMS'), ('IMS'), ('HRMS'), ('ECOM');

CREATE TABLE file_audit_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  file_id uuid,
  system_code text NOT NULL REFERENCES client_systems (code),
  actor_id text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_audit_entries_file_id ON file_audit_entries (file_id);
