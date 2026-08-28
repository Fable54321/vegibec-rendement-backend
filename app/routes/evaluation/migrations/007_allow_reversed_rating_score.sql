BEGIN;

ALTER TABLE evaluation.rating_answers
  DROP CONSTRAINT IF EXISTS rating_answers_score_check;

ALTER TABLE evaluation.rating_answers
  ADD CONSTRAINT rating_answers_score_check CHECK (score IN (0, 1, 2, 3));

COMMENT ON COLUMN evaluation.rating_answers.score IS
  'Polarity-adjusted score. Positive questions use 0/2/3; negative questions use 3/1/0.';

COMMIT;
