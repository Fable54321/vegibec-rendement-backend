BEGIN;

CREATE SCHEMA IF NOT EXISTS evaluation;

CREATE TABLE IF NOT EXISTS evaluation.evaluations (
  id BIGSERIAL PRIMARY KEY,
  evaluator_worker_id INTEGER NOT NULL REFERENCES public.users(id),
  evaluated_worker_id INTEGER NOT NULL REFERENCES public.users(id),
  submitted_by_user_id INTEGER NOT NULL REFERENCES public.users(id),
  work_type TEXT NOT NULL CHECK (work_type IN ('campo', 'bodega')),
  evaluation_year SMALLINT NOT NULL CHECK (evaluation_year BETWEEN 2000 AND 2200),
  evaluation_period TEXT NOT NULL DEFAULT 'mid_season',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (evaluator_worker_id <> evaluated_worker_id)
);

CREATE TABLE IF NOT EXISTS evaluation.rating_answers (
  id BIGSERIAL PRIMARY KEY,
  evaluation_id BIGINT NOT NULL REFERENCES evaluation.evaluations(id) ON DELETE CASCADE,
  section CHAR(1) NOT NULL CHECK (section IN ('A', 'B')),
  criterion_key TEXT NOT NULL,
  criterion_label TEXT NOT NULL,
  score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 2),
  UNIQUE (evaluation_id, section, criterion_key)
);

CREATE TABLE IF NOT EXISTS evaluation.performance_measurements (
  evaluation_id BIGINT PRIMARY KEY REFERENCES evaluation.evaluations(id) ON DELETE CASCADE,
  evaluation_date DATE NOT NULL,
  field_number TEXT,
  crop TEXT NOT NULL,
  weather_conditions TEXT,
  terrain_conditions TEXT,
  harvest_number SMALLINT NOT NULL CHECK (harvest_number BETWEEN 1 AND 3),
  task TEXT NOT NULL,
  other_task TEXT,
  task_specification TEXT NOT NULL,
  duration_minutes SMALLINT NOT NULL DEFAULT 15 CHECK (duration_minutes > 0),
  quantity NUMERIC(12, 2) NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  observations TEXT,
  final_score SMALLINT NOT NULL CHECK (final_score BETWEEN 0 AND 2),
  CHECK (task <> 'Otro' OR NULLIF(BTRIM(other_task), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS evaluations_evaluated_worker_idx ON evaluation.evaluations (evaluated_worker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS evaluations_evaluator_worker_idx ON evaluation.evaluations (evaluator_worker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rating_answers_evaluation_idx ON evaluation.rating_answers (evaluation_id);

CREATE OR REPLACE VIEW evaluation.evaluation_scores AS
SELECT
  e.id AS evaluation_id,
  COALESCE(SUM(r.score) FILTER (WHERE r.section = 'A'), 0)::INTEGER AS section_a_score,
  (COUNT(r.id) FILTER (WHERE r.section = 'A') * 2)::INTEGER AS section_a_max_score,
  COALESCE(SUM(r.score) FILTER (WHERE r.section = 'B'), 0)::INTEGER AS section_b_score,
  (COUNT(r.id) FILTER (WHERE r.section = 'B') * 2)::INTEGER AS section_b_max_score,
  pm.final_score AS section_c_score,
  2 AS section_c_max_score,
  (COALESCE(SUM(r.score), 0) + pm.final_score)::INTEGER AS total_score,
  ((COUNT(r.id) * 2) + 2)::INTEGER AS maximum_score
FROM evaluation.evaluations e
JOIN evaluation.performance_measurements pm ON pm.evaluation_id = e.id
LEFT JOIN evaluation.rating_answers r ON r.evaluation_id = e.id
GROUP BY e.id, pm.final_score;

COMMIT;
