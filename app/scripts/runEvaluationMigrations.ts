import fs from "fs";
import path from "path";
import { pool } from "../db";

async function run() {
  const migrationsDirectory = path.join(__dirname, "../routes/evaluation/migrations");
  const migrations = fs.readdirSync(migrationsDirectory).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await pool.query(fs.readFileSync(path.join(migrationsDirectory, migration), "utf8"));
    console.log(`Applied ${migration}`);
  }
  console.log("Evaluation schema migrations completed.");
}

run().catch((error) => {
  console.error("Evaluation schema migration failed:", error);
  process.exitCode = 1;
}).finally(() => pool.end());
