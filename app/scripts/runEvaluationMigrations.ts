import fs from "fs";
import path from "path";
import { pool } from "../db";

async function run() {
  const migrationPath = path.join(__dirname, "../routes/evaluation/migrations/001_create_evaluation_schema.sql");
  await pool.query(fs.readFileSync(migrationPath, "utf8"));
  console.log("Evaluation schema migration completed.");
}

run().catch((error) => {
  console.error("Evaluation schema migration failed:", error);
  process.exitCode = 1;
}).finally(() => pool.end());
