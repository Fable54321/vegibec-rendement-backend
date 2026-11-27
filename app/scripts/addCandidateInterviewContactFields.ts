import { pool } from "../db";

async function migrate(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE candidates_interviews.candidates_interviews
        ADD COLUMN IF NOT EXISTS first_name varchar(100),
        ADD COLUMN IF NOT EXISTS last_name varchar(100),
        ADD COLUMN IF NOT EXISTS phone_number_1 varchar(30),
        ADD COLUMN IF NOT EXISTS phone_number_2 varchar(30)
    `);
    await client.query("COMMIT");
    console.log("Candidate interview contact fields are ready.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void migrate().catch((error) => {
  console.error("Candidate interview contact field migration failed:", error);
  process.exitCode = 1;
});
