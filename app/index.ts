import dotenv from "dotenv";
import { authMiddleware } from "./middleware/auth";

dotenv.config();

import express from "express";
import { pool } from "./db";
import cors from "cors";
import revenuesRoute from "./routes/revenues";
import employeesRoute from "./routes/employees";
import authRoute from "./routes/auth";
import cookieParser from "cookie-parser";
import salaryPeriodsRoutes from "./routes/salaryPeriods";

const app = express();
app.use(express.json());
app.use(cookieParser());

const allowedOrigins = [
  "http://localhost:5173", // local dev
  "https://vegibec-rendement.netlify.app", // production
];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like mobile apps or Postman)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true, // allow cookies
  })
);

app.use("/auth", authRoute);

app.use(authMiddleware);

// --- Simple test route ---
app.get("/", async (req, res) => {
  const result = await pool.query("SELECT NOW()");
  res.json(result.rows);
});

// --- POST: Insert new cost entry ---
app.post("/data/costs", async (req, res) => {
  try {
    const {
      vegetable,
      category,
      sub_category,
      total_hours,
      supervisor,
      total_cost,
      created_at,
    } = req.body;

    const dateValue = created_at ? new Date(created_at) : new Date();

    const result = await pool.query(
      `INSERT INTO task_costs 
       (vegetable, category, sub_category, total_hours, supervisor, total_cost, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        vegetable,
        category,
        sub_category,
        total_hours,
        supervisor,
        total_cost,
        dateValue,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error inserting data:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// --- GET: Aggregated costs summary ---
app.get("/data/costs/summary", async (req, res) => {
  try {
    const groupBy = req.query.groupBy as string | undefined;
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;

    const allowedFields = [
      "vegetable",
      "category",
      "sub_category",
      "supervisor",
    ];
    if (!groupBy || !allowedFields.includes(groupBy)) {
      return res
        .status(400)
        .json({ error: "Invalid or missing groupBy field" });
    }

    let query = `
      SELECT ${groupBy === "sub_category" ? "sub_category, category" : groupBy},
             SUM(total_hours) AS total_hours,
             SUM(total_cost) AS total_cost
      FROM task_costs
    `;

    const values: any[] = [];

    // Add date filtering safely
    if (start && end) {
      query += ` WHERE created_at BETWEEN $1 AND $2`;
      values.push(start, end);
    } else if (start) {
      query += ` WHERE created_at >= $1`;
      values.push(start);
    } else if (end) {
      query += ` WHERE created_at <= $1`;
      values.push(end);
    }

    if (groupBy === "sub_category") {
      query += ` GROUP BY sub_category, category ORDER BY category, sub_category`;
    } else {
      query += ` GROUP BY ${groupBy} ORDER BY ${groupBy}`;
    }

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching summary:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /data/costs/other_costs?start=YYYY-MM-DD&end=YYYY-MM-DD
app.get("/data/costs/other_costs", async (req, res) => {
  const { start, end } = req.query as { start?: string; end?: string };

  if (!start && !end) {
    return res
      .status(400)
      .json({ error: "Missing 'start' or 'end' query parameter." });
  }

  const year = new Date(start!).getFullYear(); // extract year from start

  try {
    let results: { category: string; total_cost: number }[] = [];

    if (year === 2024) {
      // 2024: old table logic
      const other_costs = "other_costs";
      let query = `SELECT category, SUM(cost) AS total_cost FROM ${other_costs}`;
      const values: any[] = [];

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
      // 2025+: combine salaries + other_costs_new
      const categories = [
        "férié_locaux",
        "férié_tet",
        "location_terre",
        "préavis_locaux",
        "vacances_locaux",
        "vacance_tet",
      ];

      // 1️⃣ Salaries
      const salaryQuery = `
        SELECT SUM(
          CASE 
            WHEN end_date IS NULL OR end_date > $2 THEN 
              yearly_amount / days_in_year * (EXTRACT(DOY FROM $2::date) - EXTRACT(DOY FROM start_date::date) + 1)
            ELSE 
              yearly_amount / days_in_year * (EXTRACT(DOY FROM end_date::date) - EXTRACT(DOY FROM start_date::date) + 1)
          END
        ) AS total_cost
        FROM salary_periods
        WHERE EXTRACT(YEAR FROM start_date) = $1
      `;
      const salaryResult = await pool.query(salaryQuery, [year, end]);
      results.push({
        category: "salaire",
        total_cost: Number(salaryResult.rows[0].total_cost || 0),
      });

      // 2️⃣ Other costs
      const otherCostsQuery = `
        SELECT category, SUM(total) AS total_cost
        FROM other_costs_new
        WHERE year = $1
        GROUP BY category
      `;
      const otherResult = await pool.query(otherCostsQuery, [year]);
      otherResult.rows.forEach((row) => {
        results.push({
          category: row.category,
          total_cost: Number(row.total_cost),
        });
      });
    }

    res.json(results);
  } catch (err) {
    console.error("Error fetching other costs summary:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/data/costs/latest", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, vegetable, category, sub_category, total_hours, supervisor, total_cost, created_at
       FROM task_costs
       ORDER BY created_at DESC
       LIMIT 10`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching latest costs:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.delete("/data/costs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM task_costs WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting entry:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/data/costs/seed_costs", async (req, res) => {
  const { start, end, seed } = req.query;

  // Validate query parameters
  if (!start && !end) {
    return res
      .status(400)
      .json({ error: "Missing 'start' or 'end' query parameter." });
  }

  let query = `
    SELECT seed, SUM(cost) AS total_cost
    FROM seed_costs
  `;

  const values: any[] = [];
  const conditions: string[] = [];

  // Add filters dynamically
  if (start && end) {
    conditions.push(
      `created_at BETWEEN $${values.length + 1} AND $${values.length + 2}`
    );
    values.push(start, end);
  } else if (start) {
    conditions.push(`created_at >= $${values.length + 1}`);
    values.push(start);
  } else if (end) {
    conditions.push(`created_at <= $${values.length + 1}`);
    values.push(end);
  }

  if (seed) {
    conditions.push(`seed = $${values.length + 1}`);
    values.push(seed);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " GROUP BY seed ORDER BY seed";

  try {
    const result = await pool.query(query, values);
    res.json(result.rows); // e.g. [{ seed: "carrot", total_cost: 2530.45 }]
  } catch (err) {
    console.error("Error fetching seed costs summary:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/data/packaging_costs/per_vegetable", async (req, res) => {
  try {
    const { start, end } = req.query;

    const values: any[] = [];
    let query = `
      SELECT vegetable, SUM(cost) AS total_cost
      FROM packaging_costs
    `;

    // Add date filtering if provided
    if (start && end) {
      query += ` WHERE created_at BETWEEN $1 AND $2`;
      values.push(start, end);
    } else if (start) {
      query += ` WHERE created_at >= $1`;
      values.push(start);
    } else if (end) {
      query += ` WHERE created_at <= $1`;
      values.push(end);
    }

    query += ` GROUP BY vegetable ORDER BY vegetable`;

    const result = await pool.query(query, values);
    res.json(result.rows); // [{ vegetable: "CHOU", total_cost: 1234 }, ...]
  } catch (err) {
    console.error("Error fetching packaging costs per vegetable:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Route for soil products grouped by vegetable
app.get("/data/costs/soil_products/vegetable", async (req, res) => {
  try {
    const { start, end } = req.query;

    let query = `
      SELECT vegetable, SUM(cost) AS total_cost
      FROM soil_products
    `;

    const values: any[] = [];
    const conditions: string[] = [];

    if (start && end) {
      conditions.push(
        `created_at BETWEEN $${values.length + 1} AND $${values.length + 2}`
      );
      values.push(start, end);
    } else if (start) {
      conditions.push(`created_at >= $${values.length + 1}`);
      values.push(start);
    } else if (end) {
      conditions.push(`created_at <= $${values.length + 1}`);
      values.push(end);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " GROUP BY vegetable ORDER BY vegetable";

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching soil products by vegetable:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Route for soil products grouped by category
app.get("/data/costs/soil_products/category", async (req, res) => {
  try {
    const { start, end } = req.query;

    let query = `
      SELECT category, SUM(cost) AS total_cost
      FROM soil_products
    `;

    const values: any[] = [];
    const conditions: string[] = [];

    if (start && end) {
      conditions.push(
        `created_at BETWEEN $${values.length + 1} AND $${values.length + 2}`
      );
      values.push(start, end);
    } else if (start) {
      conditions.push(`created_at >= $${values.length + 1}`);
      values.push(start);
    } else if (end) {
      conditions.push(`created_at <= $${values.length + 1}`);
      values.push(end);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " GROUP BY category ORDER BY category";

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching soil products by category:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.use("/revenues", revenuesRoute);

app.use("/employees", employeesRoute);

app.use("/salary-periods", salaryPeriodsRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log("✅ Server running on http://localhost:3000")
);
