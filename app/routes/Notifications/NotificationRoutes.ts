
import { Router, type Request, type Response } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const canRead = requireAppRole("main", [
  "admin",
  "user",
  "guest",
]);

const canCreate = requireAppRole("main", ["admin", "user"]);

type AuthRequest = Request & {
  user?: {
    id: number | string;
  };
};

type DbError = Error & {
  code?: string;
  constraint?: string;
};

// ============================================
// HELPERS
// ============================================

const getUserId = (req: Request): number | null => {
  const id = Number((req as AuthRequest).user?.id);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
};

const parseId = (value: unknown): number | null => {
  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
};

const isRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

const requiredText = (
  value: unknown,
  maxLength: number,
): string | null => {
  if (typeof value !== "string") return null;

  const text = value.trim();

  return text.length > 0 && text.length <= maxLength
    ? text
    : null;
};

const optionalText = (
  value: unknown,
  maxLength: number,
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  return requiredText(value, maxLength) ?? undefined;
};

const isValidActionLink = (value: string): boolean => {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\u0000-\u001F\u007F]/.test(value) &&
    !value.split(/[?#]/, 1)[0]
      .split("/")
      .some((segment) => {
        try {
          return decodeURIComponent(segment) === "..";
        } catch {
          return true;
        }
      })
  );
};

const allowedApps = new Set([
  "portal",
  "timesheets",
]);

const notificationColumns = `
  n.id,
  n.user_id,
  n.sender_user_id,
  n.type_id,
  n.title,
  n.message,
  n.action_link,
  n.source_type,
  n.source_id,
  n.target_app,
  n.read_at,
  n.created_at,
  t.code AS type_code,
  t.label AS type_label,
  t.icon AS type_icon
`;

const notificationFrom = `
  FROM portal.notifications n
  JOIN portal.notification_types t
    ON t.id = n.type_id
`;

const sendDbError = (
  res: Response,
  error: unknown,
): Response => {
  console.error("Notification database error:", error);

  const err = error as DbError;

  if (err.code === "23503") {
    return res.status(400).json({
      error: "Referenced record does not exist",
    });
  }

  if (err.code === "23514") {
    return res.status(400).json({
      error: "Value rejected by database constraint",
      constraint: err.constraint,
    });
  }

  if (err.code === "23505") {
    return res.status(409).json({
      error: "Notification already exists",
    });
  }

  return res.status(500).json({
    error: "Internal server error",
  });
};

// ============================================
// GET /notifications/types
// ============================================

router.get("/types", canRead, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, code, label, icon, is_active
      FROM portal.notification_types
      WHERE is_active = TRUE
      ORDER BY label ASC
    `);

    return res.json({
      data: result.rows,
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ============================================
// GET /notifications/unread-count
// ============================================

router.get("/unread-count", canRead, async (req, res) => {
  const userId = getUserId(req);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthenticated",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM portal.notifications
      WHERE user_id = $1
        AND read_at IS NULL
      `,
      [userId],
    );

    return res.json({
      count: result.rows[0].count,
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ============================================
// GET /notifications
//
// Query:
//   page=1
//   limit=20
//   unread=true | false
// ============================================

router.get("/", canRead, async (req, res) => {
  const userId = getUserId(req);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthenticated",
    });
  }

  const page = Math.max(
    1,
    Math.min(100000, Number(req.query.page) || 1),
  );

  const limit = Math.max(
    1,
    Math.min(100, Number(req.query.limit) || 20),
  );

  const unread = req.query.unread;

  if (
    unread !== undefined &&
    unread !== "true" &&
    unread !== "false"
  ) {
    return res.status(400).json({
      error: "unread must be true or false",
    });
  }

  const unreadFilter =
    unread === "true"
      ? true
      : unread === "false"
        ? false
        : null;

  try {
    const result = await pool.query(
      `
      SELECT
        ${notificationColumns},
        COUNT(*) OVER()::int AS total_count
      ${notificationFrom}
      WHERE n.user_id = $1
        AND (
          $2::boolean IS NULL
          OR ($2::boolean = TRUE AND n.read_at IS NULL)
          OR ($2::boolean = FALSE AND n.read_at IS NOT NULL)
        )
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $3 OFFSET $4
      `,
      [
        userId,
        unreadFilter,
        limit,
        (page - 1) * limit,
      ],
    );

    const total = result.rows[0]?.total_count ?? 0;

    const data = result.rows.map(
      ({ total_count: _totalCount, ...row }) => {
        void _totalCount;
        return row;
      },
    );

    return res.json({
      data,
      page,
      limit,
      total,
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ============================================
// PATCH /notifications/read-all
// ============================================

router.patch("/read-all", canRead, async (req, res) => {
  const userId = getUserId(req);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthenticated",
    });
  }

  try {
    const result = await pool.query(
      `
      UPDATE portal.notifications
      SET read_at = NOW()
      WHERE user_id = $1
        AND read_at IS NULL
      RETURNING id
      `,
      [userId],
    );

    return res.json({
      success: true,
      updated: result.rowCount ?? 0,
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ============================================
// PATCH /notifications/:id/read
// ============================================

router.patch("/:id/read", canRead, async (req, res) => {
  const userId = getUserId(req);
  const notificationId = parseId(req.params.id);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthenticated",
    });
  }

  if (!notificationId) {
    return res.status(400).json({
      error: "Invalid notification ID",
    });
  }

  try {
    const result = await pool.query(
      `
      UPDATE portal.notifications
      SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND user_id = $2
      RETURNING *
      `,
      [notificationId, userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Notification not found",
      });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ============================================
// PATCH /notifications/:id/unread
// ============================================

router.patch("/:id/unread", canRead, async (req, res) => {
  const userId = getUserId(req);
  const notificationId = parseId(req.params.id);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthenticated",
    });
  }

  if (!notificationId) {
    return res.status(400).json({
      error: "Invalid notification ID",
    });
  }

  try {
    const result = await pool.query(
      `
      UPDATE portal.notifications
      SET read_at = NULL
      WHERE id = $1 AND user_id = $2
      RETURNING *
      `,
      [notificationId, userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Notification not found",
      });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ============================================
// DELETE /notifications/all
// ============================================

router.delete("/all", canRead, async (req, res) => {
  const userId = getUserId(req);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthenticated",
    });
  }

  try {
    const result = await pool.query(
      `
      DELETE FROM portal.notifications
      WHERE user_id = $1
      RETURNING id
      `,
      [userId],
    );

    return res.json({
      success: true,
      deleted: result.rowCount ?? 0,
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ============================================
// DELETE /notifications/:id
// ============================================

router.delete("/:id", canRead, async (req, res) => {
  const userId = getUserId(req);
  const notificationId = parseId(req.params.id);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthenticated",
    });
  }

  if (!notificationId) {
    return res.status(400).json({
      error: "Invalid notification ID",
    });
  }

  try {
    const result = await pool.query(
      `
      DELETE FROM portal.notifications
      WHERE id = $1 AND user_id = $2
      RETURNING id
      `,
      [notificationId, userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Notification not found",
      });
    }

    return res.status(204).send();
  } catch (error) {
    return sendDbError(res, error);
  }
});




router.post("/", canCreate, async (req, res) => {
  const senderUserId = getUserId(req);

  if (!senderUserId) {
    return res.status(401).json({
      error: "Unauthenticated",
    });
  }

  if (!isRecord(req.body)) {
    return res.status(400).json({
      error: "Expected JSON object",
    });
  }

  const userId = parseId(req.body.user_id);

  const typeCode = requiredText(
    req.body.type_code,
    100,
  );

  const title = requiredText(
    req.body.title,
    200,
  );

  const message = requiredText(
    req.body.message,
    10000,
  );

  const actionLink = optionalText(
    req.body.action_link,
    2000,
  );

  const sourceType = optionalText(
    req.body.source_type,
    100,
  );

  const sourceId = optionalText(
    req.body.source_id,
    255,
  );

  const targetApp = requiredText(
    req.body.target_app ?? "portal",
    50,
  );

  if (!userId || !typeCode || !title || !message) {
    return res.status(400).json({
      error:
        "user_id, type_code, title and message are required",
    });
  }

  if (
    actionLink === undefined ||
    sourceType === undefined ||
    sourceId === undefined
  ) {
    return res.status(400).json({
      error: "Invalid optional field",
    });
  }

  if (!targetApp || !allowedApps.has(targetApp)) {
    return res.status(400).json({
      error: "Invalid target_app",
    });
  }

  if (actionLink && !isValidActionLink(actionLink)) {
    return res.status(400).json({
      error: "action_link must be a safe relative path",
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO portal.notifications (
        user_id,
        sender_user_id,
        type_id,
        title,
        message,
        action_link,
        target_app,
        source_type,
        source_id
      )
      SELECT
        $1,
        $2,
        t.id,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9
      FROM portal.notification_types t
      WHERE t.code = $3
        AND t.is_active = TRUE
      RETURNING *
      `,
      [
        userId,
        senderUserId,
        typeCode,
        title,
        message,
        actionLink,
        targetApp,
        sourceType,
        sourceId,
      ],
    );

    if (!result.rows.length) {
      return res.status(400).json({
        error: "Unknown or inactive notification type",
      });
    }

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return sendDbError(res, error);
  }
});

export default router;
