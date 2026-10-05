import { Router } from "express";
import { pool } from "../db";
import { requireAppRole } from "../middleware/auth";

export const taskCostCreationRoute = Router();
const router = Router();
const rendementReaders = requireAppRole("rendement", ["admin", "user", "guest"]);
const rendementWriters = requireAppRole("rendement", ["admin", "user"]);

taskCostCreationRoute.post("/data/costs", rendementWriters, async (req, res) => {
  try {
    const {
      vegetable,
      category,
      sub_category,
      total_hours,
      supervisor,
      total_cost,
      created_at,
      field,
      total_worker,
    } = req.body;

    const dateValue = created_at ? new Date(created_at) : new Date();
    const result = await pool.query(
      `INSERT INTO task_costs
       (vegetable, category, sub_category, total_hours, supervisor, total_cost, created_at, field, total_worker)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        vegetable,
        category,
        sub_category,
        total_hours,
        supervisor,
        total_cost,
        dateValue,
        field,
        total_worker,
      ],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error inserting data:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/data/costs/summary", rendementReaders, async (req, res) => {
  try {
    const groupBy = (req.query.groupBy as string | undefined)?.split(",");
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    const allowedFields = [
      "vegetable",
      "category",
      "sub_category",
      "supervisor",
    ];

    if (!groupBy || groupBy.some((field) => !allowedFields.includes(field))) {
      return res.status(400).json({ error: "Invalid groupBy field" });
    }

    const groupClause = groupBy.join(", ");
    let query = `
      SELECT ${groupClause},
             SUM(total_hours) AS total_hours,
             SUM(total_cost) AS total_cost,
             SUM(total_cost_with_charges) AS total_cost_with_charges
      FROM task_costs
    `;
    const values: unknown[] = [];

    if (start && end) {
      query += " WHERE created_at BETWEEN $1 AND $2";
      values.push(start, end);
    } else if (start) {
      query += " WHERE created_at >= $1";
      values.push(start);
    } else if (end) {
      query += " WHERE created_at <= $1";
      values.push(end);
    }

    query += ` GROUP BY ${groupClause} ORDER BY ${groupClause}`;
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/data/costs/other_costs", rendementReaders, async (req, res) => {
  const { start, end } = req.query as { start?: string; end?: string };

  if (!start && !end) {
    return res
      .status(400)
      .json({ error: "Missing 'start' or 'end' query parameter." });
  }

  const startDate = start ? new Date(start) : null;
  const endDate = end ? new Date(end) : new Date();
  const year = startDate?.getFullYear() || endDate.getFullYear();

  try {
    let results: { category: string; total_cost: number }[] = [];

    if (year === 2024) {
      let query = "SELECT category, SUM(cost) AS total_cost FROM other_costs";
      const values: unknown[] = [];

      if (start && end) {
        query += " WHERE created_at BETWEEN $1 AND $2";
        values.push(start, end);
      } else if (start) {
        query += " WHERE created_at >= $1";
        values.push(start);
      } else if (end) {
        query += " WHERE created_at <= $1";
        values.push(end);
      }

      query += " GROUP BY category ORDER BY category";
      const oldResult = await pool.query(query, values);
      results = oldResult.rows.map((row) => ({
        category: row.category,
        total_cost: Number(row.total_cost),
      }));
    } else {
      const salaryResult = await pool.query(
        `SELECT SUM(
          CASE
            WHEN (end_date IS NULL OR end_date >= $2::date) THEN
              yearly_amount / days_in_year * (
                GREATEST(
                  0,
                  LEAST($2::date, COALESCE(end_date, $2::date)) - GREATEST(start_date, $1::date) + 1
                )
              )
            ELSE
              yearly_amount / days_in_year * (
                GREATEST(
                  0,
                  LEAST(end_date, $2::date) - GREATEST(start_date, $1::date) + 1
                )
              )
          END
        ) AS total_cost
        FROM salary_periods
        WHERE start_date <= $2::date
          AND (end_date IS NULL OR end_date >= $1::date)`,
        [start, end],
      );

      results.push({
        category: "salaire",
        total_cost: Number(salaryResult.rows[0].total_cost || 0),
      });

      const otherResult = await pool.query(
        `SELECT category, total_cost
         FROM other_costs_new
         WHERE year = $1`,
        [year],
      );
      const startOfYear = new Date(year, 0, 1);
      const endOfYear = new Date(year, 11, 31);
      const daysInYear =
        (endOfYear.getTime() - startOfYear.getTime()) /
          (1000 * 60 * 60 * 24) +
        1;

      otherResult.rows.forEach((row) => {
        const dailyRate = Number(row.total_cost) / daysInYear;
        const rangeStart = startDate
          ? Math.max(startOfYear.getTime(), startDate.getTime())
          : startOfYear.getTime();
        const rangeEnd = endDate
          ? Math.min(endOfYear.getTime(), endDate.getTime())
          : endOfYear.getTime();
        const daysInRange =
          Math.floor((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24)) + 1;

        results.push({
          category: row.category,
          total_cost: dailyRate * daysInRange,
        });
      });
    }

    res.json(results);
  } catch (error) {
    console.error("Error fetching other costs summary:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/data/costs", rendementReaders, async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const offset = (page - 1) * limit;
    const { from, to } = req.query;
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    if (from) {
      values.push(from);
      whereClauses.push(`created_at >= $${values.length}::date`);
    }

    if (to) {
      values.push(to);
      whereClauses.push(
        `created_at < ($${values.length}::date + INTERVAL '1 day')`,
      );
    }

    const whereSql = whereClauses.length
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM task_costs ${whereSql}`,
      values,
    );
    const totalCount = Number(countResult.rows[0].count);
    const totalPages = Math.max(Math.ceil(totalCount / limit), 1);
    const result = await pool.query(
      `SELECT
        id,
        vegetable,
        category,
        sub_category,
        total_hours,
        supervisor,
        total_cost,
        total_cost_with_charges,
        created_at,
        field,
        total_worker
      FROM task_costs
      ${whereSql}
      ORDER BY id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    res.json({
      entries: result.rows,
      pagination: { page, totalPages, totalCount },
    });
  } catch (error) {
    console.error("Error fetching task costs:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.patch("/data/costs/:id", rendementWriters, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      vegetable,
      category,
      sub_category,
      total_hours,
      supervisor,
      total_cost,
      total_cost_with_charges,
      field,
      total_worker,
    } = req.body;
    const fields: string[] = [];
    const values: unknown[] = [];
    const addField = (name: string, value: unknown) => {
      values.push(value);
      fields.push(`${name} = $${values.length}`);
    };

    if (vegetable !== undefined) addField("vegetable", vegetable);
    if (category !== undefined) addField("category", category);
    if (sub_category !== undefined) addField("sub_category", sub_category);
    if (total_hours !== undefined) addField("total_hours", total_hours);
    if (supervisor !== undefined) addField("supervisor", supervisor);
    if (total_cost !== undefined) addField("total_cost", total_cost);
    if (total_cost_with_charges !== undefined) {
      addField("total_cost_with_charges", total_cost_with_charges);
    }
    if (field !== undefined) addField("field", field);
    if (total_worker !== undefined) addField("total_worker", total_worker);

    if (fields.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE task_costs
       SET ${fields.join(", ")}
       WHERE id = $${values.length}
       RETURNING *`,
      values,
    );

    res.json({ success: true, entry: result.rows[0] });
  } catch (error) {
    console.error("Error updating entry:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete("/data/costs/:id", rendementWriters, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM task_costs WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting entry:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/data/costs/seed_costs", rendementReaders, async (req, res) => {
  const { start, end, seed } = req.query;

  if (!start && !end) {
    return res
      .status(400)
      .json({ error: "Missing 'start' or 'end' query parameter." });
  }

  const startDate = start ? new Date(start as string) : null;
  const endDate = end ? new Date(end as string) : null;
  const year = startDate ? startDate.getFullYear() : new Date().getFullYear();

  try {
    if (year === 2024) {
      let query = "SELECT seed, SUM(cost) AS total_cost FROM seed_costs";
      const values: unknown[] = [];
      const conditions: string[] = [];

      if (startDate && endDate) {
        conditions.push(
          `created_at BETWEEN $${values.length + 1} AND $${values.length + 2}`,
        );
        values.push(startDate, endDate);
      } else if (startDate) {
        conditions.push(`created_at >= $${values.length + 1}`);
        values.push(startDate);
      } else if (endDate) {
        conditions.push(`created_at <= $${values.length + 1}`);
        values.push(endDate);
      }

      if (seed) {
        conditions.push(`seed = $${values.length + 1}`);
        values.push(seed);
      }

      if (conditions.length) query += ` WHERE ${conditions.join(" AND ")}`;
      query += " GROUP BY seed ORDER BY seed";
      const result = await pool.query(query, values);
      return res.json(result.rows);
    }

    const values: unknown[] = [year];
    let query = `SELECT
      vegetable,
      cultivar,
      SUM(total_cost) AS total_cost
    FROM seed_costs_new
    WHERE year = $1`;

    if (seed) {
      query += ` AND vegetable = $${values.length + 1}`;
      values.push(seed);
    }

    query += " GROUP BY vegetable, cultivar ORDER BY vegetable, cultivar";
    const result = await pool.query(query, values);
    const periodStart = new Date(year, 2, 1);
    const periodEnd = new Date(year, 10, 15);
    const totalPeriodDays = 260;
    const userStart = startDate || periodStart;
    const userEnd = endDate || periodEnd;
    const rangeStart = userStart > periodStart ? userStart : periodStart;
    const rangeEnd = userEnd < periodEnd ? userEnd : periodEnd;
    let daysInRange = 0;

    if (rangeEnd >= rangeStart) {
      daysInRange =
        Math.floor(
          (rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24),
        ) + 1;
    }

    return res.json(
      result.rows.map((row) => ({
        vegetable: row.vegetable,
        total_cost:
          (Number(row.total_cost) / totalPeriodDays) * daysInRange,
        cultivar: row.cultivar,
      })),
    );
  } catch (error) {
    console.error("Error fetching seed costs summary:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get(
  "/data/packaging_costs/per_vegetable",
  rendementReaders,
  async (req, res) => {
    try {
      const { start, end } = req.query;
      const startDate = start ? new Date(start as string) : null;
      const endDate = end ? new Date(end as string) : null;
      const year = startDate ? startDate.getFullYear() : new Date().getFullYear();

      if (year === 2024) {
        const values: unknown[] = [];
        let query =
          "SELECT vegetable, SUM(cost) AS total_cost FROM packaging_costs";

        if (start && end) {
          query += " WHERE created_at BETWEEN $1 AND $2";
          values.push(start, end);
        } else if (start) {
          query += " WHERE created_at >= $1";
          values.push(start);
        } else if (end) {
          query += " WHERE created_at <= $1";
          values.push(end);
        }

        query += " GROUP BY vegetable ORDER BY vegetable";
        const result = await pool.query(query, values);
        return res.json(result.rows);
      }

      const periodStart = new Date(year, 2, 1);
      const periodEnd = new Date(year, 10, 15);
      const totalPeriodDays =
        Math.floor(
          (periodEnd.getTime() - periodStart.getTime()) /
            (1000 * 60 * 60 * 24),
        ) + 1;
      const rangeStart =
        startDate && startDate > periodStart ? startDate : periodStart;
      const rangeEnd = endDate && endDate < periodEnd ? endDate : periodEnd;
      let daysInRange = 0;

      if (rangeEnd >= rangeStart) {
        daysInRange =
          Math.floor(
            (rangeEnd.getTime() - rangeStart.getTime()) /
              (1000 * 60 * 60 * 24),
          ) + 1;
      }

      const result = await pool.query(
        `SELECT vegetable, SUM(total_cost) AS total_cost
         FROM packaging_costs_new
         WHERE year = $1
         GROUP BY vegetable
         ORDER BY vegetable`,
        [year],
      );
      return res.json(
        result.rows.map((row) => ({
          vegetable: row.vegetable,
          total_cost:
            (Number(row.total_cost) / totalPeriodDays) * daysInRange,
        })),
      );
    } catch (error) {
      console.error("Error fetching packaging costs per vegetable:", error);
      res.status(500).json({ error: "Database error" });
    }
  },
);

router.get(
  "/data/costs/soil_products/vegetable",
  rendementReaders,
  async (req, res) => {
    try {
      const { start, end } = req.query;
      const startDate = start ? new Date(start as string) : null;
      const endDate = end ? new Date(end as string) : null;
      const year = startDate ? startDate.getFullYear() : new Date().getFullYear();

      if (year === 2024) {
        const values: unknown[] = [];
        const conditions: string[] = [];
        let query =
          "SELECT vegetable, SUM(cost) AS total_cost FROM soil_products";

        if (start && end) {
          conditions.push(
            `created_at BETWEEN $${values.length + 1} AND $${values.length + 2}`,
          );
          values.push(start, end);
        } else if (start) {
          conditions.push(`created_at >= $${values.length + 1}`);
          values.push(start);
        } else if (end) {
          conditions.push(`created_at <= $${values.length + 1}`);
          values.push(end);
        }

        if (conditions.length) query += ` WHERE ${conditions.join(" AND ")}`;
        query += " GROUP BY vegetable ORDER BY vegetable";
        const result = await pool.query(query, values);
        return res.json(result.rows);
      }

      const result = await pool.query(
        "SELECT vegetable, total_cost FROM soil_products_costs_new WHERE year = $1",
        [year],
      );
      const periodStart = new Date(year, 2, 1);
      const periodEnd = new Date(year, 10, 15);
      const totalPeriodDays = 260;
      const userStart = startDate || periodStart;
      const userEnd = endDate || periodEnd;
      const rangeStart = userStart > periodStart ? userStart : periodStart;
      const rangeEnd = userEnd < periodEnd ? userEnd : periodEnd;
      let daysInRange = 0;

      if (rangeEnd >= rangeStart) {
        daysInRange =
          Math.floor(
            (rangeEnd.getTime() - rangeStart.getTime()) /
              (1000 * 60 * 60 * 24),
          ) + 1;
      }

      return res.json(
        result.rows.map((row) => ({
          vegetable: row.vegetable,
          total_cost:
            (Number(row.total_cost) / totalPeriodDays) * daysInRange,
        })),
      );
    } catch (error) {
      console.error("Error fetching soil products by vegetable:", error);
      res.status(500).json({ error: "Database error" });
    }
  },
);

router.get(
  "/data/costs/soil_products/category",
  rendementReaders,
  async (req, res) => {
    try {
      const { start, end } = req.query;
      const startDate = start ? new Date(start as string) : null;
      const endDate = end ? new Date(end as string) : null;
      const today = new Date();
      const year = startDate ? startDate.getFullYear() : today.getFullYear();

      if (year === 2024) {
        const values: unknown[] = [];
        const conditions: string[] = [];
        let query =
          "SELECT category, SUM(cost) AS total_cost FROM soil_products";

        if (start && end) {
          conditions.push(
            `created_at BETWEEN $${values.length + 1} AND $${values.length + 2}`,
          );
          values.push(start, end);
        } else if (start) {
          conditions.push(`created_at >= $${values.length + 1}`);
          values.push(start);
        } else if (end) {
          conditions.push(`created_at <= $${values.length + 1}`);
          values.push(end);
        }

        if (conditions.length) query += ` WHERE ${conditions.join(" AND ")}`;
        query += " GROUP BY category ORDER BY category";
        const result = await pool.query(query, values);
        return res.json(result.rows);
      }

      const result = await pool.query(
        "SELECT category, total_cost FROM soil_products_category_totals_new WHERE year = $1",
        [year],
      );
      const startOfYear = new Date(year, 0, 1);
      const endOfYear = new Date(year, 11, 31);
      const daysInYear =
        Math.floor(
          (endOfYear.getTime() - startOfYear.getTime()) /
            (1000 * 60 * 60 * 24),
        ) + 1;
      const rangeStart = startDate || startOfYear;
      const rangeEnd = endDate || today;
      const daysInRange =
        Math.floor(
          (rangeEnd.getTime() - rangeStart.getTime()) /
            (1000 * 60 * 60 * 24),
        ) + 1;

      return res.json(
        result.rows.map((row) => ({
          category: row.category,
          total_cost: (Number(row.total_cost) / daysInYear) * daysInRange,
        })),
      );
    } catch (error) {
      console.error("Error fetching soil products by category:", error);
      res.status(500).json({ error: "Database error" });
    }
  },
);

export default router;
