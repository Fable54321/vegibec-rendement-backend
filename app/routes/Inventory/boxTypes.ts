import { Router } from "express";
import { pool } from "../../db";

const router = Router();

interface BoxType {
  id: number;
  box_type: string;
  vegetable_id: number;
}

// GET all box types
router.get("/", async (_req, res) => {
  try {
    const result = await pool.query<BoxType>(`
      SELECT
        id,
        box_type,
        vegetable_id
      FROM inventory.box_types
      ORDER BY box_type ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching box types:", error);

    res.status(500).json({
      error: "Failed to fetch box types.",
    });
  }
});

// GET one box type
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Invalid box type ID.",
      });
    }

    const result = await pool.query<BoxType>(
      `
      SELECT
        id,
        box_type,
        vegetable_id
      FROM inventory.box_types
      WHERE id = $1
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Box type not found.",
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching box type:", error);

    res.status(500).json({
      error: "Failed to fetch box type.",
    });
  }
});

// GET box types for a specific vegetable
router.get("/vegetable/:vegetableId", async (req, res) => {
  try {
    const vegetableId = Number(req.params.vegetableId);

    if (!Number.isInteger(vegetableId)) {
      return res.status(400).json({
        error: "Invalid vegetable ID.",
      });
    }

    const result = await pool.query<BoxType>(
      `
      SELECT
        id,
        box_type,
        vegetable_id
      FROM inventory.box_types
      WHERE vegetable_id = $1
      ORDER BY box_type ASC
      `,
      [vegetableId],
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching box types by vegetable:", error);

    res.status(500).json({
      error: "Failed to fetch box types.",
    });
  }
});

// CREATE
router.post("/", async (req, res) => {
  try {
    const { box_type, vegetable_id } = req.body;

    if (
      typeof box_type !== "string" ||
      !box_type.trim() ||
      !Number.isInteger(Number(vegetable_id))
    ) {
      return res.status(400).json({
        error: "box_type and vegetable_id are required.",
      });
    }

    const result = await pool.query<BoxType>(
      `
      INSERT INTO inventory.box_types (
        box_type,
        vegetable_id
      )
      VALUES ($1, $2)
      RETURNING
        id,
        box_type,
        vegetable_id
      `,
      [box_type.trim(), Number(vegetable_id)],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating box type:", error);

    res.status(500).json({
      error: "Failed to create box type.",
    });
  }
});

// UPDATE
router.patch("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { box_type, vegetable_id } = req.body;

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Invalid box type ID.",
      });
    }

    const result = await pool.query<BoxType>(
      `
      UPDATE inventory.box_types
      SET
        box_type = COALESCE($1, box_type),
        vegetable_id = COALESCE($2, vegetable_id)
      WHERE id = $3
      RETURNING
        id,
        box_type,
        vegetable_id
      `,
      [
        typeof box_type === "string" ? box_type.trim() : null,
        vegetable_id !== undefined ? Number(vegetable_id) : null,
        id,
      ],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Box type not found.",
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating box type:", error);

    res.status(500).json({
      error: "Failed to update box type.",
    });
  }
});

// DELETE
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Invalid box type ID.",
      });
    }

    const result = await pool.query(
      `
      DELETE FROM inventory.box_types
      WHERE id = $1
      RETURNING id
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Box type not found.",
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error("Error deleting box type:", error);

    res.status(500).json({
      error: "Failed to delete box type.",
    });
  }
});

export default router;