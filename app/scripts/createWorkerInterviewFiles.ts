import fs from "node:fs/promises"
import path from "node:path"

import { pool } from "../db"

const run = async () => {
  const sqlPath = path.join(__dirname, "createWorkerInterviewFiles.sql")
  const sql = await fs.readFile(sqlPath, "utf8")

  await pool.query(sql)
  console.log("Worker interview files are ready.")
}

run()
  .catch((error) => {
    console.error("Unable to create worker interview files:", error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
