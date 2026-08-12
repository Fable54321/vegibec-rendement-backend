import express from "express";
import { pool } from "../db";
import { requireAppRole } from "../middleware/auth";

const router = express.Router();

/**
 * GET /getFields
 * Returns all available field values
 */
router.get(
  "/",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, field FROM public.fields ORDER BY field`,
      );

      res.status(200).json(result.rows);
    } catch (error) {
      console.error("Error fetching fields:", error);
      res.status(500).json({ error: "Failed to fetch fields" });
    }
  },
);

router.post("/", requireAppRole("rendement", ["admin"]), async (req, res) => {
  const { field } = req.body;

  if (!field || typeof field !== "string") {
    return res.status(400).json({ error: "Field is required" });
  }

  const normalizedField = field.trim().toUpperCase();

  try {
    const result = await pool.query(
      `INSERT INTO fields (field)
       VALUES ($1)
       RETURNING field`,
      [normalizedField],
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    // UNIQUE constraint violation
    if (error.code === "23505") {
      return res
        .status(409)
        .json({ error: `Le champ "${normalizedField}" existe déjà.` });
    }

    console.error("Error adding field:", error);
    res.status(500).json({ error: "Échec de l'ajout du champ." });
  }
});

router.delete("/", requireAppRole("rendement", ["admin"]), async (req, res) => {
  const { field } = req.body;

  if (!field || typeof field !== "string") {
    return res.status(400).json({ error: "Field is required" });
  }

  const normalizedField = field.trim().toUpperCase();

  try {
    const result = await pool.query(`DELETE FROM fields WHERE field = $1`, [
      normalizedField,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Field not found" });
    }

    res.status(200).json({ message: "Field deleted" });
  } catch (error) {
    console.error("Error deleting field:", error);
    res.status(500).json({ error: "Failed to delete field" });
  }
});

export default router;
