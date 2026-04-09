import dotenv from "dotenv";
import { authMiddleware, requireAppRole } from "./middleware/auth";
import { uploadBufferToS3 } from "./services/s3.services";


import express from "express";
import { pool } from "./db";
import cors from "cors";
import revenuesRoute from "./routes/revenues";
import employeesRoute from "./routes/employees";
import authRoute from "./routes/auth";
import cookieParser from "cookie-parser";
import salaryPeriodsRoutes from "./routes/salaryPeriods";
import otherCostsEntry from "./routes/otherCostsEntry";
import unitsSold from "./routes/unitsSold";
import unspecifiedRoute from "./routes/unspecified_route";
import journalRoute from "./routes/journal";
import unitsSoldEntries from "./routes/unitsSoldEntries";
import vegReportsRouter from "./routes/USDA";
import rateConverterRoute from "./routes/rateConverter";
import getFieldsRoute from "./routes/getFields";
import addFieldsRoute from "./routes/addFields";
import supervisorRoute from "./routes/supervisors";
import vegetablesRoute from "./routes/vegetables";
import projectedRevenuesRoute from "./routes/projectedRevenues.routes";
import taskCateogriesRoute from "./routes/taskCategories";
import lossesTrackingRoute from "./routes/lossesTrackingRoute";
import portalRoute from "./routes/Portal/Portal";
import warehouseProductsRoute from "./routes/Warehouse/products";
import timesheetsSessionRoute from "./routes/Timesheets/session";
import timesheetsTasksRoute from "./routes/Timesheets/tasks";
import timeSheetsCalculationsRoute from "./routes/Timesheets/calculations";
import userDailyDurationRoute from "./routes/Timesheets/userDailyDuration";
import adminRoute from "./routes/Timesheets/admin"
import signatureRoute from "./routes/DigitalSignature/digitalSignature";
import path from "path";

import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { s3 } from "./s3"; 




dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieParser());

const allowedOrigins = [
  "http://localhost:5173",
  "https://vegibec-rendement.netlify.app",
  "https://vegibec-usda.netlify.app",
  "http://localhost:5174",
  "https://vegibec-portail.netlify.app",
  "https://vegibec-portail.com",
  "https://gestion-entreposage.netlify.app",
  "https://feuilles-de-temps.netlify.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS policy"));
      }
    },
    credentials: true,
  }),
);







app.get("/", async (req, res) => {
  const result = await pool.query("SELECT NOW()");
  res.json(result.rows);
});

app.use("/signature", signatureRoute);

app.use("/api/rate-converter", rateConverterRoute);   /// same thing here

app.use("/api/vegReports", vegReportsRouter); //// Eventually check for these they can be uinside the auth

app.use(
  "/generated-contracts",
  express.static(path.join(process.cwd(), "public", "generated-contracts"))
);

app.use("/auth", authRoute);



app.use(authMiddleware);



// --- POST: Insert new cost entry ---
app.post(
  "/data/costs",
  requireAppRole("rendement", ["admin", "user"]),
  async (req, res) => {
    try {
      const {
        vegetable,
        category,
        sub_category,
        total_hours,
        supervisor,
        total_cost,
        created_at,
        field, // existing
        total_worker, // <-- new column
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
          total_worker, // <-- pass the new value
        ],
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Error inserting data:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

app.use("/fix-field", addFieldsRoute);

// --- GET: Aggregated costs summary ---
app.get(
  "/data/costs/summary",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
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

      if (!groupBy || groupBy.some((f) => !allowedFields.includes(f))) {
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

      const values: any[] = [];

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

      query += ` GROUP BY ${groupClause} ORDER BY ${groupClause}`;

      const result = await pool.query(query, values);

      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

// GET /data/costs/other_costs?start=YYYY-MM-DD&end=YYYY-MM-DD
app.get(
  "/data/costs/other_costs",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
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
        // 2025+: salaries handled as before
        const salaryQuery = `
        SELECT SUM(
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
          AND (end_date IS NULL OR end_date >= $1::date)
      `;
        const salaryResult = await pool.query(salaryQuery, [start, end]);
        results.push({
          category: "salaire",
          total_cost: Number(salaryResult.rows[0].total_cost || 0),
        });

        // 2025+: other_costs_new - spread total_cost over elapsed days
        // 2025+: other_costs_new - spread total_cost over the whole year
        const otherCostsQuery = `
  SELECT category, total_cost
  FROM other_costs_new
  WHERE year = $1
`;
        const otherResult = await pool.query(otherCostsQuery, [year]);

        const startOfYear = new Date(year, 0, 1);
        const endOfYear = new Date(year, 11, 31);
        const daysInYear =
          (endOfYear.getTime() - startOfYear.getTime()) /
            (1000 * 60 * 60 * 24) +
          1;

        otherResult.rows.forEach((row: any) => {
          const dailyRate = Number(row.total_cost) / daysInYear;

          // Compute days in the requested range
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
    } catch (err) {
      console.error("Error fetching other costs summary:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

//////// TASK COSTS ENTRIES JOURNAL //////////////////////////////

app.get(
  "/data/costs",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Number(req.query.limit) || 10, 50);
      const offset = (page - 1) * limit;

      const { from, to } = req.query;

      const whereClauses: string[] = [];
      const values: any[] = [];

      // ✅ Timezone-safe date filtering
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

      const whereSQL = whereClauses.length
        ? `WHERE ${whereClauses.join(" AND ")}`
        : "";

      // 1️⃣ Total count (WITH filters)
      const countQuery = `
      SELECT COUNT(*)
      FROM task_costs
      ${whereSQL}
    `;

      const countResult = await pool.query(countQuery, values);
      const totalCount = Number(countResult.rows[0].count);
      const totalPages = Math.max(Math.ceil(totalCount / limit), 1);

      // 2️⃣ Paginated data (WITH filters)
      const dataQuery = `
      SELECT
        id,
        vegetable,
        category,
        sub_category,
        total_hours,
        supervisor,
        total_cost,
        total_cost_with_charges,  -- <-- added this
        created_at,
        field,
        total_worker
      FROM task_costs
      ${whereSQL}
      ORDER BY id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;

      const result = await pool.query(dataQuery, [...values, limit, offset]);

      res.json({
        entries: result.rows,
        pagination: {
          page,
          totalPages,
          totalCount,
        },
      });
    } catch (err) {
      console.error("Error fetching task costs:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

//Delete or modify entry from Task costs

app.patch(
  "/data/costs/:id",
  requireAppRole("rendement", ["admin", "user"]),
  async (req, res) => {
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
      const values: any[] = [];

      const addField = (name: string, value: any) => {
        values.push(value);
        fields.push(`${name} = $${values.length}`);
      };

      if (vegetable !== undefined) addField("vegetable", vegetable);
      if (category !== undefined) addField("category", category);
      if (sub_category !== undefined) addField("sub_category", sub_category);
      if (total_hours !== undefined) addField("total_hours", total_hours);
      if (supervisor !== undefined) addField("supervisor", supervisor);
      if (total_cost !== undefined) addField("total_cost", total_cost);
      if (total_cost_with_charges !== undefined)
        addField("total_cost_with_charges", total_cost_with_charges);
      if (field !== undefined) addField("field", field);
      if (total_worker !== undefined) addField("total_worker", total_worker);

      if (fields.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      values.push(id);

      const query = `
      UPDATE task_costs
      SET ${fields.join(", ")}
      WHERE id = $${values.length}
      RETURNING *
    `;

      const result = await pool.query(query, values);

      res.json({
        success: true,
        entry: result.rows[0],
      });
    } catch (err) {
      console.error("Error updating entry:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

app.delete(
  "/data/costs/:id",
  requireAppRole("rendement", ["admin", "user"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query("DELETE FROM task_costs WHERE id = $1", [id]);
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting entry:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

////////////////////////////////////////////////////////////////////////////////

app.get(
  "/data/costs/seed_costs",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
    const { start, end, seed } = req.query;

    if (!start && !end) {
      return res
        .status(400)
        .json({ error: "Missing 'start' or 'end' query parameter." });
    }

    const startDate = start ? new Date(start as string) : null;
    const endDate = end ? new Date(end as string) : null;
    const today = new Date();

    // Determine the year to choose table
    const year = startDate ? startDate.getFullYear() : today.getFullYear();

    try {
      if (year === 2024) {
        // Use old table
        let query = `SELECT seed, SUM(cost) AS total_cost FROM seed_costs`;
        const values: any[] = [];
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

        if (conditions.length) {
          query += " WHERE " + conditions.join(" AND ");
        }

        query += " GROUP BY seed ORDER BY seed";

        const result = await pool.query(query, values);
        return res.json(result.rows);
      } else {
        const values: any[] = [year];

        let query = `
  SELECT 
    vegetable,
    cultivar,
    SUM(total_cost) AS total_cost
  FROM seed_costs_new
  WHERE year = $1
`;

        if (seed) {
          query += ` AND vegetable = $${values.length + 1}`;
          values.push(seed);
        }

        query += ` GROUP BY vegetable, cultivar ORDER BY vegetable, cultivar`;

        const result = await pool.query(query, values);

        // Seasonal calculation
        const PERIOD_START = new Date(year, 2, 1); // Mar 1
        const PERIOD_END = new Date(year, 10, 15); // Nov 15
        const TOTAL_PERIOD_DAYS = 260;

        const userStart = startDate || PERIOD_START;
        const userEnd = endDate || PERIOD_END;

        const rangeStart = userStart > PERIOD_START ? userStart : PERIOD_START;
        const rangeEnd = userEnd < PERIOD_END ? userEnd : PERIOD_END;

        let daysInRange = 0;
        if (rangeEnd >= rangeStart) {
          daysInRange =
            Math.floor(
              (rangeEnd.getTime() - rangeStart.getTime()) /
                (1000 * 60 * 60 * 24),
            ) + 1;
        }

        const computed = result.rows.map((row: any) => ({
          vegetable: row.vegetable,
          total_cost:
            (Number(row.total_cost) / TOTAL_PERIOD_DAYS) * daysInRange,
          cultivar: row.cultivar,
        }));

        return res.json(computed);
      }
    } catch (err) {
      console.error("Error fetching seed costs summary:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

app.get(
  "/data/packaging_costs/per_vegetable",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
    try {
      const { start, end, seed } = req.query; // <-- include seed here

      const startDate = start ? new Date(start as string) : null;
      const endDate = end ? new Date(end as string) : null;
      const today = new Date();

      // Determine year from start or fallback to current
      const year = startDate ? startDate.getFullYear() : today.getFullYear();

      /* ---------------------------
         2024 LOGIC (unchanged)
      --------------------------- */
      if (year === 2024) {
        const values: any[] = [];
        let query = `SELECT vegetable, SUM(cost) AS total_cost FROM packaging_costs`;

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
        return res.json(result.rows);
      }

      /* ---------------------------
   2025+ LOGIC (SEASONAL: Mar 1 → Nov 15)
--------------------------- */
      const PERIOD_START = new Date(year, 2, 1); // March 1
      const PERIOD_END = new Date(year, 10, 15); // Nov 15
      const TOTAL_PERIOD_DAYS =
        Math.floor(
          (PERIOD_END.getTime() - PERIOD_START.getTime()) /
            (1000 * 60 * 60 * 24),
        ) + 1;

      const rangeStart =
        startDate && startDate > PERIOD_START ? startDate : PERIOD_START;
      const rangeEnd = endDate && endDate < PERIOD_END ? endDate : PERIOD_END;

      let daysInRange = 0;
      if (rangeEnd >= rangeStart) {
        daysInRange =
          Math.floor(
            (rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24),
          ) + 1;
      }

      // ------------------------
      // Query packaging_costs_new for 2025+
      const values: any[] = [year];
      let query = `
  SELECT vegetable, sum(total_cost) AS total_cost
  FROM packaging_costs_new
  WHERE year = $1
`;

      query += ` GROUP BY vegetable ORDER BY vegetable`;

      const result = await pool.query(query, values);

      // Apply seasonal proportionality
      const perVegetable = result.rows.map((row: any) => {
        const dailyRate = Number(row.total_cost) / TOTAL_PERIOD_DAYS;
        return {
          vegetable: row.vegetable,
          total_cost: dailyRate * daysInRange,
        };
      });

      // Global totals
      const globalTotals = perVegetable.reduce(
        (acc: Record<string, number>, row) => {
          acc[row.vegetable] = row.total_cost;
          return acc;
        },
        {},
      );

      return res.json(perVegetable);
    } catch (err) {
      console.error("Error fetching packaging costs per vegetable:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

// Route for soil products grouped by vegetable
// SOILS SOILS SOILS SOILS SOILS SOILS //
app.get(
  "/data/costs/soil_products/vegetable",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
    try {
      const { start, end } = req.query;

      const startDate = start ? new Date(start as string) : null;
      const endDate = end ? new Date(end as string) : null;
      const today = new Date();
      const year = startDate ? startDate.getFullYear() : today.getFullYear();

      /* --------------------------
         2024 OLD TABLE LOGIC
      --------------------------- */
      if (year === 2024) {
        const values: any[] = [];
        const conditions: string[] = [];

        let query = `SELECT vegetable, SUM(cost) AS total_cost FROM soil_products`;

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

        if (conditions.length) query += " WHERE " + conditions.join(" AND ");
        query += " GROUP BY vegetable ORDER BY vegetable";

        const result = await pool.query(query, values);
        return res.json(result.rows);
      }

      /* --------------------------
         2025+ NEW TABLE LOGIC
         Seasonal: March 1 → Nov 15 (260 days)
      --------------------------- */

      const result = await pool.query(
        `SELECT vegetable, total_cost FROM soil_products_costs_new WHERE year = $1`,
        [year],
      );

      // Fixed seasonal period
      const PERIOD_START = new Date(year, 2, 1); // March 1
      const PERIOD_END = new Date(year, 10, 15); // Nov 15
      const TOTAL_PERIOD_DAYS = 260;

      // User-specified or fallback range
      const userStart = startDate || PERIOD_START;
      const userEnd = endDate || PERIOD_END;

      // Intersection with seasonal window
      const rangeStart = userStart > PERIOD_START ? userStart : PERIOD_START;
      const rangeEnd = userEnd < PERIOD_END ? userEnd : PERIOD_END;

      let daysInRange = 0;
      if (rangeEnd >= rangeStart) {
        daysInRange =
          Math.floor(
            (rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24),
          ) + 1;
      }

      const computed = result.rows.map((row: any) => {
        const dailyRate = Number(row.total_cost) / TOTAL_PERIOD_DAYS;

        return {
          vegetable: row.vegetable,
          total_cost: dailyRate * daysInRange,
        };
      });

      return res.json(computed);
    } catch (err) {
      console.error("Error fetching soil products by vegetable:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

/////test////

// GET totals per category
app.get(
  "/data/costs/soil_products/category",
  requireAppRole("rendement", ["admin", "user", "guest"]),
  async (req, res) => {
    try {
      const { start, end } = req.query;

      const startDate = start ? new Date(start as string) : null;
      const endDate = end ? new Date(end as string) : null;
      const today = new Date();
      const year = startDate ? startDate.getFullYear() : today.getFullYear();

      if (year === 2024) {
        // Old table logic
        const values: any[] = [];
        let query = `SELECT category, SUM(cost) AS total_cost FROM soil_products`;
        const conditions: string[] = [];

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

        if (conditions.length) query += " WHERE " + conditions.join(" AND ");
        query += " GROUP BY category ORDER BY category";

        const result = await pool.query(query, values);
        return res.json(result.rows);
      } else {
        // 2025+ table logic (category totals)
        const result = await pool.query(
          `SELECT category, total_cost FROM soil_products_category_totals_new WHERE year = $1`,
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
            (rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24),
          ) + 1;

        const computed = result.rows.map((row: any) => ({
          category: row.category,
          total_cost: (Number(row.total_cost) / daysInYear) * daysInRange,
        }));

        return res.json(computed);
      }
    } catch (err) {
      console.error("Error fetching soil products by category:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

app.use("/revenues", revenuesRoute);

app.use("/employees", employeesRoute);

app.use("/salary-periods", salaryPeriodsRoutes);

app.use("/other-costs-entry", otherCostsEntry);

app.use("/units", unitsSold);

app.use("/unspecified", unspecifiedRoute);

app.use("/journal", journalRoute);

app.use("/units-sold-entries", unitsSoldEntries);

app.use("/getFields", getFieldsRoute);

app.use("/supervisors", supervisorRoute);

app.use("/vegetables", vegetablesRoute);

app.use("/projected-revenues", projectedRevenuesRoute);

app.use("/task-categories", taskCateogriesRoute);

app.use("/losses-tracking", lossesTrackingRoute);

app.use("/portal", portalRoute);

app.use("/warehouse", warehouseProductsRoute);

app.use("/timesheets/session", timesheetsSessionRoute);

app.use("/timesheets/tasks", timesheetsTasksRoute);

app.use("/timesheets/calculations", timeSheetsCalculationsRoute);

app.use("/timesheets/user", userDailyDurationRoute);

app.use("/timesheets/admin", adminRoute);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log("✅ Server running on http://localhost:3000"),
);
