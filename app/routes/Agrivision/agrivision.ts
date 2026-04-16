import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../db";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET!;



router.post("/preferences", async (req, res) => {
  const token = req.cookies.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
    const userId = decoded.id;

    const { organic_filter_mode, trend_preference } = req.body;

    if (
      organic_filter_mode !== undefined &&
      !["all", "exclude_organic", "only_organic"].includes(organic_filter_mode)
    ) {
      return res.status(400).json({ error: "Invalid organic_filter_mode" });
    }

    if (
      trend_preference !== undefined &&
      !["daily", "weekly", "monthly", "90days", "1year", "5years"].includes(
        trend_preference,
      )
    ) {
      return res.status(400).json({ error: "Invalid trend_preference" });
    }

    await pool.query(
      `
      INSERT INTO user_agrivision_preferences (
        user_id,
        organic_filter_mode,
        trend_preference,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        COALESCE($2, 'all'),
        COALESCE($3, 'monthly'),
        NOW(),
        NOW()
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        organic_filter_mode = COALESCE(
          EXCLUDED.organic_filter_mode,
          user_agrivision_preferences.organic_filter_mode
        ),
        trend_preference = COALESCE(
          EXCLUDED.trend_preference,
          user_agrivision_preferences.trend_preference
        ),
        updated_at = NOW()
      `,
      [userId, organic_filter_mode ?? null, trend_preference ?? null],
    );

    return res.status(200).json({
      message: "Preferences updated successfully",
    });
  } catch (err) {
    console.error("Error updating agrivision preferences:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


router.post("/preferences/vegetables", async (req, res) => {
  const token = req.cookies.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  const client = await pool.connect();

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
    const userId = decoded.id;

    const { vegetables } = req.body;

    if (
      !Array.isArray(vegetables) ||
      vegetables.some((v) => typeof v !== "string" || !v.trim())
    ) {
      return res.status(400).json({ error: "Invalid vegetables list" });
    }

    await client.query("BEGIN");

    await client.query(
      `DELETE FROM user_agrivision_preference_vegetables WHERE user_id = $1`,
      [userId],
    );

    if (vegetables.length > 0) {
      const values = vegetables
        .map((_, i) => `($1, $${i + 2})`)
        .join(",");

      await client.query(
        `
        INSERT INTO user_agrivision_preference_vegetables (user_id, vegetable_name)
        VALUES ${values}
        `,
        [userId, ...vegetables.map((v) => v.trim())],
      );
    }

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Vegetables updated successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating agrivision vegetables:", err);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

export default router;
