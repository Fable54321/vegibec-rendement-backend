import { Router } from "express";

import {
  optimizeRoute,
} from "../Transports/transport.controller";

const router = Router();

router.post("/optimize-route", optimizeRoute);

export default router;