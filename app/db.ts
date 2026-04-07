import { Pool } from "pg";





// export const pool = new Pool({
//   connectionString:
//     "",
//   ssl: {
//     rejectUnauthorized: false,
//   },
// });

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD ,
  database: process.env.DB_NAME,
  // --- START OF REQUIRED FIX FOR NEON ---
  ssl:
    process.env.DB_SSL === "true"
      ? {
         
          rejectUnauthorized: false,
        }
      : false,
  // --- END OF REQUIRED FIX ---
});
