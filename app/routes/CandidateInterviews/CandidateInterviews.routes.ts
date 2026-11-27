import { Router } from "express";
import { pool } from "../../db";

type AnswerType = "boolean" | "integer" | "rating" | "select" | "text";

type QuestionRow = {
  id: number;
  section: string;
  question_text: string;
  answer_type: AnswerType;
  options: unknown;
  display_order: number;
  is_required: boolean;
};

type SubmittedAnswer = {
  question_id: number;
  value: unknown;
};

const router = Router();

const isEmptyAnswer = (value: unknown) =>
  value === null || value === undefined ||
  (typeof value === "string" && value.trim() === "");

const numberOption = (
  options: unknown,
  key: "min" | "max",
  fallback: number,
) => {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return fallback;
  }

  const value = (options as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

function validateAnswer(question: QuestionRow, value: unknown): string | null {
  if (isEmptyAnswer(value)) {
    return question.is_required ? "Une réponse est requise." : null;
  }

  switch (question.answer_type) {
    case "boolean":
      return typeof value === "boolean" ? null : "La réponse doit être oui ou non.";

    case "integer":
      return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? null
        : "La réponse doit être un nombre entier positif.";

    case "rating": {
      const min = numberOption(question.options, "min", 1);
      const max = numberOption(question.options, "max", 5);

      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= min &&
        value <= max
        ? null
        : `La note doit être comprise entre ${min} et ${max}.`;
    }

    case "select": {
      if (typeof value !== "string") return "La sélection est invalide.";

      const choices = Array.isArray(question.options)
        ? question.options.filter((option): option is string => typeof option === "string")
        : [];

      return choices.includes(value) ? null : "La sélection est invalide.";
    }

    case "text":
      return typeof value === "string" && value.trim().length <= 5000
        ? null
        : "La réponse doit contenir au maximum 5 000 caractères.";

    default:
      return "Ce type de question n'est pas pris en charge.";
  }
}

router.get("/questions", async (_req, res) => {
  try {
    const result = await pool.query<QuestionRow>(
      `
        SELECT
          id,
          section,
          question_text,
          answer_type,
          options,
          display_order,
          is_required
        FROM candidates_interviews.questions
        WHERE is_active = TRUE
        ORDER BY section, display_order, id
      `,
    );

    return res.json({ questions: result.rows });
  } catch (error) {
    console.error("Error fetching candidate interview questions:", error);
    return res.status(500).json({ error: "Impossible de charger les questions." });
  }
});

router.post("/", async (req, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: "Utilisateur non authentifié." });
  }

  const candidateNumber =
    typeof req.body?.candidate_number === "string"
      ? req.body.candidate_number.trim()
      : "";
  const answers = req.body?.answers as unknown;

  if (!candidateNumber) {
    return res.status(400).json({ error: "Le numéro du candidat est requis." });
  }

  if (candidateNumber.length > 100) {
    return res.status(400).json({
      error: "Le numéro du candidat doit contenir au maximum 100 caractères.",
    });
  }

  if (!Array.isArray(answers)) {
    return res.status(400).json({ error: "Les réponses sont invalides." });
  }

  const submittedAnswers = answers as SubmittedAnswer[];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const questionsResult = await client.query<QuestionRow>(
      `
        SELECT
          id,
          section,
          question_text,
          answer_type,
          options,
          display_order,
          is_required
        FROM candidates_interviews.questions
        WHERE is_active = TRUE
        ORDER BY section, display_order, id
      `,
    );

    const questionsById = new Map(
      questionsResult.rows.map((question) => [question.id, question]),
    );
    const answersByQuestionId = new Map<number, unknown>();

    for (const answer of submittedAnswers) {
      if (
        !answer ||
        typeof answer !== "object" ||
        !Number.isInteger(answer.question_id) ||
        !questionsById.has(answer.question_id)
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Une réponse vise une question invalide." });
      }

      if (answersByQuestionId.has(answer.question_id)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Une question a été répondue plus d'une fois." });
      }

      answersByQuestionId.set(answer.question_id, answer.value);
    }

    const fieldErrors: Record<string, string> = {};

    for (const question of questionsResult.rows) {
      const validationError = validateAnswer(
        question,
        answersByQuestionId.get(question.id),
      );

      if (validationError) fieldErrors[String(question.id)] = validationError;
    }

    if (Object.keys(fieldErrors).length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Certaines réponses doivent être corrigées.",
        field_errors: fieldErrors,
      });
    }

    const interviewResult = await client.query<{ id: number }>(
      `
        INSERT INTO candidates_interviews.candidates_interviews (
          user_id,
          picture_id,
          candidate_number
        )
        VALUES ($1, NULL, $2)
        RETURNING id
      `,
      [req.user.id, candidateNumber],
    );

    const interviewId = interviewResult.rows[0].id;

    for (const [questionId, value] of answersByQuestionId) {
      if (isEmptyAnswer(value)) continue;

      await client.query(
        `
          INSERT INTO candidates_interviews.answers (
            interview_id,
            question_id,
            answer_value
          )
          VALUES ($1, $2, $3::jsonb)
        `,
        [interviewId, questionId, JSON.stringify(value)],
      );
    }

    await client.query("COMMIT");

    return res.status(201).json({
      interview: {
        id: interviewId,
        candidate_number: candidateNumber,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating candidate interview:", error);
    return res.status(500).json({ error: "Impossible d'enregistrer l'entrevue." });
  } finally {
    client.release();
  }
});

export default router;
