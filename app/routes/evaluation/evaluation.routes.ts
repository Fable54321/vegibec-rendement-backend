import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const access = requireAppRole("evaluacion", ["admin", "user"]);

const gradeScores = { needs_work: 0, good: 2, excellent: 3 } as const;
type Grade = keyof typeof gradeScores;

const campoOnlyQuestionNumbers = new Set([2, 3, 15, 20, 21, 28, 29]);
const negativeQuestionNumbers = new Set([
  1, 2, 9, 13, 14, 15, 16, 17, 18, 28, 29, 34,
]);
const sectionAQuestionKeys = Array.from(
  { length: 37 },
  (_, index) => `question_${index + 1}`,
);
const allCrops = new Set([
  "Apio",
  "Chile pimiento",
  "Coliflor",
  "Lechuga romana",
  "Lechuga bola",
  "Lechuga rizada",
  "Coles de Bruselas",
  "Repollo",
  "Repollo plano",
  "Col (repollo) de Saboya",
  "Zucchini",
  "Corazón de romana",
  "Otro",
]);
const bodegaCrops = new Set([
  "Chile pimiento",
  "Coliflor",
  "Coles de Bruselas",
  "Repollo",
  "Repollo plano",
  "Zucchini",
  "Otro",
]);
const allTasks = new Set([
  "Cosecha",
  "Empaque (campo)",
  "Empaque (bodega)",
  "Ensamblador de cajas",
  "Plantación",
  "Esquivada",
  "Conductor de maquinaria",
  "Fletero",
  "Deshierbada",
  "Piedra",
  "Piochada",
  "Otro",
]);
const bodegaTasks = new Set([
  "Empaque (bodega)",
  "Ensamblador de cajas",
  "Esquivada",
  "Otro",
]);

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const integer = (value: unknown) =>
  Number.isInteger(Number(value)) ? Number(value) : null;
const gradeScore = (value: unknown) =>
  typeof value === "string" && value in gradeScores
    ? gradeScores[value as Grade]
    : null;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

function validateSectionAQuestions(values: unknown, keys: string[]) {
  if (!isRecord(values)) throw new Error("La Sección A no es válida.");
  return keys.map((key) => {
    const questionNumber = Number(key.slice(9));
    const rawScore = gradeScore(values[key]);
    if (rawScore === null)
      throw new Error(`Falta una calificación válida para A.${key}.`);
    const score = negativeQuestionNumbers.has(questionNumber)
      ? 3 - rawScore
      : rawScore;
    return { section: "A", key, label: `Pregunta ${questionNumber}`, score };
  });
}

router.post("/", access, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.user)
      return res.status(401).json({ message: "Not authenticated" });
    if (!isRecord(req.body))
      return res.status(400).json({ message: "Invalid request body" });

    const evaluatorId = integer(req.body.evaluatorId);
    const evaluatedWorkerId = integer(req.body.evaluatedWorkerId);
    const clientSubmissionId = req.body.clientSubmissionId;
    const workType = req.body.workType;
    const positionTitle = text(req.body.positionTitle);
    const sectionC = req.body.sectionC;
    const permanence = req.body.permanence;
    if (!evaluatorId || !evaluatedWorkerId || evaluatorId === evaluatedWorkerId)
      throw new Error("Los trabajadores seleccionados no son válidos.");
    if (!isUuid(clientSubmissionId))
      throw new Error("El identificador de envío no es válido.");
    if (workType !== "campo" && workType !== "bodega")
      throw new Error("El tipo de trabajo no es válido.");
    if (!positionTitle || positionTitle.length > 150)
      throw new Error("El puesto no es válido.");
    if (!isRecord(sectionC)) throw new Error("La Sección B no es válida.");
    if (!isRecord(permanence)) throw new Error("La Sección C no es válida.");

    const requiredAKeys = sectionAQuestionKeys.filter(
      (_, index) =>
        workType === "campo" || !campoOnlyQuestionNumbers.has(index + 1),
    );
    const sectionA = validateSectionAQuestions(
      req.body.sectionB,
      requiredAKeys,
    );
    const evaluationDate = text(sectionC.evaluationDate);
    const crop = text(sectionC.crop);
    const otherCrop = text(sectionC.otherCrop);
    const task = text(sectionC.task);
    const otherTask = text(sectionC.otherTask);
    const taskSpecification = text(sectionC.taskSpecification);
    const unit = text(sectionC.unit);
    const harvestNumber = integer(sectionC.harvestNumber);
    const quantity = Number(sectionC.quantity);
    const finalScore = gradeScore(sectionC.finalRating);
    const recommendNextSeason = permanence.recommendNextSeason;
    const permanenceExplanation = text(permanence.explanation);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(evaluationDate) ||
      !crop ||
      !task ||
      !taskSpecification ||
      !unit ||
      !harvestNumber ||
      harvestNumber < 1 ||
      harvestNumber > 3 ||
      !Number.isInteger(quantity * 2) ||
      quantity < 0.5 ||
      finalScore === null
    )
      throw new Error(
        "Faltan datos obligatorios o hay valores inválidos en la Sección B.",
      );
    if (task === "Otro" && !otherTask)
      throw new Error("Debe especificar la otra tarea.");
    if (crop === "Otro" && !otherCrop)
      throw new Error("Debe especificar el otro tipo de cultivo.");
    if (!(workType === "bodega" ? bodegaCrops : allCrops).has(crop))
      throw new Error("El cultivo no es válido para el tipo de trabajo.");
    if (!(workType === "bodega" ? bodegaTasks : allTasks).has(task))
      throw new Error("La tarea no es válida para el tipo de trabajo.");
    if (
      (recommendNextSeason !== "yes" && recommendNextSeason !== "no") ||
      !permanenceExplanation ||
      permanenceExplanation.length > 2000
    )
      throw new Error(
        "Faltan datos obligatorios o hay valores inválidos en la Sección C.",
      );

    await client.query("BEGIN");
    const workers = await client.query<{
      id: number;
      job_id_1: number | null;
      job_id_2: number | null;
    }>(
      `SELECT u.id, fwd.job_id_1, fwd.job_id_2 FROM users u JOIN foreign_workers_info fwi ON fwi.user_id = u.id LEFT JOIN foreign_workers_schedule.foreign_workers_details fwd ON fwd.user_id = u.id WHERE u.id = ANY($1::int[])`,
      [[evaluatorId, evaluatedWorkerId]],
    );
    if (workers.rowCount !== 2)
      throw new Error("Uno de los trabajadores seleccionados no existe.");
    const evaluator = workers.rows.find((worker) => worker.id === evaluatorId);
    const evaluatedWorker = workers.rows.find(
      (worker) => worker.id === evaluatedWorkerId,
    );
    if (!evaluator || (evaluator.job_id_1 !== 6 && evaluator.job_id_2 !== 6))
      throw new Error(
        "El evaluador seleccionado no tiene el puesto requerido.",
      );
    if (
      !evaluatedWorker ||
      evaluatedWorker.job_id_1 === 6 ||
      evaluatedWorker.job_id_2 === 6
    )
      throw new Error("La persona evaluada no puede ser un evaluador.");

    const evaluationResult = await client.query<{
      id: string;
      inserted: boolean;
    }>(
      `INSERT INTO evaluation.evaluations (evaluator_worker_id, evaluated_worker_id, submitted_by_user_id, work_type, position_title, evaluation_year, client_submission_id) VALUES ($1, $2, $3, $4, $5, EXTRACT(YEAR FROM $6::date), $7) ON CONFLICT (client_submission_id) WHERE client_submission_id IS NOT NULL DO UPDATE SET client_submission_id = EXCLUDED.client_submission_id RETURNING id, (xmax = 0) AS inserted`,
      [
        evaluatorId,
        evaluatedWorkerId,
        req.user.id,
        workType,
        positionTitle,
        evaluationDate,
        clientSubmissionId,
      ],
    );
    const evaluationId = evaluationResult.rows[0].id;
    if (!evaluationResult.rows[0].inserted) {
      await client.query("COMMIT");
      const existingScores = await pool.query(
        `SELECT * FROM evaluation.evaluation_scores WHERE evaluation_id = $1`,
        [evaluationId],
      );
      return res
        .status(200)
        .json({
          evaluationId,
          scores: existingScores.rows[0],
          deduplicated: true,
        });
    }
    for (const answer of sectionA) {
      await client.query(
        `INSERT INTO evaluation.rating_answers (evaluation_id, section, criterion_key, criterion_label, score) VALUES ($1, $2, $3, $4, $5)`,
        [evaluationId, answer.section, answer.key, answer.label, answer.score],
      );
    }
    await client.query(
      `INSERT INTO evaluation.performance_measurements (evaluation_id, evaluation_date, field_number, crop, other_crop, weather_conditions, terrain_conditions, harvest_number, task, other_task, task_specification, quantity, unit, observations, final_score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        evaluationId,
        evaluationDate,
        workType === "campo" ? text(sectionC.fieldNumber) || null : null,
        crop,
        crop === "Otro" ? otherCrop : null,
        workType === "campo" ? text(sectionC.weatherConditions) || null : null,
        workType === "campo" ? text(sectionC.terrainConditions) || null : null,
        harvestNumber,
        task,
        task === "Otro" ? otherTask : null,
        taskSpecification,
        quantity,
        unit,
        text(sectionC.observations) || null,
        finalScore,
      ],
    );
    await client.query(
      `INSERT INTO evaluation.permanence_evaluations (evaluation_id, recommend_next_season, explanation) VALUES ($1, $2, $3)`,
      [evaluationId, recommendNextSeason === "yes", permanenceExplanation],
    );
    await client.query("COMMIT");
    const saved = await pool.query(
      `SELECT * FROM evaluation.evaluation_scores WHERE evaluation_id = $1`,
      [evaluationId],
    );
    return res
      .status(201)
      .json({ evaluationId, scores: saved.rows[0], deduplicated: false });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const message =
      error instanceof Error ? error.message : "Unable to save evaluation";
    console.error("Save evaluation error:", error);
    return res
      .status(
        message.includes("invalid") ||
          message.includes("válid") ||
          message.includes("Faltan") ||
          message.includes("Debe") ||
          message.includes("trabajador")
          ? 400
          : 500,
      )
      .json({ message });
  } finally {
    client.release();
  }
});

router.get("/", access, async (_req, res) => {
  try {
    const evaluations = await pool.query(
      `SELECT
        e.id,
        e.work_type,
        e.position_title,
        e.evaluation_year,
        e.created_at,
        evaluated.id AS evaluated_worker_id,
        evaluated.name AS evaluated_worker_name,
        evaluated.surname AS evaluated_worker_surname,
        evaluator.id AS evaluator_worker_id,
        evaluator.name AS evaluator_worker_name,
        evaluator.surname AS evaluator_worker_surname,
        pm.evaluation_date,
        pm.field_number,
        pm.crop,
        pm.other_crop,
        pm.task,
        pm.other_task,
        pm.task_specification,
        pm.quantity,
        pm.unit,
        pm.final_score,
        pe.recommend_next_season,
        ROUND(
          (COALESCE(scores.questionnaire_average, 0) / 3 * 70) +
          (pm.final_score::numeric / 3 * 30),
          2
        ) AS overall_score
      FROM evaluation.evaluations e
      JOIN users evaluated ON evaluated.id = e.evaluated_worker_id
      JOIN users evaluator ON evaluator.id = e.evaluator_worker_id
      JOIN evaluation.performance_measurements pm ON pm.evaluation_id = e.id
      JOIN evaluation.permanence_evaluations pe ON pe.evaluation_id = e.id
      LEFT JOIN LATERAL (
        SELECT AVG(ra.score)::numeric AS questionnaire_average
        FROM evaluation.rating_answers ra
        WHERE ra.evaluation_id = e.id
      ) scores ON true
      ORDER BY pm.evaluation_date DESC, e.created_at DESC`,
    );

    return res.json({ evaluations: evaluations.rows });
  } catch (error) {
    console.error("Get evaluations error:", error);
    return res.status(500).json({ message: "Unable to load evaluations" });
  }
});

router.get("/:id", access, async (req, res) => {
  const id = integer(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid evaluation id" });
  try {
    const header = await pool.query(
      `SELECT e.*, s.* FROM evaluation.evaluations e JOIN evaluation.evaluation_scores s ON s.evaluation_id = e.id WHERE e.id = $1`,
      [id],
    );
    if (!header.rowCount)
      return res.status(404).json({ message: "Evaluation not found" });
    const [ratings, measurement, permanence] = await Promise.all([
      pool.query(
        `SELECT section, criterion_key, criterion_label, score FROM evaluation.rating_answers WHERE evaluation_id = $1 ORDER BY section, id`,
        [id],
      ),
      pool.query(
        `SELECT * FROM evaluation.performance_measurements WHERE evaluation_id = $1`,
        [id],
      ),
      pool.query(
        `SELECT recommend_next_season, explanation FROM evaluation.permanence_evaluations WHERE evaluation_id = $1`,
        [id],
      ),
    ]);
    return res.json({
      evaluation: header.rows[0],
      ratings: ratings.rows,
      sectionB: measurement.rows[0],
      sectionC: permanence.rows[0],
    });
  } catch (error) {
    console.error("Get evaluation error:", error);
    return res.status(500).json({ message: "Unable to load evaluation" });
  }
});

export default router;
