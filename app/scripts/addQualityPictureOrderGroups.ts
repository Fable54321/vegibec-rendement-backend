import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "../db";

const run = async () => {
  const sqlPath = path.join(__dirname, "addQualityPictureOrderGroups.sql");
  const sql = await fs.readFile(sqlPath, "utf8");

  await pool.query(sql);
  console.log("Quality-picture order groups are ready.");
};

run()
  .catch((error) => {
    console.error("Unable to add quality-picture order groups:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
