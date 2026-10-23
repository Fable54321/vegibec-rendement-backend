import { pool } from "../db";

async function migrate(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE portal.time_off_request
        ALTER COLUMN requester_user_id DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS guest_name varchar(160),
        ADD COLUMN IF NOT EXISTS guest_email varchar(254)
    `);
    await client.query(`
      ALTER TABLE portal.time_off_request
        DROP CONSTRAINT IF EXISTS time_off_request_requester_identity_check
    `);
    await client.query(`
      ALTER TABLE portal.time_off_request
        ADD CONSTRAINT time_off_request_requester_identity_check CHECK (
          (requester_user_id IS NOT NULL AND guest_name IS NULL AND guest_email IS NULL)
          OR
          (requester_user_id IS NULL
            AND NULLIF(BTRIM(guest_name), '') IS NOT NULL
            AND NULLIF(BTRIM(guest_email), '') IS NOT NULL)
        )
    `);
    await client.query("COMMIT");
    console.log("Time-off guest request migration completed.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void migrate().catch((error) => {
  console.error("Time-off guest request migration failed:", error);
  process.exitCode = 1;
});
