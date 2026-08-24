import { Router } from "express";

import {
  getTransportOrders,
  getClientStops,
  optimizeRoute,
  resolveClientLocations,
  createScanSession,
  getScanSession,
  addScanSessionItem,
  resolveScanSessionItem,
  deleteScanSessionItem,
  analyzeTransportDocument,
} from "../Transports/transport.controller";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const portalAccess = requireAppRole("main", ["admin", "user", "guest"]);

router.get("/orders", portalAccess, getTransportOrders);
router.get("/client-stops", portalAccess, getClientStops);
router.post("/client-locations", portalAccess, resolveClientLocations);
router.post("/optimize-route", portalAccess, optimizeRoute);
router.post("/scan-sessions", portalAccess, createScanSession);
router.get("/scan-sessions/:token", portalAccess, getScanSession);
router.post("/scan-sessions/:token/items", portalAccess, addScanSessionItem);
router.patch("/scan-sessions/:token/items/:itemId", portalAccess, resolveScanSessionItem);
router.delete("/scan-sessions/:token/items/:itemId", portalAccess, deleteScanSessionItem);
router.post("/analyze-document", portalAccess, analyzeTransportDocument);

export default router;
