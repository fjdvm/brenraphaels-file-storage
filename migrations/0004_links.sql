CREATE TABLE file_links (
  file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  system text NOT NULL REFERENCES client_systems (code),
  entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_id text NOT NULL CHECK (btrim(entity_id) <> ''),
  role text NOT NULL CHECK (btrim(role) <> ''),
  PRIMARY KEY (file_id, system, entity_type, entity_id, role)
);
CREATE INDEX file_links_record ON file_links (system, entity_type, entity_id, role, file_id);
