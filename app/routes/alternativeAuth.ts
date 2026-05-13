import { Router } from "express";
import { pool } from "../db";
import { authMiddleware } from "../middleware/auth";
import crypto from "crypto";

const router = Router();




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

      const rawToken = crypto.randomBytes(64).toString("hex");

      const tokenHash = 
        crypto.createHash("sha256")
        .update(rawToken)
        .digest("hex");

      const expiresAt = new Date(
        Date.now() + 1000 * 60 * 60 * 24 * 180, // 180 days
      );

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
          "toolbox",
          tokenHash,
          "Toolbox Tablet",
          expiresAt,
        ],
      );

      res.cookie("toolboxDeviceToken", rawToken, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 1000 * 60 * 60 * 24 * 180,
      });

      return res.json({
        success: true,
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