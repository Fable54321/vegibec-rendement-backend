import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcrypt";
import { pool } from "../db";

async function createAdmin() {
  try {
    const username = process.env.INIT_ADMIN_USERNAME || "tim-dev";
    const plainPassword = process.env.INIT_ADMIN_PASSWORD || "dev-password";
    const saltRounds = 12;

    console.log(`🔐 Creating admin user "${username}"...`);

    const hash = await bcrypt.hash(plainPassword, saltRounds);

    const result = await pool.query(
      `
        INSERT INTO users (username, password_hash, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (username) DO NOTHING
        RETURNING id, username, role, created_at;
      `,
      [username, hash, "admin"]
    );

    if (result.rows.length > 0) {
      console.log(
        `✅ Admin user "${username}" created successfully with role "${result.rows[0].role}".`
      );
    } else {
      console.log(`ℹ️ Admin user "${username}" already exists, skipped.`);
    }
  } catch (err) {
    console.error("❌ Error creating admin:", err);
  } finally {
    await pool.end();
  }
}

createAdmin();
