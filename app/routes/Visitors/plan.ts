import { Router } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";



const router = Router();


const VISITOR_PLAN_TOKEN_SECRET =
  process.env.VISITOR_PLAN_TOKEN_SECRET ||
  process.env.JWT_SECRET ||
  "super_secret";



router.get("/visitor-plan/:token", async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({
        valid: false,
        error: "Missing token",
      });
    }

    const decoded = jwt.verify(
      token,
      VISITOR_PLAN_TOKEN_SECRET,
    ) as JwtPayload & {
      scope?: string;
    };

    if (decoded.scope !== "visitor-plan") {
      return res.status(403).json({
        valid: false,
        error: "Invalid token scope",
      });
    }

    return res.status(200).json({
      valid: true,
      expiresAt: decoded.exp
        ? new Date(decoded.exp * 1000).toISOString()
        : undefined,
    });
  } catch (error: any) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        valid: false,
        error: "Token expired",
      });
    }

    return res.status(401).json({
      valid: false,
      error: "Invalid token",
    });
  }
});

export default router;