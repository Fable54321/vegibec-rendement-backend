import dotenv from "dotenv";
import { createApp } from "./app";
import { startServer } from "./server";

dotenv.config();

startServer(createApp());
