import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();


// export const pool = new Pool({
//   connectionString:
// ""  ,ssl: {
//     rejectUnauthorized: false,
//   },
// });

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl:
        process.env.DB_SSL === "true"
          ? {
              rejectUnauthorized: false,
            }
          : false,
    });
