import { Router } from "express";
import { pool } from "../../db"; // adjust this import if your pool lives elsewhere

const router = Router();



type AlertType = "red" | "yellow" | "positive";

type AlertReason =
  | "low_performance_or_distracted"
  | "lost_motivation_or_low_attitude"
  | "problems_with_coworkers"
  | "isolates_or_frequent_complaints"
  | "positive_action"
  | "other";

type SinceWhen =
  | "today"
  | "few_days"
  | "this_week"
  | "since_arrival"
  | "observation_unclear";

type LeaderAction =
  | "direct_conversation"
  | "field_observation_and_notes"
  | "repeated_suggestions"
  | "clear_task_reminders"
  | "active_follow_up";

type CreateVariationAlertBody = {
  client_submission_id?: string;
  leader_user_id: number;
  worker_user_id: number;

  alert_type: AlertType;
  since_when: SinceWhen;

  reasons: AlertReason[];
  actions: LeaderAction[];

  other_reason?: string;
  comments?: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VALID_ALERT_TYPES = new Set<AlertType>([
  "red",
  "yellow",
  "positive",
]);

const VALID_SINCE_WHEN = new Set<SinceWhen>([
  "today",
  "few_days",
  "this_week",
  "since_arrival",
  "observation_unclear",
]);

const VALID_REASONS = new Set<AlertReason>([
  "low_performance_or_distracted",
  "lost_motivation_or_low_attitude",
  "problems_with_coworkers",
  "isolates_or_frequent_complaints",
  "positive_action",
  "other",
]);

const VALID_ACTIONS = new Set<LeaderAction>([
  "direct_conversation",
  "field_observation_and_notes",
  "repeated_suggestions",
  "clear_task_reminders",
  "active_follow_up",
]);



type MonthlyAnswers = Record<string, number>;

type CreateEvaluationBody = {
  worker_user_id: number;
  evaluator_user_id: number;
  evaluation_date?: string;
  comments?: string;
  answers: MonthlyAnswers;
};

function validateAnswerValues(answers: unknown): {
  valid: boolean;
  message?: string;
} {
  if (
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers)
  ) {
    return {
      valid: false,
      message: "answers must be an object.",
    };
  }

  const entries = Object.entries(answers);

  if (entries.length === 0) {
    return {
      valid: false,
      message: "Debe incluir al menos una respuesta.",
    };
  }

  for (const [questionId, answer] of entries) {
    if (!questionId.trim()) {
      return {
        valid: false,
        message: "ID de pregunta inválido.",
      };
    }

    if (
      typeof answer !== "number" ||
      !Number.isInteger(answer) ||
      answer < 1 ||
      answer > 5
    ) {
      return {
        valid: false,
        message:
          `Invalid answer for ${questionId}. ` +
          "Answer must be an integer between 1 and 5.",
      };
    }
  }

  return { valid: true };
}


router.post("/", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.user?.id) {
      return res.status(401).json({
        error: "Usuario no autenticado.",
      });
    }

    const {
      worker_user_id,
      evaluator_user_id,
      evaluation_date,
      comments,
      answers,
    }: CreateEvaluationBody = req.body;

    if (
      !Number.isInteger(evaluator_user_id) ||
      evaluator_user_id <= 0
    ) {
      return res.status(400).json({
        error: "evaluator_user_id es requerido.",
      });
    }

    if (
      !Number.isInteger(worker_user_id) ||
      worker_user_id <= 0
    ) {
      return res.status(400).json({
        error: "worker_user_id es requerido.",
      });
    }

    if (
      comments !== undefined &&
      typeof comments !== "string"
    ) {
      return res.status(400).json({
        error: "comments debe ser texto.",
      });
    }

    if (comments && comments.length > 3000) {
      return res.status(400).json({
        error:
          "Los comentarios no pueden superar 3000 caracteres.",
      });
    }

    const answerValidation =
      validateAnswerValues(answers);

    if (!answerValidation.valid) {
      return res.status(400).json({
        error: answerValidation.message,
      });
    }

    await client.query("BEGIN");

    /*
     * Validate both people.
     */
    const usersResult = await client.query(
      `
      SELECT id
      FROM public.users
      WHERE id = ANY($1::bigint[])
      `,
      [[worker_user_id, evaluator_user_id]],
    );

    const existingUserIds = new Set(
      usersResult.rows.map((row) => Number(row.id)),
    );

    if (!existingUserIds.has(worker_user_id)) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "El empleado seleccionado no existe.",
      });
    }

    if (!existingUserIds.has(evaluator_user_id)) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "El evaluador seleccionado no existe.",
      });
    }

    /*
     * The questions table is now the source of truth.
     *
     * Only active questions are expected in a new evaluation.
     */
    const questionsResult = await client.query(
      `
      SELECT
        question_key,
        question_number,
        is_negative
      FROM evaluation.monthly_evaluation_questions
      WHERE is_active = TRUE
      ORDER BY question_number ASC, id ASC
      `,
    );

    const questions = questionsResult.rows as Array<{
      question_key: string;
      question_number: number;
      is_negative: boolean;
    }>;

    if (questions.length === 0) {
      throw new Error(
        "No active monthly evaluation questions are configured.",
      );
    }

    const submittedQuestionIds =
      Object.keys(answers);

    const activeQuestionIds = new Set(
      questions.map(
        (question) => question.question_key,
      ),
    );

    /*
     * Reject answers that don't correspond to an active question.
     */
    const unknownQuestionIds =
      submittedQuestionIds.filter(
        (questionId) =>
          !activeQuestionIds.has(questionId),
      );

    if (unknownQuestionIds.length > 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error:
          `Preguntas inválidas o inactivas: ` +
          unknownQuestionIds.join(", "),
      });
    }

    /*
     * Require every active question.
     */
    const missingQuestionIds =
      questions
        .map((question) => question.question_key)
        .filter(
          (questionId) =>
            answers[questionId] === undefined,
        );

    if (missingQuestionIds.length > 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error:
          `Faltan respuestas para: ` +
          missingQuestionIds.join(", "),
      });
    }

    /*
     * Calculate the effective score.
     *
     * Positive:
     *   1 -> 1
     *   5 -> 5
     *
     * Negative:
     *   1 -> 5
     *   5 -> 1
     */
    let adjustedTotal = 0;

    for (const question of questions) {
      const answer =
        answers[question.question_key];

      const effectiveAnswer =
        question.is_negative
          ? 6 - answer
          : answer;

      adjustedTotal += effectiveAnswer;
    }

    /*
     * Convert the effective 1–5 average to a true 0–100 scale.
     *
     * All 1s => 0
     * All 3s => 50
     * All 5s => 100
     */
    const questionCount = questions.length;

    const minimumPossible =
      questionCount;

    const maximumPossible =
      questionCount * 5;

    const score = Math.round(
      ((adjustedTotal - minimumPossible) /
        (maximumPossible - minimumPossible)) *
        100,
    );

    /*
     * Create evaluation header.
     */
    const evaluationResult =
      await client.query(
        `
        INSERT INTO evaluation.monthly_evaluations (
          worker_user_id,
          evaluator_user_id,
          evaluation_date,
          comments,
          score,
          status,
          completed_at
        )
        VALUES (
          $1,
          $2,
          COALESCE($3::date, CURRENT_DATE),
          NULLIF(TRIM($4), ''),
          $5,
          'completed',
          NOW()
        )
        RETURNING
          id,
          worker_user_id,
          evaluator_user_id,
          evaluation_date,
          comments,
          score,
          status,
          completed_at,
          created_at,
          updated_at
        `,
        [
          worker_user_id,
          evaluator_user_id,
          evaluation_date || null,
          comments || "",
          score,
        ],
      );

    const evaluation =
      evaluationResult.rows[0];

    /*
     * Insert answers according to the DB question list,
     * NOT according to question_1...question_30.
     */
    const answerValues: unknown[] = [];
    const answerPlaceholders: string[] = [];

    for (const question of questions) {
      const offset =
        answerValues.length;

      answerValues.push(
        evaluation.id,
        question.question_key,
        answers[question.question_key],
      );

      answerPlaceholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3})`,
      );
    }

    await client.query(
      `
      INSERT INTO evaluation.monthly_evaluation_answers (
        evaluation_id,
        question_id,
        answer
      )
      VALUES
        ${answerPlaceholders.join(",\n")}
      `,
      answerValues,
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message:
        "Evaluación guardada correctamente.",
      evaluation,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error creating monthly evaluation:",
      error,
    );

    return res.status(500).json({
      error: "Error al guardar la evaluación.",
    });
  } finally {
    client.release();
  }
});


router.get("/", async (req, res) => {
  try {
    const { worker_user_id, evaluator_user_id } = req.query;

    const values: unknown[] = [];
    const conditions: string[] = [];

    if (worker_user_id) {
      const workerId = Number(worker_user_id);

      if (!Number.isInteger(workerId)) {
        return res.status(400).json({
          error: "worker_user_id inválido.",
        });
      }

      values.push(workerId);
      conditions.push(`me.worker_user_id = $${values.length}`);
    }

    if (evaluator_user_id) {
      const evaluatorId = Number(evaluator_user_id);

      if (!Number.isInteger(evaluatorId)) {
        return res.status(400).json({
          error: "evaluator_user_id inválido.",
        });
      }

      values.push(evaluatorId);
      conditions.push(`me.evaluator_user_id = $${values.length}`);
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    const result = await pool.query(
      `
      SELECT
        me.id,
        me.worker_user_id,
        me.evaluator_user_id,
        me.evaluation_date,
        me.comments,
        me.score,
        me.status,
        me.completed_at,
        me.created_at,
        me.updated_at,

        CONCAT(
          COALESCE(worker.surname, ''),
          ' ',
          COALESCE(worker.name, '')
        ) AS worker_name,

        CONCAT(
          COALESCE(evaluator.surname, ''),
          ' ',
          COALESCE(evaluator.name, '')
        ) AS evaluator_name,

        COUNT(mea.id)::int AS answer_count

      FROM evaluation.monthly_evaluations me

      LEFT JOIN public.users worker
        ON worker.id = me.worker_user_id

      LEFT JOIN public.users evaluator
        ON evaluator.id = me.evaluator_user_id

      LEFT JOIN evaluation.monthly_evaluation_answers mea
        ON mea.evaluation_id = me.id

      ${whereClause}

      GROUP BY
        me.id,
        worker.id,
        evaluator.id

      ORDER BY
        me.evaluation_date DESC,
        me.created_at DESC
      `,
      values,
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Error fetching monthly evaluations:", error);

    return res.status(500).json({
      error: "Error al cargar las evaluaciones.",
    });
  }
});




router.post("/variation-alerts", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.user?.id) {
      return res.status(401).json({
        error: "Usuario no autenticado.",
      });
    }

    const {
      client_submission_id,
      leader_user_id,
      worker_user_id,
      alert_type,
      since_when,
      reasons,
      actions,
      other_reason,
      comments,
    }: CreateVariationAlertBody = req.body;

    if (
      client_submission_id !== undefined &&
      (typeof client_submission_id !== "string" ||
        !UUID_PATTERN.test(client_submission_id))
    ) {
      return res.status(400).json({
        error: "client_submission_id debe ser un UUID válido.",
      });
    }

    if (
      !Number.isInteger(leader_user_id) ||
      !Number.isInteger(worker_user_id)
    ) {
      return res.status(400).json({
        error: "leader_user_id y worker_user_id son requeridos.",
      });
    }

    if (!VALID_ALERT_TYPES.has(alert_type)) {
      return res.status(400).json({
        error: "Tipo de alerta inválido.",
      });
    }

    if (!VALID_SINCE_WHEN.has(since_when)) {
      return res.status(400).json({
        error: "Valor de since_when inválido.",
      });
    }

    if (!Array.isArray(reasons) || reasons.length === 0) {
      return res.status(400).json({
        error: "Debe seleccionar al menos una razón.",
      });
    }

    if (!Array.isArray(actions)) {
      return res.status(400).json({
        error: "actions debe ser un arreglo.",
      });
    }

    for (const reason of reasons) {
      if (!VALID_REASONS.has(reason)) {
        return res.status(400).json({
          error: `Razón inválida: ${reason}`,
        });
      }
    }

    for (const action of actions) {
      if (!VALID_ACTIONS.has(action)) {
        return res.status(400).json({
          error: `Acción inválida: ${action}`,
        });
      }
    }

    const uniqueReasons = [...new Set(reasons)];
    const uniqueActions = [...new Set(actions)];

    if (uniqueReasons.includes("other") && !other_reason?.trim()) {
      return res.status(400).json({
        error: "Debe especificar la razón cuando selecciona 'Otro'.",
      });
    }

    await client.query("BEGIN");

    const usersResult = await client.query(
      `
      SELECT id
      FROM public.users
      WHERE id = ANY($1::bigint[])
      `,
      [[leader_user_id, worker_user_id]],
    );

    const foundUserIds = new Set(
      usersResult.rows.map((row) => Number(row.id)),
    );

    if (!foundUserIds.has(leader_user_id)) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "El jefe de equipo seleccionado no existe.",
      });
    }

    if (!foundUserIds.has(worker_user_id)) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "El empleado seleccionado no existe.",
      });
    }

    const alertResult = await client.query(
      `
      INSERT INTO evaluation.performance_variation_alerts (
        client_submission_id,
        leader_user_id,
        worker_user_id,
        alert_type,
        since_when,
        other_reason,
        comments,
        created_by_user_id
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        $4,
        $5,
        NULLIF(TRIM($6), ''),
        NULLIF(TRIM($7), ''),
        $8
      )
      ON CONFLICT (client_submission_id) DO NOTHING
      RETURNING
        id,
        client_submission_id,
        leader_user_id,
        worker_user_id,
        alert_type,
        since_when,
        other_reason,
        comments,
        created_by_user_id,
        created_at,
        updated_at
      `,
      [
        client_submission_id || null,
        leader_user_id,
        worker_user_id,
        alert_type,
        since_when,
        uniqueReasons.includes("other")
          ? other_reason?.trim() || ""
          : "",
        comments?.trim() || "",
        req.user.id,
      ],
    );

    let alert = alertResult.rows[0];
    const deduplicated = !alert;

    if (deduplicated) {
      const existingAlertResult = await client.query(
        `
        SELECT
          id,
          client_submission_id,
          leader_user_id,
          worker_user_id,
          alert_type,
          since_when,
          other_reason,
          comments,
          created_by_user_id,
          created_at,
          updated_at
        FROM evaluation.performance_variation_alerts
        WHERE client_submission_id = $1::uuid
        LIMIT 1
        `,
        [client_submission_id],
      );

      alert = existingAlertResult.rows[0];

      if (!alert) {
        throw new Error("Idempotent variation alert could not be retrieved.");
      }
    }

    if (!deduplicated && uniqueReasons.length > 0) {
      const values: unknown[] = [];
      const placeholders: string[] = [];

      uniqueReasons.forEach((reason) => {
        const offset = values.length;

        values.push(alert.id, reason);

        placeholders.push(
          `($${offset + 1}, $${offset + 2})`,
        );
      });

      await client.query(
        `
        INSERT INTO evaluation.performance_variation_alert_reasons (
          alert_id,
          reason
        )
        VALUES
        ${placeholders.join(",\n")}
        `,
        values,
      );
    }

    if (!deduplicated && uniqueActions.length > 0) {
      const values: unknown[] = [];
      const placeholders: string[] = [];

      uniqueActions.forEach((action) => {
        const offset = values.length;

        values.push(alert.id, action);

        placeholders.push(
          `($${offset + 1}, $${offset + 2})`,
        );
      });

      await client.query(
        `
        INSERT INTO evaluation.performance_variation_alert_actions (
          alert_id,
          action
        )
        VALUES
        ${placeholders.join(",\n")}
        `,
        values,
      );
    }

    let responseReasons = uniqueReasons;
    let responseActions = uniqueActions;

    if (deduplicated) {
      const [reasonsResult, actionsResult] = await Promise.all([
        client.query(
          `
          SELECT reason
          FROM evaluation.performance_variation_alert_reasons
          WHERE alert_id = $1
          ORDER BY id
          `,
          [alert.id],
        ),
        client.query(
          `
          SELECT action
          FROM evaluation.performance_variation_alert_actions
          WHERE alert_id = $1
          ORDER BY id
          `,
          [alert.id],
        ),
      ]);

      responseReasons = reasonsResult.rows.map((row) => row.reason as AlertReason);
      responseActions = actionsResult.rows.map((row) => row.action as LeaderAction);
    }

    await client.query("COMMIT");

    return res.status(deduplicated ? 200 : 201).json({
      message: deduplicated
        ? "La alerta ya había sido guardada."
        : "Alerta guardada correctamente.",
      deduplicated,
      alert: {
        ...alert,
        reasons: responseReasons,
        actions: responseActions,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Error creating performance variation alert:", error);

    return res.status(500).json({
      error: "Error al guardar la alerta.",
    });
  } finally {
    client.release();
  }
});

router.get("/variation-alerts", async (req, res) => {
  try {
    const {
      worker_user_id,
      leader_user_id,
      alert_type,
    } = req.query;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (worker_user_id) {
      const workerId = Number(worker_user_id);

      if (!Number.isInteger(workerId)) {
        return res.status(400).json({
          error: "worker_user_id inválido.",
        });
      }

      values.push(workerId);
      conditions.push(
        `pva.worker_user_id = $${values.length}`,
      );
    }

    if (leader_user_id) {
      const leaderId = Number(leader_user_id);

      if (!Number.isInteger(leaderId)) {
        return res.status(400).json({
          error: "leader_user_id inválido.",
        });
      }

      values.push(leaderId);
      conditions.push(
        `pva.leader_user_id = $${values.length}`,
      );
    }

    if (alert_type) {
      if (
        typeof alert_type !== "string" ||
        !VALID_ALERT_TYPES.has(alert_type as AlertType)
      ) {
        return res.status(400).json({
          error: "alert_type inválido.",
        });
      }

      values.push(alert_type);
      conditions.push(
        `pva.alert_type = $${values.length}`,
      );
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    const result = await pool.query(
      `
      SELECT
        pva.id,
        pva.leader_user_id,
        pva.worker_user_id,
        pva.alert_type,
        pva.since_when,
        pva.other_reason,
        pva.comments,
        pva.created_by_user_id,
        pva.created_at,
        pva.updated_at,

        CONCAT(
          COALESCE(leader.surname, ''),
          ' ',
          COALESCE(leader.name, '')
        ) AS leader_name,

        CONCAT(
          COALESCE(worker.surname, ''),
          ' ',
          COALESCE(worker.name, '')
        ) AS worker_name,

        COALESCE(
          (
            SELECT json_agg(
              pvar.reason
              ORDER BY pvar.id
            )
            FROM evaluation.performance_variation_alert_reasons pvar
            WHERE pvar.alert_id = pva.id
          ),
          '[]'::json
        ) AS reasons,

        COALESCE(
          (
            SELECT json_agg(
              pvaa.action
              ORDER BY pvaa.id
            )
            FROM evaluation.performance_variation_alert_actions pvaa
            WHERE pvaa.alert_id = pva.id
          ),
          '[]'::json
        ) AS actions

      FROM evaluation.performance_variation_alerts pva

      LEFT JOIN public.users leader
        ON leader.id = pva.leader_user_id

      LEFT JOIN public.users worker
        ON worker.id = pva.worker_user_id

      ${whereClause}

      ORDER BY pva.created_at DESC
      `,
      values,
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Error fetching performance variation alerts:", error);

    return res.status(500).json({
      error: "Error al cargar las alertas.",
    });
  }
});

router.get("/variation-alerts/:id", async (req, res) => {
  try {
    const alertId = Number(req.params.id);

    if (!Number.isInteger(alertId)) {
      return res.status(400).json({
        error: "ID de alerta inválido.",
      });
    }

    const result = await pool.query(
      `
      SELECT
        pva.id,
        pva.leader_user_id,
        pva.worker_user_id,
        pva.alert_type,
        pva.since_when,
        pva.other_reason,
        pva.comments,
        pva.created_by_user_id,
        pva.created_at,
        pva.updated_at,

        CONCAT(
          COALESCE(leader.surname, ''),
          ' ',
          COALESCE(leader.name, '')
        ) AS leader_name,

        CONCAT(
          COALESCE(worker.surname, ''),
          ' ',
          COALESCE(worker.name, '')
        ) AS worker_name,

        CONCAT(
          COALESCE(created_by.surname, ''),
          ' ',
          COALESCE(created_by.name, '')
        ) AS created_by_name,

        COALESCE(
          (
            SELECT json_agg(
              pvar.reason
              ORDER BY pvar.id
            )
            FROM evaluation.performance_variation_alert_reasons pvar
            WHERE pvar.alert_id = pva.id
          ),
          '[]'::json
        ) AS reasons,

        COALESCE(
          (
            SELECT json_agg(
              pvaa.action
              ORDER BY pvaa.id
            )
            FROM evaluation.performance_variation_alert_actions pvaa
            WHERE pvaa.alert_id = pva.id
          ),
          '[]'::json
        ) AS actions

      FROM evaluation.performance_variation_alerts pva

      LEFT JOIN public.users leader
        ON leader.id = pva.leader_user_id

      LEFT JOIN public.users worker
        ON worker.id = pva.worker_user_id

      LEFT JOIN public.users created_by
        ON created_by.id = pva.created_by_user_id

      WHERE pva.id = $1

      LIMIT 1
      `,
      [alertId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Alerta no encontrada.",
      });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching performance variation alert:", error);

    return res.status(500).json({
      error: "Error al cargar la alerta.",
    });
  }
});

router.get("/questions/monthly", async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        question_key,
        question_number,
        question_text,
        category,
        is_negative,
        is_active
      FROM evaluation.monthly_evaluation_questions
      WHERE is_active = TRUE
      ORDER BY question_number ASC, id ASC
      `,
    );

    return res.json(result.rows);
  } catch (error) {
    console.error(
      "Error fetching monthly evaluation questions:",
      error,
    );

    return res.status(500).json({
      error: "Error al cargar las preguntas de evaluación.",
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const evaluationId = Number(req.params.id);

    if (!Number.isInteger(evaluationId)) {
      return res.status(400).json({
        error: "ID de evaluación inválido.",
      });
    }

    const evaluationResult = await pool.query(
      `
      SELECT
        me.id,
        me.worker_user_id,
        me.evaluator_user_id,
        me.evaluation_date,
        me.comments,
        me.score,
        me.status,
        me.completed_at,
        me.created_at,
        me.updated_at,

        CONCAT(
          COALESCE(worker.surname, ''),
          ' ',
          COALESCE(worker.name, '')
        ) AS worker_name,

        CONCAT(
          COALESCE(evaluator.surname, ''),
          ' ',
          COALESCE(evaluator.name, '')
        ) AS evaluator_name

      FROM evaluation.monthly_evaluations me

      LEFT JOIN public.users worker
        ON worker.id = me.worker_user_id

      LEFT JOIN public.users evaluator
        ON evaluator.id = me.evaluator_user_id

      WHERE me.id = $1

      LIMIT 1
      `,
      [evaluationId],
    );

    if (evaluationResult.rowCount === 0) {
      return res.status(404).json({
        error: "Evaluación no encontrada.",
      });
    }

 const answersResult = await pool.query(
  `
  SELECT
    a.question_id,
    a.answer
  FROM evaluation.monthly_evaluation_answers a

  JOIN evaluation.monthly_evaluation_questions q
    ON q.question_key = a.question_id

  WHERE a.evaluation_id = $1

  ORDER BY
    q.question_number ASC,
    q.id ASC
  `,
  [evaluationId],
);

    const answers = answersResult.rows.reduce<Record<string, number>>(
      (accumulator, row) => {
        accumulator[row.question_id] = row.answer;
        return accumulator;
      },
      {},
    );

    return res.json({
      ...evaluationResult.rows[0],
      answers,
    });
  } catch (error) {
    console.error("Error fetching monthly evaluation:", error);

    return res.status(500).json({
      error: "Error al cargar la evaluación.",
    });
  }
});

export default router;
