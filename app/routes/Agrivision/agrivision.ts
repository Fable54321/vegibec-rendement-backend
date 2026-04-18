import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../db";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET!;

type JwtPayload = { id: number };

const getUserIdFromCookie = (req: express.Request): number | null => {
  const token = req.cookies.accessToken;

  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    return decoded.id;
  } catch {
    return null;
  }
};



router.get("/vegetables", async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        commodity,
        var,
        properties,
        french_display_name,
        english_display_name
      FROM agrivision.vegetables
      ORDER BY french_display_name ASC NULLS LAST, commodity ASC NULLS LAST
      `
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching agrivision vegetables:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


router.get("/preferences", async (req, res) => {
  const userId = getUserIdFromCookie(req);

  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        organic_filter_mode,
        trend_preference
      FROM agrivision.preferences
      WHERE user_id = $1
      `,
      [userId]
    );

    const prefs = result.rows[0];

    return res.status(200).json({
      organic_filter_mode: prefs?.organic_filter_mode ?? "all",
      trend_preference: prefs?.trend_preference ?? "monthly",
    });
  } catch (err) {
    console.error("Error fetching agrivision preferences:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


router.get("/preferences/vegetables", async (req, res) => {
  const userId = getUserIdFromCookie(req);

  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        v.id,
        v.commodity,
        v.var,
        v.properties,
        v.french_display_name,
        v.english_display_name
      FROM agrivision.preference_vegetables pv
      JOIN agrivision.vegetables v
        ON v.id = pv.vegetable_id
      WHERE pv.user_id = $1
      ORDER BY v.french_display_name ASC NULLS LAST, v.commodity ASC NULLS LAST
      `,
      [userId]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching agrivision user vegetables:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


router.post("/preferences", async (req, res) => {
  const userId = getUserIdFromCookie(req);

  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  try {
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
        trend_preference
      )
    ) {
      return res.status(400).json({ error: "Invalid trend_preference" });
    }

    await pool.query(
      `
      INSERT INTO agrivision.preferences (
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
          agrivision.preferences.organic_filter_mode
        ),
        trend_preference = COALESCE(
          EXCLUDED.trend_preference,
          agrivision.preferences.trend_preference
        ),
        updated_at = NOW()
      `,
      [userId, organic_filter_mode ?? null, trend_preference ?? null]
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
  const userId = getUserIdFromCookie(req);

  if (!userId) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  const client = await pool.connect();

  try {
    const { vegetableIds } = req.body;

    if (
      !Array.isArray(vegetableIds) ||
      vegetableIds.some(
        (id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0
      )
    ) {
      return res.status(400).json({ error: "Invalid vegetableIds" });
    }

    await client.query("BEGIN");

    if (vegetableIds.length > 0) {
      const existingVegetables = await client.query(
        `
        SELECT id
        FROM agrivision.vegetables
        WHERE id = ANY($1::int[])
        `,
        [vegetableIds]
      );

      if (existingVegetables.rows.length !== vegetableIds.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "One or more vegetableIds are invalid",
        });
      }
    }

    await client.query(
      `
      DELETE FROM agrivision.preference_vegetables
      WHERE user_id = $1
      `,
      [userId]
    );

    if (vegetableIds.length > 0) {
      const values = vegetableIds.map((_, i) => `($1, $${i + 2})`).join(",");

      await client.query(
        `
        INSERT INTO agrivision.preference_vegetables (user_id, vegetable_id)
        VALUES ${values}
        `,
        [userId, ...vegetableIds]
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