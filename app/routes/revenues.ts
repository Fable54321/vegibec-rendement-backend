import express, { Request, Response } from "express";
import { pool } from "../db";
import { requireAppRole } from "../middleware/auth";

const router = express.Router();

router.get(
  "/by-year",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req: Request, res: Response) => {
    try {
      const { year_from } = req.query;

      if (!year_from) {
        return res
          .status(400)
          .json({ error: "Missing 'year_from' query parameter" });
      }

      const query = `
      SELECT 
        vegetable,
        SUM(REPLACE(total_revenue::text, ',', '')::numeric) AS total_revenue
      FROM revenues
      WHERE year_from = $1
      GROUP BY vegetable
      ORDER BY total_revenue DESC;
    `;

      const result = await pool.query(query, [year_from]);

      return res.json(result.rows);
    } catch (error) {
      console.error("Error fetching revenues by year:", error);
      return res.status(500).json({ error: "Database error" });
    }
  },
);

router.get(
  "/available-years",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
    try {
      const result = await pool.query(`
      SELECT DISTINCT year_from
      FROM revenues
      ORDER BY year_from DESC;
    `);
      return res.json(result.rows.map((r) => r.year_from));
    } catch (err) {
      console.error("Error fetching available years:", err);
      return res.status(500).json({ error: "Database error" });
    }
  },
);

router.post(
  "/",
  requireAppRole("rendement", ["admin"]),
  async (req: Request, res: Response) => {
    try {
      const { year_from, revenues } = req.body;
      // revenues: array of { vegetable: string, total_revenue: number }

      if (
        !year_from ||
        !revenues ||
        !Array.isArray(revenues) ||
        revenues.length === 0
      ) {
        return res.status(400).json({ error: "Année et revenus requis" });
      }

      // Check if revenues for this year already exist
      const existing = await pool.query(
        "SELECT 1 FROM revenues WHERE year_from = $1 LIMIT 1",
        [year_from],
      );

      if (existing.rowCount && existing.rowCount > 0) {
        return res.status(409).json({
          error: `Les revenus pour l'année ${year_from} existent déjà.`,
        });
      }

      // Insert each vegetable's revenue
      const insertPromises = revenues.map(
        (r: { vegetable: string; total_revenue: number }) =>
          pool.query(
            "INSERT INTO revenues (vegetable, total_revenue, year_from) VALUES ($1, $2, $3)",
            [r.vegetable.trim().toUpperCase(), r.total_revenue, year_from],
          ),
      );

      await Promise.all(insertPromises);

      return res.status(201).json({ message: "Revenus ajoutés avec succès" });
    } catch (error) {
      console.error("Error adding revenues:", error);
      return res.status(500).json({ error: "Échec de l'ajout des revenus" });
    }
  },
);

router.patch(
  "/",
  requireAppRole("rendement", ["admin"]),
  async (req: Request, res: Response) => {
    try {
      const { year_from, revenues } = req.body;

      if (!year_from || !revenues?.length) {
        return res.status(400).json({ error: "Année et revenus requis" });
      }

      const updatedRows: any[] = [];

      // Update each vegetable for that year
      for (const r of revenues) {
        if (!r.vegetable || r.total_revenue == null) continue;

        const result = await pool.query(
          `UPDATE revenues
           SET total_revenue = $1
           WHERE year_from = $2 AND vegetable = $3
           RETURNING *`,
          [r.total_revenue, year_from, r.vegetable.trim().toUpperCase()],
        );
        const count = result.rowCount ?? 0; // nullish coalescing
        if (count > 0) updatedRows.push(result.rows[0]);
      }

      if (!updatedRows.length) {
        return res.status(404).json({
          error: `Aucun revenu trouvé pour la liste donnée en ${year_from}`,
        });
      }

      return res.json({
        message: "Revenus mis à jour avec succès",
        updated: updatedRows,
      });
    } catch (error) {
      console.error("Error updating revenues:", error);
      return res
        .status(500)
        .json({ error: "Échec de la mise à jour des revenus" });
    }
  },
);

// --- Add a single vegetable revenue ---
router.post(
  "/single",
  requireAppRole("rendement", ["admin"]),
  async (req: Request, res: Response) => {
    try {
      const { year_from, vegetable, total_revenue } = req.body;

      if (!year_from || !vegetable || total_revenue == null) {
        return res
          .status(400)
          .json({ error: "Année, légume et montant requis" });
      }

      // Check if this vegetable already exists for the year
      const existing = await pool.query(
        "SELECT 1 FROM revenues WHERE year_from = $1 AND vegetable = $2",
        [year_from, vegetable.trim().toUpperCase()],
      );

      if (existing.rowCount && existing.rowCount > 0) {
        return res.status(409).json({
          error: `Le revenu pour "${vegetable}" existe déjà en ${year_from}.`,
        });
      }

      const result = await pool.query(
        "INSERT INTO revenues (vegetable, total_revenue, year_from) VALUES ($1, $2, $3) RETURNING *",
        [vegetable.trim().toUpperCase(), total_revenue, year_from],
      );

      return res.status(201).json({
        message: "Revenu ajouté avec succès",
        added: result.rows[0],
      });
    } catch (error) {
      console.error("Error adding single revenue:", error);
      return res.status(500).json({ error: "Échec de l'ajout du revenu" });
    }
  },
);

// --- Delete a single vegetable revenue ---
router.delete(
  "/single",
  requireAppRole("rendement", ["admin"]),
  async (req: Request, res: Response) => {
    try {
      const { year_from, vegetable } = req.body;

      if (!year_from || !vegetable) {
        return res
          .status(400)
          .json({ error: "Année et légume requis pour la suppression" });
      }

      const result = await pool.query(
        "DELETE FROM revenues WHERE year_from = $1 AND vegetable = $2 RETURNING *",
        [year_from, vegetable.trim().toUpperCase()],
      );

      const count = result.rowCount ?? 0;
      if (count === 0) {
        return res.status(404).json({
          error: `Aucun revenu trouvé pour "${vegetable}" en ${year_from}.`,
        });
      }

      return res.json({
        message: "Revenu supprimé avec succès",
        deleted: result.rows[0],
      });
    } catch (error) {
      console.error("Error deleting single revenue:", error);
      return res
        .status(500)
        .json({ error: "Échec de la suppression du revenu" });
    }
  },
);

export default router;
