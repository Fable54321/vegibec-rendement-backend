import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "super_secret";

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: { id: number; username: string; role?: string };
    }
  }
}

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Skip auth for public routes
  const publicPaths = ["/api/vegReports", "/auth"];
  if (publicPaths.some((path) => req.originalUrl.startsWith(path))) {
    return next();
  }

  // Skip auth for OPTIONS requests (CORS preflight)
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
      role: decoded.role,
    };

    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }

    return res.status(401).json({ message: "Invalid token" });
  }
};

export const requireRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({ message: "Role not found" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }

    next();
  };
};
