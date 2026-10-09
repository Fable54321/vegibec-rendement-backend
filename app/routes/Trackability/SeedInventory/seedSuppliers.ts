
import express from "express";
import { pool } from "../../../db";
import { requireAppRole } from "../../../middleware/auth";

const router = express.Router();

interface SeedSupplier {
  id: number;
  name: string;
  is_active: boolean;
}


router.get(
  "/",
  requireAppRole("main", ["admin", "user", "guest"]),
  async (req, res) => {
    try {
      const result = await pool.query<SeedSupplier>(
        `SELECT id, name, is_active
         FROM trackability.seed_supplier
         ORDER BY name ASC`
      );

      res.status(200).json(result.rows);
    } catch (error) {
      console.error("Error fetching seed suppliers:", error);
      res.status(500).json({
        error: "Failed to fetch seed suppliers",
      });
    }
  }
);

// GET /seed-suppliers/:id
// Retrieve a single supplier
router.get(
  "/:id",
  requireAppRole("main", ["admin", "user", "guest"]),
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid supplier ID" });
    }

    try {
      const result = await pool.query<SeedSupplier>(
        `SELECT id, name, is_active
         FROM trackability.seed_supplier
         WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Seed supplier not found",
        });
      }

      res.status(200).json(result.rows[0]);
    } catch (error) {
      console.error("Error fetching seed supplier:", error);
      res.status(500).json({
        error: "Failed to fetch seed supplier",
      });
    }
  }
);

// POST /seed-suppliers
// Create a new supplier
router.post(
  "/",
  requireAppRole("main", ["admin", "user"]),
  async (req, res) => {
    const { name } = req.body;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        error: "Supplier name is required",
      });
    }

    try {
      const result = await pool.query<SeedSupplier>(
        `INSERT INTO trackability.seed_supplier (name)
         VALUES ($1)
         RETURNING id, name, is_active`,
        [name.trim()]
      );

      res.status(201).json(result.rows[0]);
    } catch (error: any) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "A supplier with this name already exists",
        });
      }

      console.error("Error creating seed supplier:", error);
      res.status(500).json({
        error: "Failed to create seed supplier",
      });
    }
  }
);

// PATCH /seed-suppliers/:id
// Update supplier name or active status
router.patch(
  "/:id",
  requireAppRole("main", ["admin", "user"]),
  async (req, res) => {
    const id = Number(req.params.id);
    const { name, is_active } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid supplier ID" });
    }

    if (
      name === undefined &&
      is_active === undefined
    ) {
      return res.status(400).json({
        error: "No fields provided for update",
      });
    }

    if (
      name !== undefined &&
      (typeof name !== "string" || !name.trim())
    ) {
      return res.status(400).json({
        error: "Invalid supplier name",
      });
    }

    if (
      is_active !== undefined &&
      typeof is_active !== "boolean"
    ) {
      return res.status(400).json({
        error: "is_active must be a boolean",
      });
    }

    try {
      const result = await pool.query<SeedSupplier>(
        `UPDATE trackability.seed_supplier
         SET
           name = COALESCE($1, name),
           is_active = COALESCE($2, is_active)
         WHERE id = $3
         RETURNING id, name, is_active`,
        [
          name !== undefined ? name.trim() : null,
          is_active ?? null,
          id,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Seed supplier not found",
        });
      }

      res.status(200).json(result.rows[0]);
    } catch (error: any) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "A supplier with this name already exists",
        });
      }

      console.error("Error updating seed supplier:", error);
      res.status(500).json({
        error: "Failed to update seed supplier",
      });
    }
  }
);

// DELETE /seed-suppliers/:id
// Delete a supplier
router.delete(
  "/:id",
  requireAppRole("main", ["admin"]),
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid supplier ID" });
    }

    try {
      const result = await pool.query(
        `DELETE FROM trackability.seed_supplier
         WHERE id = $1
         RETURNING id`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Seed supplier not found",
        });
      }

      res.status(200).json({
        message: "Seed supplier deleted successfully",
      });
    } catch (error: any) {
      if (error.code === "23503") {
        return res.status(409).json({
          error: "Cannot delete a supplier that is referenced by other records. Deactivate it instead.",
        });
      }

      console.error("Error deleting seed supplier:", error);
      res.status(500).json({
        error: "Failed to delete seed supplier",
      });
    }
  }
);

export default router;
