import { Express } from "express";
import { pool } from "./db";

export function startServer(app: Express) {
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () =>
    console.log("✅ Server running on http://localhost:3000"),
  );

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use. Stop the other process or set PORT to a free port.`,
      );
    } else {
      console.error("Server startup error:", error);
    }

    process.exit(1);
  });

  process.on("SIGINT", () => {
    console.log("Shutting down gracefully...");
    server.close(() => {
      console.log("Server closed.");
      pool.end(() => {
        console.log("Database pool closed.");
        process.exit(0);
      });
    });
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
    process.exit(1);
  });

  return server;
}
