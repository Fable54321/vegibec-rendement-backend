import { Router } from "express";

import {
  getTransportOrders,
  optimizeRoute,
} from "../Transports/transport.controller";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const portalAccess = requireAppRole("main", ["admin", "user", "guest"]);

router.get("/orders", portalAccess, getTransportOrders);
router.post("/optimize-route", portalAccess, optimizeRoute);

export default router;
