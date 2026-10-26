import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";
import {
  sendNewTimeOffRequestEmailSafely,
  sendTimeOffReviewEmailSafely,
  sendUpcomingTimeOffEmail,
} from "./TimeOffRequestEmail";

const router = Router();
export const publicTimeOffRouter = Router();
const canRead = requireAppRole("conges", ["admin", "user", "guest"]);
const canReview = requireAppRole("conges", ["admin"]);
const READ_ONLY_ALL_REQUESTS_USER_ID = 368;
const TIME_OFF_NOTIFICATION_RECIPIENT_IDS = [2];

type AuthRequest = Request & { user?: { id: number | string } };
type DbError = Error & { code?: string; constraint?: string };
class ValidationError extends Error {}

const fields = `
  id, requester_user_id, guest_name, guest_email, requested_dates, reason,
  payment_preference, payment_preference_other, status,
  reviewed_by_user_id, reviewed_at, review_note, created_at, updated_at
`;

const currentUserId = (req: Request): number | null => {
  const id = Number((req as AuthRequest).user?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const isReadOnlyAllRequestsUser = (req: Request): boolean =>
  currentUserId(req) === READ_ONLY_ALL_REQUESTS_USER_ID;

const canReadOrReadOnlyViewer = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (isReadOnlyAllRequestsUser(req)) return next();
  return canRead(req, res, next);
};

const canReviewOrReadOnlyViewer = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (isReadOnlyAllRequestsUser(req)) return next();
  return canReview(req, res, next);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseId = (value: string): number | null => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const optionalText = (
  value: unknown,
  max = 5000,
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max)
    throw new ValidationError(
      `Le texte doit contenir au maximum ${max} caractères`,
    );
  return value.trim() || null;
};

const requiredText = (value: unknown, max = 100): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ValidationError(
      `Un texte non vide d'au plus ${max} caractères est requis`,
    );
  return value.trim();
};

const requiredEmail = (value: unknown): string => {
  const email = requiredText(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new ValidationError("Une adresse courriel valide est requise");
  return email;
};

const isRealDate = (date: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
};

const parseDates = (value: unknown): string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 366 ||
    !value.every((d) => typeof d === "string" && isRealDate(d))
  ) {
    throw new ValidationError(
      "requested_dates doit être un tableau non vide de dates au format AAAA-MM-JJ (maximum 366)",
    );
  }
  return [...new Set(value as string[])].sort();
};

const sendDbError = (res: Response, error: unknown): void => {
  const err = error as DbError;
  console.error("Time off request database error:", error);
  if (err.code === "23514") {
    res.status(400).json({
      error:
        "La valeur a été refusée par une contrainte de validation de la base de données",
      constraint: err.constraint,
    });
  } else if (err.code === "23503") {
    res.status(400).json({ error: "L'utilisateur référencé n'existe pas" });
  } else if (
    err.code === "23502" ||
    err.code === "22P02" ||
    err.code === "22007"
  ) {
    res.status(400).json({ error: "Champ invalide ou manquant" });
  } else {
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
};

const guestRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Trop de demandes ont été envoyées. Veuillez réessayer plus tard.",
  },
});

const sendGuestRequestNotificationsSafely = async (
  request: { id: number | string; requested_dates: string[] },
  guestName: string,
): Promise<void> => {
  try {
    const dateLabel =
      request.requested_dates.length === 1
        ? "pour une date"
        : `pour ${request.requested_dates.length} dates`;

    await pool.query(
      `INSERT INTO portal.notifications (
         user_id, sender_user_id, type_id, title, message, action_link,
         target_app, source_type, source_id
       )
       SELECT
         recipient_id, NULL, notification_type.id, $2, $3, $4,
         'portal', 'time_off_request', $5
       FROM unnest($1::bigint[]) AS recipients(recipient_id)
       CROSS JOIN portal.notification_types notification_type
       WHERE notification_type.code = 'time_off_request_created'
         AND notification_type.is_active = TRUE`,
      [
        TIME_OFF_NOTIFICATION_RECIPIENT_IDS,
        "Nouvelle demande de congé",
        `${guestName} a soumis une demande de congé ${dateLabel}.`,
        `/approbation-conge/${request.id}`,
        String(request.id),
      ],
    );
  } catch (error) {
    console.error("Guest time-off notification failed:", {
      requestId: request.id,
      error,
    });
  }
};

/** POST /time-off/guest (public) */
publicTimeOffRouter.post("/guest", guestRequestLimiter, async (req, res) => {
  if (!isRecord(req.body))
    return res.status(400).json({ error: "Un objet JSON est attendu" });

  try {
    const employeeId =
      req.body.employee_id === undefined || req.body.employee_id === null
        ? null
        : parseId(String(req.body.employee_id));
    if (req.body.employee_id !== undefined && req.body.employee_id !== null && !employeeId)
      throw new ValidationError("L’employé sélectionné est invalide");

    let requesterUserId: number | null = null;
    let guestName: string | null = null;
    let guestEmail: string | null = null;
    let requester: {
      name?: string | null;
      surname?: string | null;
      email?: string | null;
    };

    if (employeeId) {
      const employeeResult = await pool.query(
        `SELECT id, name, surname, email
         FROM public.users
         WHERE id = $1
           AND is_office IS TRUE
           AND is_active IS TRUE`,
        [employeeId],
      );
      const employee = employeeResult.rows[0];
      if (!employee)
        throw new ValidationError("L’employé sélectionné est introuvable");
      if (!employee.email?.trim())
        throw new ValidationError(
          "Cet employé n’a pas d’adresse courriel. Utilisez la saisie manuelle.",
        );

      requesterUserId = employee.id;
      requester = {
        name: employee.name,
        surname: employee.surname,
        email: employee.email,
      };
    } else {
      guestName = requiredText(req.body.guest_name, 160);
      guestEmail = requiredEmail(req.body.guest_email);
      requester = { name: guestName, email: guestEmail };
    }

    const requestedDates = parseDates(req.body.requested_dates);
    const reason = optionalText(req.body.reason);
    const paymentPreference = requiredText(req.body.payment_preference);
    const paymentPreferenceOther = optionalText(
      req.body.payment_preference_other,
    );
    const result = await pool.query(
      `INSERT INTO portal.time_off_request
       (requester_user_id, guest_name, guest_email, requested_dates, reason,
        payment_preference, payment_preference_other)
       VALUES ($1, $2, $3, $4::date[], $5, $6, $7)
       RETURNING ${fields}`,
      [
        requesterUserId,
        guestName,
        guestEmail,
        requestedDates,
        reason ?? null,
        paymentPreference,
        paymentPreferenceOther ?? null,
      ],
    );
    const createdRequest = result.rows[0];
    const requesterDisplayName = [requester.surname, requester.name]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join(" ");

    await sendNewTimeOffRequestEmailSafely(createdRequest, requester);
    await sendGuestRequestNotificationsSafely(
      createdRequest,
      requesterDisplayName,
    );

    return res.status(201).json(createdRequest);
  } catch (error) {
    if (error instanceof ValidationError)
      return res.status(400).json({ error: error.message });
    return sendDbError(res, error);
  }
});


router.get("/calendar", canRead, async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: "Non authentifié" });

  const from = req.query.from;
  const to = req.query.to;

  if (from !== undefined && (typeof from !== "string" || !isRealDate(from)))
    return res.status(400).json({ error: "Date de début invalide" });
  if (to !== undefined && (typeof to !== "string" || !isRealDate(to)))
    return res.status(400).json({ error: "Date de fin invalide" });
  if (typeof from === "string" && typeof to === "string" && from > to)
    return res
      .status(400)
      .json({
        error:
          "La date de début doit être antérieure ou égale à la date de fin",
      });

  try {
    const result = await pool.query(
      `SELECT
         requests.id,
         requests.requester_user_id,
         requests.requested_dates,
         requests.status,
         users.name AS requester_name,
         users.surname AS requester_surname,
         users.username AS requester_username,
         (requests.requester_user_id = $3)::boolean AS is_own_request
       FROM portal.time_off_request requests
       LEFT JOIN public.users users ON users.id = requests.requester_user_id
       WHERE requests.status IN ('approved', 'pending')
         AND EXISTS (
           SELECT 1
           FROM unnest(requests.requested_dates) AS dates(requested_date)
           WHERE ($1::date IS NULL OR dates.requested_date >= $1::date)
             AND ($2::date IS NULL OR dates.requested_date <= $2::date)
         )
       ORDER BY requests.requested_dates[1], requests.id`,
      [from ?? null, to ?? null, userId],
    );

    return res.json({ data: result.rows });
  } catch (error) {
    return sendDbError(res, error);
  }
});

/** POST /time-off/next-7-days/email (admins only) */
router.post("/next-7-days/email", canReview, async (req, res) => {
  if (!isRecord(req.body))
    return res.status(400).json({ error: "Un objet JSON est attendu" });

  try {
    const recipient = requiredEmail(req.body.email);
    const result = await pool.query(
      `SELECT
         requests.id,
         requests.requester_user_id,
         requests.guest_name AS name,
         requests.guest_email AS email,
         requests.status,
         ARRAY(
           SELECT requested_date
           FROM unnest(requests.requested_dates) AS dates(requested_date)
           WHERE requested_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 6
           ORDER BY requested_date
         ) AS requested_dates,
         users.name AS user_name,
         users.surname,
         users.username
       FROM portal.time_off_request requests
       LEFT JOIN public.users users ON users.id = requests.requester_user_id
       WHERE requests.status IN ('approved', 'pending')
         AND EXISTS (
           SELECT 1
           FROM unnest(requests.requested_dates) AS dates(requested_date)
           WHERE requested_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 6
         )
       ORDER BY requests.requested_dates[1], requests.id`,
    );
    const periodResult = await pool.query(
      `SELECT CURRENT_DATE::text AS from_date, (CURRENT_DATE + 6)::text AS to_date`,
    );
    const { from_date, to_date } = periodResult.rows[0];
    const requests = result.rows.map(({ user_name, ...request }) => ({
      ...request,
      name: user_name ?? request.name,
    }));

    await sendUpcomingTimeOffEmail(requests, from_date, to_date, recipient);

    return res.json({
      message: "Courriel des congés à venir envoyé",
      recipient,
      from: from_date,
      to: to_date,
      request_count: requests.length,
    });
  } catch (error) {
    if (error instanceof ValidationError)
      return res.status(400).json({ error: error.message });
    console.error("Upcoming time-off email failed:", error);
    return res.status(500).json({
      error: "Impossible d'envoyer le courriel des congés à venir",
    });
  }
});

/** GET /time-off-requests/mine?page=1&limit=20&status=pending */
router.get("/mine", canRead, async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: "Non authentifié" });

  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const status = typeof req.query.status === "string" ? req.query.status : null;

  try {
    const result = await pool.query(
      `SELECT ${fields}, COUNT(*) OVER()::int AS total_count
       FROM portal.time_off_request
       WHERE requester_user_id = $1
         AND ($2::text IS NULL OR status = $2)
         AND EXISTS (
           SELECT 1
           FROM unnest(requested_dates) AS dates(requested_date)
           WHERE dates.requested_date >= CURRENT_DATE
         )
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [userId, status, limit, (page - 1) * limit],
    );
    const total = result.rows[0]?.total_count ?? 0;
    return res.json({
      data: result.rows.map(({ total_count, ...row }) => row),
      page,
      limit,
      total,
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

/** GET /time-off/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD */


/** GET /time-off-requests (admins and the read-only cross-request viewer) */
router.get("/", canReviewOrReadOnlyViewer, async (req, res) => {
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const requesterId =
    req.query.requester_user_id === undefined
      ? null
      : parseId(String(req.query.requester_user_id));
  if (req.query.requester_user_id !== undefined && !requesterId)
    return res
      .status(400)
      .json({ error: "Identifiant du demandeur invalide" });

  try {
    const result = await pool.query(
      `SELECT ${fields}, COUNT(*) OVER()::int AS total_count
       FROM portal.time_off_request
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::bigint IS NULL OR requester_user_id = $2)
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [status, requesterId, limit, (page - 1) * limit],
    );
    const total = result.rows[0]?.total_count ?? 0;
    return res.json({
      data: result.rows.map(({ total_count, ...row }) => row),
      page,
      limit,
      total,
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

/** GET /time-off-requests/:id (owner, admin, or read-only cross-request viewer) */
router.get("/:id", canReadOrReadOnlyViewer, async (req, res) => {
  const userId = currentUserId(req);
  const id = parseId(req.params.id);
  const canViewAnyRequest =
    req.appRole === "admin" || isReadOnlyAllRequestsUser(req);
  if (!userId) return res.status(401).json({ error: "Non authentifié" });
  if (!id) return res.status(400).json({ error: "Identifiant invalide" });
  try {
    const result = await pool.query(
      `SELECT ${fields}
       FROM portal.time_off_request
       WHERE id = $1 AND ($2::boolean OR requester_user_id = $3)`,
      [id, canViewAnyRequest, userId],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Demande introuvable" });
    return res.json(result.rows[0]);
  } catch (error) {
    return sendDbError(res, error);
  }
});

/** GET /time-off-requests/admin/:id (admin or read-only cross-request viewer) */
router.get("/admin/:id", canReviewOrReadOnlyViewer, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Identifiant invalide" });
  try {
    const result = await pool.query(
      `SELECT ${fields} FROM portal.time_off_request WHERE id = $1`,
      [id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Demande introuvable" });
    return res.json(result.rows[0]);
  } catch (error) {
    return sendDbError(res, error);
  }
});

/** POST /time-off-requests */
router.post("/", canRead, async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: "Non authentifié" });
  if (!isRecord(req.body))
    return res.status(400).json({ error: "Un objet JSON est attendu" });
  try {
    const requestedDates = parseDates(req.body.requested_dates);
    const reason = optionalText(req.body.reason);
    const paymentPreference = requiredText(req.body.payment_preference);
    const paymentPreferenceOther = optionalText(
      req.body.payment_preference_other,
    );
    const result = await pool.query(
      `WITH created_request AS (
         INSERT INTO portal.time_off_request
         (requester_user_id, requested_dates, reason, payment_preference, payment_preference_other)
         VALUES ($1, $2::date[], $3, $4, $5)
         RETURNING ${fields}
       )
       SELECT
         created_request.*,
         users.name AS requester_name,
         users.surname AS requester_surname,
         users.username AS requester_username,
         users.email AS requester_email
       FROM created_request
       LEFT JOIN public.users users
         ON users.id = created_request.requester_user_id`,
      [
        userId,
        requestedDates,
        reason ?? null,
        paymentPreference,
        paymentPreferenceOther ?? null,
      ],
    );
    const {
      requester_name,
      requester_surname,
      requester_username,
      requester_email,
      ...createdRequest
    } = result.rows[0];

    await sendNewTimeOffRequestEmailSafely(createdRequest, {
      name: requester_name ?? createdRequest.guest_name,
      surname: requester_surname,
      username: requester_username,
      email: requester_email ?? createdRequest.guest_email,
    });

    return res.status(201).json(createdRequest);
  } catch (error) {
    if (error instanceof ValidationError)
      return res.status(400).json({ error: error.message });
    return sendDbError(res, error);
  }
});


/** PATCH /time-off-requests/:id (admins: any request; others: own pending request) */
router.patch("/:id", canRead, async (req, res) => {
  const userId = currentUserId(req);
  const id = parseId(req.params.id);
  const isAdmin = req.appRole === "admin";
  if (!userId) return res.status(401).json({ error: "Non authentifié" });
  if (!id) return res.status(400).json({ error: "Identifiant invalide" });
  if (!isRecord(req.body))
    return res.status(400).json({ error: "Un objet JSON est attendu" });
  if (!isAdmin && ("status" in req.body || "review_note" in req.body))
    return res
      .status(403)
      .json({
        error: "Seuls les administrateurs peuvent évaluer les demandes de congé",
      });

  try {
    const updates: string[] = [];
    const values: unknown[] = [];
    let updatedStatus: string | null = null;
    const add = (column: string, value: unknown, cast = "") => {
      values.push(value);
      updates.push(`${column} = $${values.length}${cast}`);
    };
    if ("requested_dates" in req.body)
      add("requested_dates", parseDates(req.body.requested_dates), "::date[]");
    if ("reason" in req.body)
      add("reason", optionalText(req.body.reason) ?? null);
    if ("payment_preference" in req.body)
      add("payment_preference", requiredText(req.body.payment_preference));
    if ("payment_preference_other" in req.body)
      add(
        "payment_preference_other",
        optionalText(req.body.payment_preference_other) ?? null,
      );
    if ("status" in req.body) {
      updatedStatus = requiredText(req.body.status, 60);
      if (updatedStatus !== "approved" && updatedStatus !== "rejected")
        return res
          .status(400)
          .json({ error: "Le statut doit être approved ou rejected" });

      const note = optionalText(req.body.review_note);
      if (updatedStatus === "rejected" && !note)
        return res.status(400).json({
          error: "Une raison est nécessaire lors d'une demande refusée",
        });

      add("status", updatedStatus);
      add("review_note", note ?? null);
      add("reviewed_by_user_id", userId);
      updates.push("reviewed_at = NOW()");
    } else if ("review_note" in req.body) {
      return res
        .status(400)
        .json({
          error: "Le statut est requis pour modifier la note d'évaluation",
        });
    }
    if (!updates.length)
      return res
        .status(400)
        .json({ error: "Aucun champ modifiable n'a été fourni" });

    values.push(id);
    const idParameter = values.length;
    let ownershipClause = "";

    if (!isAdmin) {
      values.push(userId);
      ownershipClause = ` AND requester_user_id = $${values.length} AND status = 'pending'`;
    }

    const result = await pool.query(
      `WITH updated_request AS (
         UPDATE portal.time_off_request
         SET ${updates.join(", ")}, updated_at = NOW()
         WHERE id = $${idParameter}${ownershipClause}
         RETURNING ${fields}
       )
       SELECT
         updated_request.*,
         users.name AS requester_name,
         users.surname AS requester_surname,
         users.username AS requester_username,
         users.email AS requester_email
       FROM updated_request
       LEFT JOIN public.users users
         ON users.id = updated_request.requester_user_id`,
      values,
    );
    if (!result.rows.length)
      return res.status(404).json({
        error: isAdmin
          ? "Demande introuvable"
          : "Demande en attente introuvable ou non modifiable",
      });
    const {
      requester_name,
      requester_surname,
      requester_username,
      requester_email,
      ...updatedRequest
    } = result.rows[0];

    if (updatedStatus) {
      await sendTimeOffReviewEmailSafely(updatedRequest, {
        name: requester_name ?? updatedRequest.guest_name,
        surname: requester_surname,
        username: requester_username,
        email: requester_email ?? updatedRequest.guest_email,
      });
    }

    return res.json(updatedRequest);
  } catch (error) {
    if (error instanceof ValidationError)
      return res.status(400).json({ error: error.message });
    return sendDbError(res, error);
  }
});


router.patch("/:id/review", canReview, async (req, res) => {
  const userId = currentUserId(req);
  const id = parseId(req.params.id);
  if (!userId) return res.status(401).json({ error: "Non authentifié" });
  if (!id) return res.status(400).json({ error: "Identifiant invalide" });
  if (!isRecord(req.body))
    return res.status(400).json({ error: "Un objet JSON est attendu" });
  try {
    const status = requiredText(req.body.status, 60);
    if (status !== "approved" && status !== "rejected")
      return res
        .status(400)
        .json({ error: "Le statut doit être approved ou rejected" });
    const note = optionalText(req.body.review_note);

    if (status === "rejected" && !note) {
      return res.status(400).json({
        error: "Une raison est nécessaire lors d'une demande refusée",
      });
    }

    const result = await pool.query(
      `WITH updated_request AS (
         UPDATE portal.time_off_request
         SET status = $1, review_note = $2, reviewed_by_user_id = $3,
             reviewed_at = NOW(), updated_at = NOW()
         WHERE id = $4
         RETURNING ${fields}
       )
       SELECT
         updated_request.*,
         users.name AS requester_name,
         users.surname AS requester_surname,
         users.username AS requester_username,
         users.email AS requester_email
       FROM updated_request
       LEFT JOIN public.users users
         ON users.id = updated_request.requester_user_id`,
      [status, note ?? null, userId, id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Demande introuvable" });
    const {
      requester_name,
      requester_surname,
      requester_username,
      requester_email,
      ...updatedRequest
    } = result.rows[0];

    await sendTimeOffReviewEmailSafely(updatedRequest, {
      name: requester_name ?? updatedRequest.guest_name,
      surname: requester_surname,
      username: requester_username,
      email: requester_email ?? updatedRequest.guest_email,
    });

    return res.json(updatedRequest);
  } catch (error) {
    if (error instanceof ValidationError)
      return res.status(400).json({ error: error.message });
    return sendDbError(res, error);
  }
});

/** DELETE /time-off-requests/:id (requester; pending requests only) */
router.delete("/:id", canRead, async (req, res) => {
  const userId = currentUserId(req);
  const id = parseId(req.params.id);
  if (!userId) return res.status(401).json({ error: "Non authentifié" });
  if (!id) return res.status(400).json({ error: "Identifiant invalide" });
  try {
    const result = await pool.query(
      `DELETE FROM portal.time_off_request
       WHERE id = $1 AND requester_user_id = $2 AND status = 'pending'
       RETURNING id`,
      [id, userId],
    );
    if (!result.rows.length)
      return res
        .status(404)
        .json({
          error: "Demande en attente introuvable ou impossible à supprimer",
        });
    return res.status(204).send();
  } catch (error) {
    return sendDbError(res, error);
  }
});

export default router;
