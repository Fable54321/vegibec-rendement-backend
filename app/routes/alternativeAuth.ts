import { Response, Router } from "express";
import { pool } from "../db";
import { authMiddleware } from "../middleware/auth";
import crypto from "crypto";

const router = Router();
const DEVICE_SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 180; // 180 days
const DEVICE_SESSION_REUSE_BUFFER_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const setToolboxDeviceCookie = (
  res: Response,
  rawToken: string,
  expiresAt: Date,
) => {
  res.cookie("toolboxDeviceToken", rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    expires: expiresAt,
  });
};

router.get("/persistent/me", authMiddleware, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const userResult = await pool.query(
    `
    SELECT id, username, email, name, surname
    FROM users
    WHERE id = $1
    `,
    [req.user.id],
  );

  if (userResult.rows.length === 0) {
    return res.status(404).json({ error: "User not found" });
  }

  const appAccessResult = await pool.query(
    `
    SELECT a.slug, uar.role
    FROM user_app_roles uar
    JOIN apps a ON a.id = uar.app_id
    WHERE uar.user_id = $1
    ORDER BY a.slug
    `,
    [req.user.id],
  );

  const user = userResult.rows[0];

  return res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      surname: user.surname,
      full_name: `${user.name ?? ""} ${user.surname ?? ""}`.trim(),
      appAccess: appAccessResult.rows,
    },
  });
});

router.post(
  "/create-toolbox-device-session",
  authMiddleware,
  async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          message: "Not authenticated",
        });
      }

      const requestedAppSlug = req.body?.appSlug ?? req.body?.app_slug;
      const appSlug =
        typeof requestedAppSlug === "string" && requestedAppSlug.trim()
          ? requestedAppSlug.trim().toLowerCase()
          : "toolbox";

      if (!/^[a-z0-9_-]+$/.test(appSlug)) {
        return res.status(400).json({
          message: "Invalid app slug",
        });
      }

      const existingRawToken = req.cookies.toolboxDeviceToken;

      if (typeof existingRawToken === "string" && existingRawToken.length > 0) {
        const existingTokenHash = crypto
          .createHash("sha256")
          .update(existingRawToken)
          .digest("hex");

        const existingSessionResult = await pool.query<{ expires_at: Date }>(
          `
          UPDATE auth.device_sessions
          SET last_used_at = NOW()
          WHERE token_hash = $1
            AND user_id = $2
            AND app_slug = $3
            AND revoked_at IS NULL
            AND expires_at > NOW() + ($4 * INTERVAL '1 millisecond')
          RETURNING expires_at
          `,
          [
            existingTokenHash,
            req.user.id,
            appSlug,
            DEVICE_SESSION_REUSE_BUFFER_MS,
          ],
        );

        if (existingSessionResult.rows.length > 0) {
          const expiresAt = new Date(
            existingSessionResult.rows[0].expires_at,
          );

          setToolboxDeviceCookie(res, existingRawToken, expiresAt);

          return res.json({
            success: true,
            app_slug: appSlug,
            reused: true,
            expires_at: expiresAt.toISOString(),
          });
        }
      }

      const rawToken = crypto.randomBytes(64).toString("hex");

      const tokenHash = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");

      const expiresAt = new Date(Date.now() + DEVICE_SESSION_DURATION_MS);

      await pool.query(
        `
        INSERT INTO auth.device_sessions (
          user_id,
          app_slug,
          token_hash,
          device_name,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          req.user.id,
          appSlug,
          tokenHash,
          "Toolbox Tablet",
          expiresAt,
        ],
      );

      setToolboxDeviceCookie(res, rawToken, expiresAt);

      return res.json({
        success: true,
        app_slug: appSlug,
        reused: false,
        expires_at: expiresAt.toISOString(),
      });
    } catch (error) {
      console.error("create-toolbox-device-session error:", error);

      return res.status(500).json({
        message: "Server error",
      });
    }
  },
);

export default router;
