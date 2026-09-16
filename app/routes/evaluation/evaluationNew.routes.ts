import { Router } from "express";
import { pool } from "../../db"; // adjust this import if your pool lives elsewhere

const router = Router();

const QUESTION_COUNT = 30;
const VALID_QUESTION_IDS = new Set(
  Array.from({ length: QUESTION_COUNT }, (_, index) => `question_${index + 1}`),
);

type MonthlyAnswers = Record<string, number>;

type CreateEvaluationBody = {
  worker_user_id: number;
  evaluator_user_id: number;
  evaluation_date?: string;
  comments?: string;
  answers: MonthlyAnswers;
};

function validateAnswers(answers: unknown): {
  valid: boolean;
  message?: string;
} {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return {
      valid: false,
      message: "answers must be an object.",
    };
  }

  const entries = Object.entries(answers);

  if (entries.length !== QUESTION_COUNT) {
    return {
      valid: false,
      message: `Exactly ${QUESTION_COUNT} answers are required.`,
    };
  }

  for (const [questionId, answer] of entries) {
    if (!VALID_QUESTION_IDS.has(questionId)) {
      return {
        valid: false,
        message: `Invalid question id: ${questionId}`,
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
        message: `Invalid answer for ${questionId}. Answer must be an integer between 1 and 5.`,
      };
    }
  }

  for (const questionId of VALID_QUESTION_IDS) {
    if (!(questionId in answers)) {
      return {
        valid: false,
        message: `Missing answer for ${questionId}.`,
      };
    }
  }

  return { valid: true };
}


router.post("/", async (req, res) => {
  const client = await pool.connect();

  try {
    const evaluatorUserId = req.user?.id;

    if (!evaluatorUserId) {
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
  !evaluator_user_id ||
  typeof evaluator_user_id !== "number" ||
  !Number.isInteger(evaluator_user_id)
) {
  return res.status(400).json({
    error: "evaluator_user_id es requerido.",
  });
}

    if (
      !worker_user_id ||
      typeof worker_user_id !== "number" ||
      !Number.isInteger(worker_user_id)
    ) {
      return res.status(400).json({
        error: "worker_user_id es requerido.",
      });
    }

    if (comments && comments.length > 3000) {
      return res.status(400).json({
        error: "Los comentarios no pueden superar 3000 caracteres.",
      });
    }

    const answerValidation = validateAnswers(answers);

    if (!answerValidation.valid) {
      return res.status(400).json({
        error: answerValidation.message,
      });
    }

    await client.query("BEGIN");

    /*
     * Confirm that the evaluated worker exists.
     */
    const workerResult = await client.query(
      `
      SELECT id
      FROM public.users
      WHERE id = $1
      LIMIT 1
      `,
      [worker_user_id],
    );

    if (workerResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "El empleado seleccionado no existe.",
      });
    }

    /*
     * Create the evaluation header.
     */
    const evaluationResult = await client.query(
      `
      INSERT INTO evaluation.monthly_evaluations (
        worker_user_id,
        evaluator_user_id,
        evaluation_date,
        comments,
        status,
        completed_at
      )
      VALUES (
        $1,
        $2,
        COALESCE($3::date, CURRENT_DATE),
        NULLIF(TRIM($4), ''),
        'completed',
        NOW()
      )
      RETURNING
        id,
        worker_user_id,
        evaluator_user_id,
        evaluation_date,
        comments,
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
]
    );

    const evaluation = evaluationResult.rows[0];

    /*
     * Insert all answers.
     *
     * We explicitly insert them in question order instead of relying
     * on the order of Object.entries().
     */
    const answerValues: unknown[] = [];
    const answerPlaceholders: string[] = [];

    for (let index = 1; index <= QUESTION_COUNT; index++) {
      const questionId = `question_${index}`;
      const answer = answers[questionId];

      const offset = answerValues.length;

      answerValues.push(
        evaluation.id,
        questionId,
        answer,
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
      message: "Evaluación guardada correctamente.",
      evaluation,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Error creating monthly evaluation:", error);

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
        question_id,
        answer
      FROM evaluation.monthly_evaluation_answers
      WHERE evaluation_id = $1
      ORDER BY
        CAST(
          REPLACE(question_id, 'question_', '')
          AS INTEGER
        )
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