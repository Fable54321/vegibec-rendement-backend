import express, { Express } from "express";
import { configureHttp } from "./config/http";
import { registerRoutes } from "./routes/registerRoutes";

export function createApp(): Express {
  const app = express();
  configureHttp(app);
  registerRoutes(app);
  return app;
}
