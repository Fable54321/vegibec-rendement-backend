import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const access = requireAppRole("main", ["admin", "user", "guest"]);

const gradeScores = { needs_work: 0, good: 2, excellent: 3 } as const;
type Grade = keyof typeof gradeScores;

const sectionACriteria: Record<string, string> = {
  puntualidad: "Puntualidad", competencias_tecnicas: "Competencias técnicas",
  coherencia: "Coherencia", adaptabilidad: "Adaptabilidad", asistencia: "Asistencia",
  comunicacion: "Comunicación", cooperacion_equipo: "Cooperación en equipo",
  productividad_calidad: "Productividad y calidad del trabajo", responsabilidad: "Responsabilidad",
};
const campoOnlyQuestionNumbers = new Set([2, 3, 15, 20, 21, 28, 29]);
const sectionBKeys = Array.from({ length: 37 }, (_, index) => `question_${index + 1}`);
const allCrops = new Set(["Apio", "Chile pimiento", "Coliflor", "Lechuga romana", "Lechuga bola", "Lechuga rizada", "Coles de Bruselas", "Repollo", "Repollo plano", "Col (repollo) de Saboya", "Zucchini", "Corazón de romana"]);
const bodegaCrops = new Set(["Chile pimiento", "Coliflor", "Coles de Bruselas", "Repollo", "Repollo plano", "Zucchini"]);
const allTasks = new Set(["Cosecha", "Empaque (campo)", "Empaque (bodega)", "Ensamblador de cajas", "Plantación", "Esquivada", "Conductor de maquinaria", "Fletero", "Deshierbada", "Piedra", "Piochada", "Otro"]);
const bodegaTasks = new Set(["Empaque (bodega)", "Ensamblador de cajas", "Esquivada", "Otro"]);

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const integer = (value: unknown) => Number.isInteger(Number(value)) ? Number(value) : null;
const gradeScore = (value: unknown) => typeof value === "string" && value in gradeScores ? gradeScores[value as Grade] : null;

function validateRatings(values: unknown, keys: string[], section: "A" | "B") {
  if (!isRecord(values)) throw new Error(`La Sección ${section} no es válida.`);
  return keys.map((key) => {
    const score = gradeScore(values[key]);
    if (score === null) throw new Error(`Falta una calificación válida para ${section}.${key}.`);
    return { section, key, label: section === "A" ? sectionACriteria[key] : `Pregunta ${key.slice(9)}`, score };
  });
}

router.post("/", access, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.user) return res.status(401).json({ message: "Not authenticated" });
    if (!isRecord(req.body)) return res.status(400).json({ message: "Invalid request body" });

    const evaluatorId = integer(req.body.evaluatorId);
    const evaluatedWorkerId = integer(req.body.evaluatedWorkerId);
    const workType = req.body.workType;
    const sectionC = req.body.sectionC;
    if (!evaluatorId || !evaluatedWorkerId || evaluatorId === evaluatedWorkerId) throw new Error("Los trabajadores seleccionados no son válidos.");
    if (workType !== "campo" && workType !== "bodega") throw new Error("El tipo de trabajo no es válido.");
    if (!isRecord(sectionC)) throw new Error("La Sección C no es válida.");

    const sectionA = validateRatings(req.body.sectionA, Object.keys(sectionACriteria), "A");
    const requiredBKeys = sectionBKeys.filter((_, index) => workType === "campo" || !campoOnlyQuestionNumbers.has(index + 1));
    const sectionB = validateRatings(req.body.sectionB, requiredBKeys, "B");
    const evaluationDate = text(sectionC.evaluationDate);
    const crop = text(sectionC.crop);
    const task = text(sectionC.task);
    const otherTask = text(sectionC.otherTask);
    const taskSpecification = text(sectionC.taskSpecification);
    const unit = text(sectionC.unit);
    const harvestNumber = integer(sectionC.harvestNumber);
    const quantity = Number(sectionC.quantity);
    const finalScore = gradeScore(sectionC.finalRating);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(evaluationDate) || !crop || !task || !taskSpecification || !unit || !harvestNumber || harvestNumber < 1 || harvestNumber > 3 || !Number.isFinite(quantity) || quantity < 0 || finalScore === null) throw new Error("Faltan datos obligatorios o hay valores inválidos en la Sección C.");
    if (task === "Otro" && !otherTask) throw new Error("Debe especificar la otra tarea.");
    if (!(workType === "bodega" ? bodegaCrops : allCrops).has(crop)) throw new Error("El cultivo no es válido para el tipo de trabajo.");
    if (!(workType === "bodega" ? bodegaTasks : allTasks).has(task)) throw new Error("La tarea no es válida para el tipo de trabajo.");

    await client.query("BEGIN");
    const workers = await client.query<{ id: number; job_id_1: number | null; job_id_2: number | null }>(`SELECT u.id, fwd.job_id_1, fwd.job_id_2 FROM users u JOIN foreign_workers_info fwi ON fwi.user_id = u.id LEFT JOIN foreign_workers_schedule.foreign_workers_details fwd ON fwd.user_id = u.id WHERE u.id = ANY($1::int[])`, [[evaluatorId, evaluatedWorkerId]]);
    if (workers.rowCount !== 2) throw new Error("Uno de los trabajadores seleccionados no existe.");
    const evaluator = workers.rows.find((worker) => worker.id === evaluatorId);
    const evaluatedWorker = workers.rows.find((worker) => worker.id === evaluatedWorkerId);
    if (!evaluator || (evaluator.job_id_1 !== 6 && evaluator.job_id_2 !== 6)) throw new Error("El evaluador seleccionado no tiene el puesto requerido.");
    if (!evaluatedWorker || evaluatedWorker.job_id_1 === 6 || evaluatedWorker.job_id_2 === 6) throw new Error("La persona evaluada no puede ser un evaluador.");

    const evaluationResult = await client.query<{ id: string }>(`INSERT INTO evaluation.evaluations (evaluator_worker_id, evaluated_worker_id, submitted_by_user_id, work_type, evaluation_year) VALUES ($1, $2, $3, $4, EXTRACT(YEAR FROM $5::date)) RETURNING id`, [evaluatorId, evaluatedWorkerId, req.user.id, workType, evaluationDate]);
    const evaluationId = evaluationResult.rows[0].id;
    for (const answer of [...sectionA, ...sectionB]) {
      await client.query(`INSERT INTO evaluation.rating_answers (evaluation_id, section, criterion_key, criterion_label, score) VALUES ($1, $2, $3, $4, $5)`, [evaluationId, answer.section, answer.key, answer.label, answer.score]);
    }
    await client.query(`INSERT INTO evaluation.performance_measurements (evaluation_id, evaluation_date, field_number, crop, weather_conditions, terrain_conditions, harvest_number, task, other_task, task_specification, quantity, unit, observations, final_score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [evaluationId, evaluationDate, workType === "campo" ? text(sectionC.fieldNumber) || null : null, crop, workType === "campo" ? text(sectionC.weatherConditions) || null : null, workType === "campo" ? text(sectionC.terrainConditions) || null : null, harvestNumber, task, task === "Otro" ? otherTask : null, taskSpecification, quantity, unit, text(sectionC.observations) || null, finalScore]);
    await client.query("COMMIT");
    const saved = await pool.query(`SELECT * FROM evaluation.evaluation_scores WHERE evaluation_id = $1`, [evaluationId]);
    return res.status(201).json({ evaluationId, scores: saved.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const message = error instanceof Error ? error.message : "Unable to save evaluation";
    console.error("Save evaluation error:", error);
    return res.status(message.includes("invalid") || message.includes("válid") || message.includes("Faltan") || message.includes("Debe") || message.includes("trabajador") ? 400 : 500).json({ message });
  } finally { client.release(); }
});

router.get("/:id", access, async (req, res) => {
  const id = integer(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid evaluation id" });
  try {
    const header = await pool.query(`SELECT e.*, s.* FROM evaluation.evaluations e JOIN evaluation.evaluation_scores s ON s.evaluation_id = e.id WHERE e.id = $1`, [id]);
    if (!header.rowCount) return res.status(404).json({ message: "Evaluation not found" });
    const [ratings, measurement] = await Promise.all([
      pool.query(`SELECT section, criterion_key, criterion_label, score FROM evaluation.rating_answers WHERE evaluation_id = $1 ORDER BY section, id`, [id]),
      pool.query(`SELECT * FROM evaluation.performance_measurements WHERE evaluation_id = $1`, [id]),
    ]);
    return res.json({ evaluation: header.rows[0], ratings: ratings.rows, sectionC: measurement.rows[0] });
  } catch (error) { console.error("Get evaluation error:", error); return res.status(500).json({ message: "Unable to load evaluation" }); }
});

export default router;
