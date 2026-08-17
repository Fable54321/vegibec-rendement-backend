import { Router } from "express";

import {
  getTransportOrders,
  getClientStops,
  optimizeRoute,
  resolveClientLocations,
} from "../Transports/transport.controller";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const portalAccess = requireAppRole("main", ["admin", "user", "guest"]);

router.get("/orders", portalAccess, getTransportOrders);
router.get("/client-stops", portalAccess, getClientStops);
router.post("/client-locations", portalAccess, resolveClientLocations);
router.post("/optimize-route", portalAccess, optimizeRoute);

export default router;
