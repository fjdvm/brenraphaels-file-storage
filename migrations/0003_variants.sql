ALTER TABLE files ADD COLUMN variants jsonb NOT NULL DEFAULT '[]'::jsonb;
