import { Router, Request, Response } from "express";
import { pool } from "../db"; // your existing pg pool

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const { employee_name, yearly_amount, year } = req.body;

    // Validate
    if (!employee_name || !yearly_amount || !year) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Start date = January 1st of the given year
    const start_date = `${year}-01-01`;

    // Days in year (handles leap years)
    const days_in_year = new Date(year, 1, 29).getDate() === 29 ? 366 : 365;

    const query = `
            INSERT INTO salary_periods (employee_name, yearly_amount, start_date, days_in_year)
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `;

    const values = [employee_name, yearly_amount, start_date, days_in_year];

    const result = await pool.query(query, values);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error inserting salary period:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/check", async (req, res) => {
  const { employee_name, year } = req.query;

  if (!employee_name || !year) {
    return res.status(400).json({ error: "Nom de l'employé et année requis." });
  }

  try {
    const startDate = `${year}-01-01`;
    const result = await pool.query(
      `SELECT * FROM salary_periods WHERE employee_name = $1 AND start_date = $2`,
      [employee_name, startDate]
    );

    if (result.rows.length > 0) {
      return res.json({ exists: true });
    } else {
      return res.json({ exists: false });
    }
  } catch (err) {
    console.error("Erreur lors de la vérification :", err);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors de la vérification." });
  }
});

router.put("/", async (req: Request, res: Response) => {
  try {
    const { employee_name, year, start_date, yearly_amount } = req.body;

    if (!employee_name || !yearly_amount || !year || !start_date) {
      return res.status(400).json({ error: "Champs requis manquants." });
    }

    // 1️⃣ Find existing entry for the employee & year
    const existingResult = await pool.query(
      `SELECT * FROM salary_periods WHERE employee_name = $1 AND start_date::text LIKE $2`,
      [employee_name, `${year}-%`] // Matches any start_date in the given year
    );

    if (existingResult.rows.length > 0) {
      const existingEntry = existingResult.rows[0];

      // 2️⃣ Update existing entry's end_date to be the day before new start_date
      const newEndDate = new Date(start_date);
      newEndDate.setDate(newEndDate.getDate() - 1); // day before
      await pool.query(
        `UPDATE salary_periods SET end_date = $1 WHERE id = $2`,
        [newEndDate.toISOString().split("T")[0], existingEntry.id]
      );
    }

    // 3️⃣ Insert the new salary period
    const days_in_year = new Date(year, 1, 29).getDate() === 29 ? 366 : 365;

    const insertResult = await pool.query(
      `INSERT INTO salary_periods (employee_name, yearly_amount, start_date, days_in_year)
             VALUES ($1, $2, $3, $4) RETURNING *`,
      [employee_name, yearly_amount, start_date, days_in_year]
    );

    res.json(insertResult.rows[0]);
  } catch (err) {
    console.error("Erreur lors de la modification du salaire :", err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

export default router;
