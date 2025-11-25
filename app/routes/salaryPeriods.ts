import { Router, Request, Response } from "express";
import pool from "../db"; // your existing pg pool

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

export default router;
