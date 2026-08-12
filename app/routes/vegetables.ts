import express from "express";
import { pool } from "../db";
import { requireAppRole } from "../middleware/auth";

const router = express.Router();

const readRoles = requireAppRole("rendement", ["admin", "user", "guest"]);

function parseCultivarId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;

  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647
    ? id
    : null;
}

/**
 * GET /vegetables
 * Returns all available vegetable values
 */
router.get(
  "/",
  async (req, res) => {
    try {
      const result = await pool.query(`
      SELECT 
        vegetable,
        is_generic,
        generic_group
      FROM vegetables
      ORDER BY vegetable
    `);

      res.status(200).json(result.rows);
    } catch (error) {
      console.error("Error fetching vegetables:", error);
      res.status(500).json({ error: "Failed to fetch vegetables" });
    }
  },
);

/**
 * GET /vegetables/cultivars
 * Returns all cultivars with their vegetable.
 */
router.get("/cultivars", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.vegetable_id,
        v.vegetable,
        c.cultivar
      FROM public.cultivars c
      INNER JOIN public.vegetables v ON v.id = c.vegetable_id
      ORDER BY v.vegetable, c.cultivar, c.id
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching cultivars:", error);
    return res.status(500).json({ error: "Failed to fetch cultivars" });
  }
});


router.get("/cultivars/:cultivarId", async (req, res) => {
  const cultivarId = parseCultivarId(req.params.cultivarId);
  if (cultivarId === null) {
    return res.status(400).json({ error: "Invalid cultivarId" });
  }

  try {
    const result = await pool.query(
      `SELECT
         c.id,
         c.vegetable_id,
         v.vegetable,
         c.cultivar
       FROM public.cultivars c
       INNER JOIN public.vegetables v ON v.id = c.vegetable_id
       WHERE c.id = $1`,
      [cultivarId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Cultivar not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching cultivar:", error);
    return res.status(500).json({ error: "Failed to fetch cultivar" });
  }
});

router.post("/", requireAppRole("rendement", ["admin"]), async (req, res) => {
  try {
    const { vegetable, is_generic, generic_group } = req.body;

    // --- Validation ---
    if (!vegetable || typeof vegetable !== "string") {
      return res.status(400).json({ error: "Vegetable is required" });
    }

    const normalizedVegetable = vegetable.trim().toUpperCase();

    // Default values
    const isGenericValue = is_generic === true;
    const normalizedGroup =
      typeof generic_group === "string" && generic_group.trim() !== ""
        ? generic_group.trim().toUpperCase()
        : null;

    // --- Business rules ---
    if (isGenericValue && normalizedGroup !== null) {
      return res.status(400).json({
        error: "A generic group cannot belong to another generic group",
      });
    }

    // If it's not generic but has no group → it's a normal standalone vegetable
    // → allowed

    // --- Insert ---
    const insertResult = await pool.query(
      `
      INSERT INTO vegetables (vegetable, is_generic, generic_group)
      VALUES ($1, $2, $3)

      ON CONFLICT (vegetable) DO UPDATE
        SET 
          is_generic = EXCLUDED.is_generic,
          generic_group = EXCLUDED.generic_group

      RETURNING vegetable, is_generic, generic_group
      `,
      [normalizedVegetable, isGenericValue, normalizedGroup],
    );

    res.status(201).json(insertResult.rows[0]);
  } catch (error) {
    console.error("Error adding vegetable:", error);
    res.status(500).json({ error: "Failed to add vegetable" });
  }
});


router.delete(
  "/:vegetable",
  requireAppRole("rendement", ["admin"]),
  async (req, res) => {
    try {
      const { vegetable } = req.params;

      if (!vegetable) {
        return res.status(400).json({ error: "Vegetable is required" });
      }

      // Normalize to match insert logic
      const normalizedVegetable = vegetable.trim().toUpperCase();

      const result = await pool.query(
        `
        DELETE FROM vegetables
        WHERE vegetable = $1
        RETURNING vegetable
        `,
        [normalizedVegetable],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Vegetable not found" });
      }

      res.status(200).json({
        deleted: result.rows[0].vegetable,
      });
    } catch (error) {
      console.error("Error deleting vegetable:", error);
      res.status(500).json({ error: "Failed to delete vegetable" });
    }
  },
);

export default router;
