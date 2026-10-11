CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  retention_type text NOT NULL CHECK (retention_type IN ('permanent', 'temporary')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  created_by_system text NOT NULL REFERENCES client_systems (code),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  expires_at timestamptz
);
