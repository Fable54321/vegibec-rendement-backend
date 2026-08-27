BEGIN;

DROP VIEW IF EXISTS evaluation.evaluation_scores;

CREATE VIEW evaluation.evaluation_scores AS
WITH raw_scores AS (
  SELECT
    e.id AS evaluation_id,
    COALESCE(SUM(r.score) FILTER (WHERE r.section = 'A'), 0)::INTEGER AS section_a_score,
    (COUNT(r.id) FILTER (WHERE r.section = 'A') * 2)::INTEGER AS section_a_max_score,
    COALESCE(SUM(r.score) FILTER (WHERE r.section = 'B'), 0)::INTEGER AS section_b_score,
    (COUNT(r.id) FILTER (WHERE r.section = 'B') * 2)::INTEGER AS section_b_max_score,
    pm.final_score::INTEGER AS section_c_score,
    2 AS section_c_max_score
  FROM evaluation.evaluations e
  JOIN evaluation.performance_measurements pm ON pm.evaluation_id = e.id
  LEFT JOIN evaluation.rating_answers r ON r.evaluation_id = e.id
  GROUP BY e.id, pm.final_score
)
SELECT
  *,
  ROUND(section_a_score::NUMERIC / NULLIF(section_a_max_score, 0) * 40, 2) AS section_a_weighted_score,
  ROUND(section_b_score::NUMERIC / NULLIF(section_b_max_score, 0) * 40, 2) AS section_b_weighted_score,
  ROUND(section_c_score::NUMERIC / section_c_max_score * 20, 2) AS section_c_weighted_score,
  ROUND(
    section_a_score::NUMERIC / NULLIF(section_a_max_score, 0) * 40 +
    section_b_score::NUMERIC / NULLIF(section_b_max_score, 0) * 40 +
    section_c_score::NUMERIC / section_c_max_score * 20,
    2
  ) AS total_weighted_score,
  100 AS maximum_weighted_score
FROM raw_scores;

COMMENT ON VIEW evaluation.evaluation_scores IS
  'Normalized evaluation scoring: Section A 40%, Section B 40%, Section C 20%; total is out of 100.';

COMMIT;
