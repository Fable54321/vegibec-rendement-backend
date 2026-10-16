import { Router, type Request, type Response } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";
import { sendNewTimeOffRequestEmailSafely } from "./TimeOffRequestEmail";



const router = Router();
const canRead = requireAppRole("conges", ["admin", "user", "guest"]);
const canReview = requireAppRole("conges", ["admin"]);

type AuthRequest = Request & { user?: { id: number | string } };
type DbError = Error & { code?: string; constraint?: string };

const fields = `
  id, requester_user_id, requested_dates, reason,
  payment_preference, payment_preference_other, status,
  reviewed_by_user_id, reviewed_at, review_note, created_at, updated_at
`;

const currentUserId = (req: Request): number | null => {
  const id = Number((req as AuthRequest).user?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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
    throw new Error(`Expected text (max ${max} characters)`);
  return value.trim() || null;
};

const requiredText = (value: unknown, max = 100): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Expected non-empty text (max ${max} characters)`);
  return value.trim();
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
    throw new Error(
      "requested_dates must be a non-empty array of YYYY-MM-DD dates (max 366)",
    );
  }
  return [...new Set(value as string[])].sort();
};

const sendDbError = (res: Response, error: unknown): void => {
  const err = error as DbError;
  console.error("Time off request database error:", error);
  if (err.code === "23514") {
    res.status(400).json({
      error: "Value rejected by a database CHECK constraint",
      constraint: err.constraint,
    });
  } else if (err.code === "23503") {
    res.status(400).json({ error: "Referenced user does not exist" });
  } else if (
    err.code === "23502" ||
    err.code === "22P02" ||
    err.code === "22007"
  ) {
    res.status(400).json({ error: "Invalid or missing field" });
  } else {
    res.status(500).json({ error: "Internal server error" });
  }
};

/** GET /time-off-requests/mine?page=1&limit=20&status=pending */
router.get("/mine", canRead, async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });

  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const status = typeof req.query.status === "string" ? req.query.status : null;

  try {
    const result = await pool.query(
      `SELECT ${fields}, COUNT(*) OVER()::int AS total_count
       FROM portal.time_off_request
       WHERE requester_user_id = $1 AND ($2::text IS NULL OR status = $2)
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

/** GET /time-off-requests (ADMIN ONLY): all requests */
router.get("/", canReview, async (req, res) => {
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const requesterId =
    req.query.requester_user_id === undefined
      ? null
      : parseId(String(req.query.requester_user_id));
  if (req.query.requester_user_id !== undefined && !requesterId)
    return res.status(400).json({ error: "Invalid requester_user_id" });

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

/** GET /time-off-requests/:id (requester or admin) */
router.get("/:id", canRead, async (req, res) => {
  const userId = currentUserId(req);
  const id = parseId(req.params.id);
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  if (!id) return res.status(400).json({ error: "Invalid ID" });
  try {
    // Non-admins must not gain access via arbitrary IDs. Use a separate admin route
    // to get any request rather than inferring req.user.role from its shape.
    const result = await pool.query(
      `SELECT ${fields} FROM portal.time_off_request WHERE id = $1 AND requester_user_id = $2`,
      [id, userId],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Request not found" });
    return res.json(result.rows[0]);
  } catch (error) {
    return sendDbError(res, error);
  }
});

/** GET /time-off-requests/admin/:id (ADMIN ONLY) */
router.get("/admin/:id", canReview, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid ID" });
  try {
    const result = await pool.query(
      `SELECT ${fields} FROM portal.time_off_request WHERE id = $1`,
      [id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Request not found" });
    return res.json(result.rows[0]);
  } catch (error) {
    return sendDbError(res, error);
  }
});

/** POST /time-off-requests */
router.post("/", canRead, async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  if (!isRecord(req.body))
    return res.status(400).json({ error: "Expected JSON object" });
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
      name: requester_name,
      surname: requester_surname,
      username: requester_username,
      email: requester_email,
    });

    return res.status(201).json(createdRequest);
  } catch (error) {
    if (
      (error instanceof Error && error.message.startsWith("Expected")) ||
      (error instanceof Error && error.message.startsWith("requested_dates"))
    )
      return res.status(400).json({ error: (error as Error).message });
    return sendDbError(res, error);
  }
});

/** PATCH /time-off-requests/:id (requester; pending requests only) */
router.patch("/:id", canRead, async (req, res) => {
  const userId = currentUserId(req);
  const id = parseId(req.params.id);
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  if (!id) return res.status(400).json({ error: "Invalid ID" });
  if (!isRecord(req.body))
    return res.status(400).json({ error: "Expected JSON object" });

  try {
    const updates: string[] = [];
    const values: unknown[] = [];
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
    if (!updates.length)
      return res.status(400).json({ error: "No editable fields provided" });

    values.push(id, userId);
    const result = await pool.query(
      `UPDATE portal.time_off_request SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length - 1} AND requester_user_id = $${values.length} AND status = 'pending'
       RETURNING ${fields}`,
      values,
    );
    if (!result.rows.length)
      return res
        .status(404)
        .json({ error: "Pending request not found or cannot be edited" });
    return res.json(result.rows[0]);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("Expected") ||
        error.message.startsWith("requested_dates"))
    )
      return res.status(400).json({ error: error.message });
    return sendDbError(res, error);
  }
});

/**
 * PATCH /time-off-requests/:id/review (ADMIN ONLY)
 * Body: { "status": "<database-allowed-review-status>", "review_note": "..." }
 * Review transitions are pending -> approved/rejected/etc. depending on the
 * actual time_off_request_status_valid CHECK constraint in the database.
 */
router.patch("/:id/review", canReview, async (req, res) => {
  const userId = currentUserId(req);
  const id = parseId(req.params.id);
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  if (!id) return res.status(400).json({ error: "Invalid ID" });
  if (!isRecord(req.body))
    return res.status(400).json({ error: "Expected JSON object" });
  try {
    const status = requiredText(req.body.status, 60);
    if (status === "pending")
      return res.status(400).json({ error: "Review status cannot be pending" });
    const note = optionalText(req.body.review_note);
    const result = await pool.query(
      `UPDATE portal.time_off_request
       SET status = $1, review_note = $2, reviewed_by_user_id = $3,
           reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4 AND status = 'pending'
       RETURNING ${fields}`,
      [status, note ?? null, userId, id],
    );
    if (!result.rows.length)
      return res
        .status(404)
        .json({ error: "Pending request not found or already reviewed" });
    return res.json(result.rows[0]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Expected"))
      return res.status(400).json({ error: error.message });
    return sendDbError(res, error);
  }
});

/** DELETE /time-off-requests/:id (requester; pending requests only) */
router.delete("/:id", canRead, async (req, res) => {
  const userId = currentUserId(req);
  const id = parseId(req.params.id);
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  if (!id) return res.status(400).json({ error: "Invalid ID" });
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
        .json({ error: "Pending request not found or cannot be deleted" });
    return res.status(204).send();
  } catch (error) {
    return sendDbError(res, error);
  }
});

export default router;
