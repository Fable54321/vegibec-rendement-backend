import { Router, type Request, type Response, type NextFunction } from "express";
import { pool } from "../../db";

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
  ensureTransportScanTables,
} from "../Transports/transport.controller";
import {
  createSavedRoutePlan,
  deleteSavedRoutePlan,
  listSavedRoutePlans,
  updateSavedRoutePlan,
} from "./savedRoutePlans.controller";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const portalAccess = requireAppRole("main", ["admin", "user", "guest"]);

const scanTokenAccess = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureTransportScanTables();
    const session = await pool.query(
      `SELECT s.owner_user_id, u.username
       FROM logistics.transport_scan_sessions s
       JOIN users u ON u.id = s.owner_user_id
       WHERE s.token = $1 AND s.expires_at > NOW()
       LIMIT 1`,
      [req.params.token],
    );
    if (!session.rows.length) return res.status(404).json({ error: "Scan session not found or expired" });
    req.user = { id: Number(session.rows[0].owner_user_id), username: session.rows[0].username };
    return next();
  } catch (error) {
    console.error("Transport scan token access error:", error);
    return res.status(500).json({ error: "Unable to validate scan session" });
  }
};

router.get("/public-scan/:token", scanTokenAccess, getScanSession);
router.post("/public-scan/:token/items", scanTokenAccess, addScanSessionItem);
router.post("/public-scan/:token/analyze-document", scanTokenAccess, analyzeTransportDocument);

router.get("/orders", portalAccess, getTransportOrders);
router.get("/client-stops", portalAccess, getClientStops);
router.post("/client-locations", portalAccess, resolveClientLocations);
router.post("/optimize-route", portalAccess, optimizeRoute);
router.get("/route-plans", portalAccess, listSavedRoutePlans);
router.post("/route-plans", portalAccess, createSavedRoutePlan);
router.patch("/route-plans/:planId", portalAccess, updateSavedRoutePlan);
router.delete("/route-plans/:planId", portalAccess, deleteSavedRoutePlan);
router.post("/scan-sessions", portalAccess, createScanSession);
router.get("/scan-sessions/:token", portalAccess, getScanSession);
router.post("/scan-sessions/:token/items", portalAccess, addScanSessionItem);
router.patch("/scan-sessions/:token/items/:itemId", portalAccess, resolveScanSessionItem);
router.delete("/scan-sessions/:token/items/:itemId", portalAccess, deleteScanSessionItem);
router.post("/analyze-document", portalAccess, analyzeTransportDocument);

export default router;
