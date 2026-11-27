import { Router } from "express";
import { pool } from "../../db";

type AnswerType = "boolean" | "integer" | "rating" | "select" | "text";

type SectionRow = {
  id: number;
  code: string;
  name: string;
  display_order: number;
};

type QuestionRow = {
  id: number;
  section_id: number;
  section: string;
  section_code: string;
  question_text: string;
  answer_type: AnswerType;
  options: unknown;
  display_order: number;
  is_required: boolean;
};

type PracticalTaskRow = {
  id: string;
  section_id: number;
  section_code: string;
  description: string;
  display_order: number;
};

type LegacyPracticalQuestionRow = {
  question_id: number;
  practical_task_id: string;
};

type SubmittedAnswer = {
  question_id?: unknown;
  practical_task_id?: unknown;
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

const normalizeQuestionText = (text: string) =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const mentionsOtherJob = (question: QuestionRow) => {
  const text = normalizeQuestionText(question.question_text);
  const describesAdditionalJob = ["autre", "ailleurs", "second", "deuxieme"]
    .some((term) => text.includes(term));
  return describesAdditionalJob && ["emploi", "travail", "metier", "job"]
    .some((term) => text.includes(term));
};

function findOtherJobDependency(questions: QuestionRow[]) {
  const trigger = questions.find(
    (question) => question.answer_type === "boolean" && mentionsOtherJob(question),
  );
  if (!trigger) return null;

  const detail = questions
    .filter(
      (question) =>
        question.section_id === trigger.section_id &&
        question.answer_type === "text" &&
        question.display_order > trigger.display_order,
    )
    .sort((left, right) => left.display_order - right.display_order)
    .find(mentionsOtherJob);

  return detail ? { triggerId: trigger.id, detailId: detail.id } : null;
}

export function validatePracticalTaskAnswer(value: unknown): string | null {
  if (isEmptyAnswer(value)) return null;

  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5
    ? null
    : "La note doit être comprise entre 1 et 5.";
}

type ParsedSubmittedAnswers =
  | {
      ok: true;
      questionAnswers: Map<number, unknown>;
      practicalTaskAnswers: Map<string, unknown>;
    }
  | { ok: false; error: string };

export function parseSubmittedAnswers(
  submittedAnswers: unknown[],
  validQuestionIds: Set<number>,
  validPracticalTaskIds: Set<string>,
): ParsedSubmittedAnswers {
  const questionAnswers = new Map<number, unknown>();
  const practicalTaskAnswers = new Map<string, unknown>();

  for (const rawAnswer of submittedAnswers) {
    if (!rawAnswer || typeof rawAnswer !== "object") {
      return { ok: false, error: "Une réponse est invalide." };
    }

    const answer = rawAnswer as SubmittedAnswer;
    const questionId = Number.isInteger(answer.question_id)
      ? answer.question_id as number
      : null;
    const practicalTaskId = typeof answer.practical_task_id === "string" &&
      UUID_PATTERN.test(answer.practical_task_id)
      ? answer.practical_task_id
      : null;

    if ((questionId === null) === (practicalTaskId === null)) {
      return {
        ok: false,
        error: "Chaque réponse doit viser une question ou une tâche pratique.",
      };
    }

    if (questionId !== null) {
      if (!validQuestionIds.has(questionId)) {
        return { ok: false, error: "Une réponse vise une question invalide." };
      }
      if (questionAnswers.has(questionId)) {
        return { ok: false, error: "Une question a été répondue plus d'une fois." };
      }
      questionAnswers.set(questionId, answer.value);
      continue;
    }

    if (!practicalTaskId || !validPracticalTaskIds.has(practicalTaskId)) {
      return { ok: false, error: "Une réponse vise une tâche pratique invalide." };
    }
    if (practicalTaskAnswers.has(practicalTaskId)) {
      return {
        ok: false,
        error: "Une tâche pratique a été répondue plus d'une fois.",
      };
    }
    practicalTaskAnswers.set(practicalTaskId, answer.value);
  }

  return { ok: true, questionAnswers, practicalTaskAnswers };
}

export function normalizeLegacyPracticalAnswers(
  submittedAnswers: SubmittedAnswer[],
  practicalTasksByQuestionId: Map<number, string>,
): SubmittedAnswer[] {
  return submittedAnswers.map((answer) => {
    const legacyTaskId = Number.isInteger(answer.question_id)
      ? practicalTasksByQuestionId.get(answer.question_id as number)
      : undefined;

    return legacyTaskId
      ? { practical_task_id: legacyTaskId, value: answer.value }
      : answer;
  });
}

router.get("/questions", async (_req, res) => {
  try {
    const [sectionsResult, questionsResult, practicalTasksResult] = await Promise.all([
      pool.query<SectionRow>(
        `
          SELECT id, code, name, display_order
          FROM candidates_interviews.sections
          WHERE is_active = TRUE
          ORDER BY display_order, id
        `,
      ),
      pool.query<QuestionRow>(
        `
          SELECT
            q.id,
            q.section_id,
            s.code AS section,
            s.code AS section_code,
            q.question_text,
            q.answer_type,
            q.options,
            q.display_order,
            q.is_required
          FROM candidates_interviews.questions q
          JOIN candidates_interviews.sections s ON s.id = q.section_id
          WHERE q.is_active = TRUE
            AND s.is_active = TRUE
          ORDER BY s.display_order, q.display_order, q.id
        `,
      ),
      pool.query<PracticalTaskRow>(
        `
          SELECT
            pt.id,
            pt.section_id,
            s.code AS section_code,
            pt.description,
            pt.display_order
          FROM candidates_interviews.practical_tasks pt
          JOIN candidates_interviews.sections s ON s.id = pt.section_id
          WHERE pt.is_active = TRUE
            AND s.is_active = TRUE
          ORDER BY s.display_order, pt.display_order, pt.id
        `,
      ),
    ]);

    return res.json({
      sections: sectionsResult.rows,
      questions: questionsResult.rows,
      practical_tasks: practicalTasksResult.rows,
    });
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
          q.id,
          q.section_id,
          s.code AS section,
          s.code AS section_code,
          q.question_text,
          q.answer_type,
          q.options,
          q.display_order,
          q.is_required
        FROM candidates_interviews.questions q
        JOIN candidates_interviews.sections s ON s.id = q.section_id
        WHERE q.is_active = TRUE
          AND s.is_active = TRUE
        ORDER BY s.display_order, q.display_order, q.id
      `,
    );
    const practicalTasksResult = await client.query<PracticalTaskRow>(
      `
        SELECT
          pt.id,
          pt.section_id,
          s.code AS section_code,
          pt.description,
          pt.display_order
        FROM candidates_interviews.practical_tasks pt
        JOIN candidates_interviews.sections s ON s.id = pt.section_id
        WHERE pt.is_active = TRUE
          AND s.is_active = TRUE
        ORDER BY s.display_order, pt.display_order, pt.id
      `,
    );
    const legacyPracticalQuestionsResult = await client.query<LegacyPracticalQuestionRow>(
      `
        SELECT
          q.id AS question_id,
          pt.id AS practical_task_id
        FROM candidates_interviews.questions q
        JOIN candidates_interviews.practical_tasks pt
          ON pt.section_id = q.section_id
          AND pt.display_order = q.display_order
        WHERE q.is_active = FALSE
          AND q.answer_type = 'rating'
          AND pt.is_active = TRUE
      `,
    );

    const legacyPracticalTasksByQuestionId = new Map(
      legacyPracticalQuestionsResult.rows.map((row) => [row.question_id, row.practical_task_id]),
    );
    const normalizedSubmittedAnswers = normalizeLegacyPracticalAnswers(
      submittedAnswers,
      legacyPracticalTasksByQuestionId,
    );

    const parsedAnswers = parseSubmittedAnswers(
      normalizedSubmittedAnswers,
      new Set(questionsResult.rows.map((question) => question.id)),
      new Set(practicalTasksResult.rows.map((task) => task.id)),
    );
    if (!parsedAnswers.ok) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: parsedAnswers.error });
    }

    const answersByQuestionId = parsedAnswers.questionAnswers;
    const answersByPracticalTaskId = parsedAnswers.practicalTaskAnswers;

    const fieldErrors: Record<string, string> = {};

    for (const question of questionsResult.rows) {
      const validationError = validateAnswer(
        question,
        answersByQuestionId.get(question.id),
      );

      if (validationError) fieldErrors[String(question.id)] = validationError;
    }

    const otherJobDependency = findOtherJobDependency(questionsResult.rows);
    if (
      otherJobDependency &&
      answersByQuestionId.get(otherJobDependency.triggerId) === true &&
      isEmptyAnswer(answersByQuestionId.get(otherJobDependency.detailId))
    ) {
      fieldErrors[String(otherJobDependency.detailId)] = "Une réponse est requise.";
    }

    for (const task of practicalTasksResult.rows) {
      const validationError = validatePracticalTaskAnswer(
        answersByPracticalTaskId.get(task.id),
      );
      if (validationError) fieldErrors[task.id] = validationError;
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

    for (const [practicalTaskId, value] of answersByPracticalTaskId) {
      if (isEmptyAnswer(value)) continue;

      await client.query(
        `
          INSERT INTO candidates_interviews.answers (
            interview_id,
            practical_task_id,
            answer_value
          )
          VALUES ($1, $2, $3::jsonb)
        `,
        [interviewId, practicalTaskId, JSON.stringify(value)],
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
