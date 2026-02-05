import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

/**
 * GET /vegetables
 * Returns all available vegetable values
 */
router.get("/", requireRole(["admin", "guest"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT vegetable, isGeneric
      FROM vegetables
      ORDER BY vegetable
    `);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching vegetables:", error);
    res.status(500).json({ error: "Failed to fetch vegetables" });
  }
});

router.post("/", requireRole(["admin"]), async (req, res) => {
  try {
    const { vegetable, isGeneric } = req.body;

    if (!vegetable || typeof vegetable !== "string") {
      return res.status(400).json({ error: "Vegetable is required" });
    }

    const normalizedVegetable = vegetable.trim().toUpperCase();

    // Default isGeneric to false if not provided
    const genericValue = isGeneric === true;

    const insertResult = await pool.query(
      `
      INSERT INTO vegetables (vegetable, isGeneric)
      VALUES ($1, $2)
      ON CONFLICT (vegetable) DO UPDATE
        SET isGeneric = EXCLUDED.isGeneric
      RETURNING vegetable, isGeneric
      `,
      [normalizedVegetable, genericValue],
    );

    res.status(201).json(insertResult.rows[0]);
  } catch (error) {
    console.error("Error adding vegetable:", error);
    res.status(500).json({ error: "Failed to add vegetable" });
  }
});

/**
 * DELETE /vegetables/:vegetable
 * Removes a vegetable from the list
 */
router.delete("/:vegetable", requireRole(["admin"]), async (req, res) => {
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
});

export default router;
