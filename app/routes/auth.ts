import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db";
import type { CookieOptions } from "express";

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

const COOKIE_SAME_SITE: CookieOptions["sameSite"] = "none";

function getCookieOptions(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    // Browsers require Secure when SameSite=None. Keep these together.
    secure: true,
    sameSite: COOKIE_SAME_SITE,
    maxAge,
    path: "/",
  };
}

function getClearCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: COOKIE_SAME_SITE,
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
      return res
        .status(401)
        .json({ error: "Nom d'utilisateur ou mot de passe incorrect" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res
        .status(401)
        .json({ error: "Nom d'utilisateur ou mot de passe incorrect" });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    res.cookie(
      "accessToken",
      accessToken,
      getCookieOptions(60 * 60 * 1000), // 1 hour
    );

    res.cookie(
      "refreshToken",
      refreshToken,
      getCookieOptions(7 * 24 * 60 * 60 * 1000), // 7 days
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

    const newRefreshToken = jwt.sign(
      {
        id: decoded.id,
        username: decoded.username,
        role: decoded.role,
      },
      REFRESH_SECRET,
      { expiresIn: "7d" },
    );


    // ✅ set new access token
    res.cookie(
      "accessToken",
      newAccessToken,
      getCookieOptions(60 * 60 * 1000),
    );

    // ✅ IMPORTANT: rotate refresh token
    res.cookie(
      "refreshToken",
      newRefreshToken,
      getCookieOptions(7 * 24 * 60 * 60 * 1000),
    );

    res.json({ message: "Tokens refreshed" });
  } catch (err) {
    console.error("Refresh error:", err);
    return res.status(403).json({ error: "Invalid or expired refresh token" });
  }
});


router.post("/logout", (req, res) => {
  const clearCookieOptions = getClearCookieOptions();

  res.clearCookie("accessToken", clearCookieOptions);
  res.clearCookie("refreshToken", clearCookieOptions);

  res.json({ message: "Vous êtes maintenant déconnecté" });
});


router.post("/change-username", async (req, res) => {
  const token = req.cookies.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  let userId: number;
  let currentRole: string;

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: number;
      username: string;
      role: string;
    };

    userId = decoded.id;
    currentRole = decoded.role;
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const { currentPassword, newUsername } = req.body;

  if (!currentPassword || !newUsername) {
    return res
      .status(400)
      .json({ error: "Missing current password or new username" });
  }

  const normalizedUsername = String(newUsername).trim();

  if (!normalizedUsername) {
    return res.status(400).json({ error: "New username cannot be empty" });
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

    const existing = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [normalizedUsername],
    );

    if (existing.rowCount && existing.rowCount > 0 && existing.rows[0].id !== userId) {
      return res.status(409).json({ error: "Username already taken" });
    }

    await pool.query("UPDATE users SET username = $1 WHERE id = $2", [
      normalizedUsername,
      userId,
    ]);

    const updatedUser = {
      id: userId,
      username: normalizedUsername,
      role: currentRole,
    };

    const accessToken = generateAccessToken(updatedUser);
    const refreshToken = generateRefreshToken(updatedUser);
    res.cookie(
      "accessToken",
      accessToken,
      getCookieOptions(60 * 60 * 1000),
    );

    res.cookie(
      "refreshToken",
      refreshToken,
      getCookieOptions(7 * 24 * 60 * 60 * 1000),
    );

    res.json({
      message: "Username changed successfully",
      username: normalizedUsername,
    });
  } catch (err) {
    console.error("Change username error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

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

router.get("/me", async (req, res) => {
  const token = req.cookies.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };

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

    const agrivisionPrefsResult = await pool.query(
      `
      SELECT organic_filter_mode, trend_preference
      FROM user_agrivision_preferences
      WHERE user_id = $1
      `,
      [decoded.id],
    );

    const user = userResult.rows[0];
    const prefs = agrivisionPrefsResult.rows[0];

    return res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        surname: user.surname,
        full_name: `${user.name ?? ""} ${user.surname ?? ""}`.trim(),
        organic_filter_mode: prefs?.organic_filter_mode ?? "all",
        trend_preference: prefs?.trend_preference ?? "monthly",
        appAccess: appAccessResult.rows,
      },
    });
  } catch (err) {
    console.error("Error in /auth/me:", err);
    return res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
