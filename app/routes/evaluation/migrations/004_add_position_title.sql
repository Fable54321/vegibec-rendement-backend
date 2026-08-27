BEGIN;
ALTER TABLE evaluation.evaluations ADD COLUMN IF NOT EXISTS position_title TEXT;
UPDATE evaluation.evaluations SET position_title = 'No especificado' WHERE position_title IS NULL OR BTRIM(position_title) = '';
ALTER TABLE evaluation.evaluations ALTER COLUMN position_title SET NOT NULL;
ALTER TABLE evaluation.evaluations DROP CONSTRAINT IF EXISTS evaluations_position_title_not_blank;
ALTER TABLE evaluation.evaluations ADD CONSTRAINT evaluations_position_title_not_blank CHECK (BTRIM(position_title) <> '');
COMMIT;
