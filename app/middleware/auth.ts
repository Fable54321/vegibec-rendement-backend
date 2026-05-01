import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { pool } from "../db";

const JWT_SECRET = process.env.JWT_SECRET || "super_secret";

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; username: string; role?: string };
      appRole?: string;
    }
  }
}

export const authMiddleware = (
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

  const token = req.cookies.accessToken;

  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload & {
      id: number;
      username: string;
      role?: string;
    };

    req.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role, // optional legacy field
    };

    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }

    return res.status(401).json({ message: "Invalid token" });
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
