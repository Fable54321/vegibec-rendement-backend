import { Pool } from "pg";



// for local testing ///


// export const pool = new Pool({
//   connectionString:
//     "insert your connection string here",
//   ssl: {
//     rejectUnauthorized: false,
//   },
// });


export const pool = new Pool({
  connectionString:
    "postgresql://neondb_owner:npg_Ubo6aclf9SMh@ep-plain-pond-ad5b018w-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  ssl: {
    rejectUnauthorized: false,
  },
});

// export const pool = new Pool({
//   host: process.env.DB_HOST,
//   port: Number(process.env.DB_PORT),
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD ,
//   database: process.env.DB_NAME,
//   // --- START OF REQUIRED FIX FOR NEON ---
//   ssl:
//     process.env.DB_SSL === "true"
//       ? {
//           // This tells the pg library to use SSL encryption
//           // but skip validating the server's certificate against
//           // system CAs, which is often necessary for cloud providers.
//           rejectUnauthorized: false,
//         }
//       : false,
//   // --- END OF REQUIRED FIX ---
// });
