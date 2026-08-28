BEGIN;

ALTER TABLE evaluation.performance_measurements
  ADD COLUMN IF NOT EXISTS other_crop TEXT;

DROP VIEW IF EXISTS evaluation.evaluation_scores;

CREATE VIEW evaluation.evaluation_scores AS
WITH raw_scores AS (
  SELECT
    e.id AS evaluation_id,
    COALESCE(SUM(r.score) FILTER (WHERE r.section = 'A'), 0)::INTEGER AS section_a_score,
    (COUNT(r.id) FILTER (WHERE r.section = 'A') * 3)::INTEGER AS section_a_max_score,
    pm.final_score::INTEGER AS section_b_score,
    3 AS section_b_max_score
  FROM evaluation.evaluations e
  JOIN evaluation.performance_measurements pm ON pm.evaluation_id = e.id
  LEFT JOIN evaluation.rating_answers r ON r.evaluation_id = e.id
  GROUP BY e.id, pm.final_score
)
SELECT
  *,
  ROUND(section_a_score::NUMERIC / NULLIF(section_a_max_score, 0) * 70, 2) AS section_a_weighted_score,
  ROUND(section_b_score::NUMERIC / section_b_max_score * 30, 2) AS section_b_weighted_score,
  ROUND(
    section_a_score::NUMERIC / NULLIF(section_a_max_score, 0) * 70 +
    section_b_score::NUMERIC / section_b_max_score * 30,
    2
  ) AS total_weighted_score,
  100 AS maximum_weighted_score
FROM raw_scores;

COMMENT ON VIEW evaluation.evaluation_scores IS
  'Two-section evaluation: polarity-adjusted behavior questions in Section A (70%) and performance measurement in Section B (30%).';

COMMIT;
