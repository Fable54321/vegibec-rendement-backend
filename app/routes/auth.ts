import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "super_secret";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "super_refresh_secret";

function generateAccessToken(user: any) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    {
      expiresIn: "1h",
    },
  );
}

function generateRefreshToken(user: any) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    REFRESH_SECRET,
    {
      expiresIn: "7d",
    },
  );
}

function getCookieOptions(isProd: boolean, maxAge: number) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ("none" as const) : ("lax" as const),
    maxAge,
    path: "/",
  };
}

// LOGIN
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing username or password" });
    }

    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    const isProd = process.env.NODE_ENV === "production";

    res.cookie(
      "accessToken",
      accessToken,
      getCookieOptions(isProd, 60 * 60 * 1000), // 1 hour
    );

    res.cookie(
      "refreshToken",
      refreshToken,
      getCookieOptions(isProd, 7 * 24 * 60 * 60 * 1000), // 7 days
    );

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// REFRESH TOKEN
router.post("/refresh", (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ error: "Missing refresh token" });
  }

  try {
    const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as {
      id: number;
      username: string;
      role: string;
    };

    const newAccessToken = jwt.sign(
      {
        id: decoded.id,
        username: decoded.username,
        role: decoded.role,
      },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    const isProd = process.env.NODE_ENV === "production";

    res.cookie(
      "accessToken",
      newAccessToken,
      getCookieOptions(isProd, 60 * 60 * 1000),
    );

    res.json({ message: "Access token refreshed" });
  } catch (err) {
    console.error("Refresh error:", err);
    return res.status(403).json({ error: "Invalid or expired refresh token" });
  }
});

// LOGOUT
router.post("/logout", (req, res) => {
  const isProd = process.env.NODE_ENV === "production";

  const clearCookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ("none" as const) : ("lax" as const),
    path: "/",
  };

  res.clearCookie("accessToken", clearCookieOptions);
  res.clearCookie("refreshToken", clearCookieOptions);

  res.json({ message: "Vous êtes maintenant déconnecté" });
});

// CHANGE PASSWORD
router.post("/change-password", async (req, res) => {
  const token = req.cookies.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  let userId: number;

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: number;
      username: string;
      role: string;
    };

    userId = decoded.id;
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Missing current or new password" });
  }

  try {
    const result = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [userId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(currentPassword, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
      newHash,
      userId,
    ]);

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// AUTH CHECK
router.get("/me", async (req, res) => {
  const token = req.cookies.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: number;
    };

    const userResult = await pool.query(
      `
      SELECT id, username, email, name, surname
      FROM users
      WHERE id = $1
      `,
      [decoded.id],
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
      [decoded.id],
    );

    const user = userResult.rows[0];

    return res.json({
      user: {
        ...user,
        appAccess: appAccessResult.rows,
      },
    });
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
