import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcrypt";
import { pool } from "../db";


const names = ["tim", "fab", "mo"];
const surnames = ["biss", "lec", "lec"]

const userNames =  ["tim", "fab", "mo"];



async function createGuest(name:string, surname:string, username:string, plainPassword:string) {
  try {
    
    
    const saltRounds = 12;


    console.log(`🔐 Creating guest user "${username}"...`);

    const hash = await bcrypt.hash(plainPassword, saltRounds);

    const result = await pool.query(
      `
        INSERT INTO users (username, password_hash, role, surname, name)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (username) DO NOTHING
        RETURNING id, username, role, created_at;
      `,
      [username, hash, "guest", surname, name]
    );

    if (result.rows.length > 0) {
      console.log(
        `✅ Guest user "${username}" created successfully with role "${result.rows[0].role}".`
      );
    } else {
      console.log(`ℹ️ Guest user "${username}" already exists, skipped.`);
    }
  } catch (err) {
    console.error("❌ Error creating Guest:", err);
  } finally {
    await pool.end();
  }
}


for(let i =0; i < names.length; i++){
  createGuest(names[i], surnames[i], userNames[i], "000" + i.toString())
}