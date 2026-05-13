import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { pool } from "../db";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || "super_secret";

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; username: string; role?: string };
      appRole?: string;
    }
  }
}

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const publicPaths = ["/api/vegReports", "/auth", "/visitors/plan-access"];

  if (publicPaths.some((path) => req.originalUrl.startsWith(path))) {
    return next();
  }

  if (req.method === "OPTIONS") {
    return next();
  }

  // =========================
  // 1. NORMAL ACCESS TOKEN
  // =========================

  const accessToken = req.cookies.accessToken;

  if (accessToken) {
    try {
      const decoded = jwt.verify(accessToken, JWT_SECRET) as JwtPayload & {
        id: number;
        username: string;
        role?: string;
      };

      req.user = {
        id: decoded.id,
        username: decoded.username,
        role: decoded.role,
      };

      return next();
    } catch (err: any) {
      // Ignore expired/invalid token
      // We will try the device token fallback
    }
  }

  // =========================
  // 2. TOOLBOX DEVICE TOKEN
  // =========================

  const deviceToken = req.cookies.toolboxDeviceToken;

  if (!deviceToken) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    const tokenHash = crypto
      .createHash("sha256")
      .update(deviceToken)
      .digest("hex");

    const result = await pool.query(
      `
      SELECT
        ds.user_id,
        ds.expires_at,
        ds.revoked_at,
        u.username
      FROM device_sessions ds
      JOIN users u ON u.id = ds.user_id
      WHERE ds.token_hash = $1
      LIMIT 1
      `,
      [tokenHash],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid device token" });
    }

    const session = result.rows[0];

    if (session.revoked_at) {
      return res.status(401).json({ message: "Device session revoked" });
    }

    if (new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ message: "Device session expired" });
    }

    req.user = {
      id: session.user_id,
      username: session.username,
    };

    await pool.query(
      `
      UPDATE device_sessions
      SET last_used_at = NOW()
      WHERE token_hash = $1
      `,
      [tokenHash],
    );

    return next();
  } catch (error) {
    console.error("authMiddleware device session error:", error);

    return res.status(500).json({
      message: "Server error",
    });
  }
};

export const requireAppRole = (appSlug: string, allowedRoles: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated" });
      }

      const result = await pool.query(
        `
        SELECT uar.role
        FROM user_app_roles uar
        JOIN apps a ON a.id = uar.app_id
        WHERE uar.user_id = $1
          AND a.slug = $2
        LIMIT 1
        `,
        [req.user.id, appSlug],
      );

      if (result.rows.length === 0) {
        return res.status(403).json({ message: "Access denied" });
      }

      const appRole = result.rows[0].role;

      if (!allowedRoles.includes(appRole)) {
        return res.status(403).json({ message: "Access denied test" });
      }

      req.appRole = appRole;
      next();
    } catch (error) {
      console.error("requireAppRole error:", error);
      return res.status(500).json({ message: "Server error" });
    }
  };
};
