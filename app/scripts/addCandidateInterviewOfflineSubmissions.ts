import { pool } from "../db";

async function migrate(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE candidates_interviews.candidates_interviews
        ADD COLUMN IF NOT EXISTS client_submission_id uuid
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS candidates_interviews_client_submission_id_key
        ON candidates_interviews.candidates_interviews (client_submission_id)
        WHERE client_submission_id IS NOT NULL
    `);
    await client.query("COMMIT");
    console.log("Candidate interview offline submissions are ready.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void migrate().catch((error) => {
  console.error("Candidate interview offline submission migration failed:", error);
  process.exitCode = 1;
});
