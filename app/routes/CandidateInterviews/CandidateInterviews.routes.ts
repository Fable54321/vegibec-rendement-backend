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

type CreatedInterview = {
  id: number;
  candidate_number: string;
  first_name: string;
  last_name: string;
  phone_number_1: string;
  phone_number_2: string | null;
  client_submission_id: string;
};

const router = Router();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const firstName =
    typeof req.body?.first_name === "string" ? req.body.first_name.trim() : "";
  const lastName =
    typeof req.body?.last_name === "string" ? req.body.last_name.trim() : "";
  const phoneNumber1 =
    typeof req.body?.phone_number_1 === "string"
      ? req.body.phone_number_1.trim()
      : "";
  const phoneNumber2 =
    typeof req.body?.phone_number_2 === "string"
      ? req.body.phone_number_2.trim()
      : "";
  const clientSubmissionId =
    typeof req.body?.client_submission_id === "string"
      ? req.body.client_submission_id.trim()
      : "";
  const answers = req.body?.answers as unknown;

  const candidateFieldErrors: Record<string, string> = {};

  if (!candidateNumber) {
    candidateFieldErrors.candidate_number = "Le numéro du candidat est requis.";
  } else if (candidateNumber.length > 20) {
    candidateFieldErrors.candidate_number =
      "Le numéro du candidat doit contenir au maximum 20 caractères.";
  }

  if (!firstName) {
    candidateFieldErrors.first_name = "Le prénom est requis.";
  } else if (firstName.length > 100) {
    candidateFieldErrors.first_name = "Le prénom est trop long.";
  }

  if (!lastName) {
    candidateFieldErrors.last_name = "Le nom de famille est requis.";
  } else if (lastName.length > 100) {
    candidateFieldErrors.last_name = "Le nom de famille est trop long.";
  }

  const isValidPhone = (phone: string) =>
    phone.length <= 30 && (phone.match(/\d/g)?.length ?? 0) >= 7;

  if (!phoneNumber1) {
    candidateFieldErrors.phone_number_1 = "Le numéro de téléphone principal est requis.";
  } else if (!isValidPhone(phoneNumber1)) {
    candidateFieldErrors.phone_number_1 = "Le numéro de téléphone principal est invalide.";
  }

  if (phoneNumber2 && !isValidPhone(phoneNumber2)) {
    candidateFieldErrors.phone_number_2 = "Le deuxième numéro de téléphone est invalide.";
  }

  if (!UUID_PATTERN.test(clientSubmissionId)) {
    candidateFieldErrors.client_submission_id = "L'identifiant de soumission est invalide.";
  }

  if (Object.keys(candidateFieldErrors).length > 0) {
    return res.status(400).json({
      error: "Les informations du candidat doivent être corrigées.",
      field_errors: candidateFieldErrors,
    });
  }

  if (!Array.isArray(answers)) {
    return res.status(400).json({ error: "Les réponses sont invalides." });
  }

  const submittedAnswers = answers as SubmittedAnswer[];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingInterview = await client.query<CreatedInterview>(
      `
        SELECT
          id,
          candidate_number,
          first_name,
          last_name,
          phone_number_1,
          phone_number_2,
          client_submission_id
        FROM candidates_interviews.candidates_interviews
        WHERE client_submission_id = $1
          AND user_id = $2
        LIMIT 1
      `,
      [clientSubmissionId, req.user.id],
    );

    if (existingInterview.rows[0]) {
      await client.query("COMMIT");
      return res.status(200).json({ interview: existingInterview.rows[0] });
    }

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

    const interviewResult = await client.query<CreatedInterview>(
      `
        INSERT INTO candidates_interviews.candidates_interviews (
          user_id,
          picture_id,
          candidate_number,
          first_name,
          last_name,
          phone_number_1,
          phone_number_2,
          client_submission_id
        )
        VALUES ($1, NULL, $2, $3, $4, $5, NULLIF($6, ''), $7)
        ON CONFLICT (client_submission_id) WHERE client_submission_id IS NOT NULL
        DO NOTHING
        RETURNING
          id,
          candidate_number,
          first_name,
          last_name,
          phone_number_1,
          phone_number_2,
          client_submission_id
      `,
      [
        req.user.id,
        candidateNumber,
        firstName,
        lastName,
        phoneNumber1,
        phoneNumber2,
        clientSubmissionId,
      ],
    );

    let interview = interviewResult.rows[0];

    if (!interview) {
      const concurrentInterview = await client.query<CreatedInterview>(
        `
          SELECT
            id,
            candidate_number,
            first_name,
            last_name,
            phone_number_1,
            phone_number_2,
            client_submission_id
          FROM candidates_interviews.candidates_interviews
          WHERE client_submission_id = $1
            AND user_id = $2
          LIMIT 1
        `,
        [clientSubmissionId, req.user.id],
      );
      interview = concurrentInterview.rows[0];
    }

    if (!interview) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Cette soumission existe déjà." });
    }

    const interviewId = interview.id;

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
      interview,
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
