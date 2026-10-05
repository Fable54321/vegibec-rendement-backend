import express, { Express } from "express";
import path from "path";
import { pool } from "../db";
import { authMiddleware } from "../middleware/auth";
import testContractRoute from "../Utils/testContract/testContract";
import addFieldsRoute from "./addFields";
import agrivisionRoute from "./Agrivision/agrivision";
import alternativeAuthRoute from "./alternativeAuth";
import authRoute from "./auth";
import converterRoute from "./Converter/Converter";
import signatureRoute from "./DigitalSignature/digitalSignature";
import evaluationRoute from "./evaluation/evaluation.routes";
import evaluationNewRouter from "./evaluation/evaluationNew.routes";
import facebookRoute, { publicFacebookRouter } from "./Facebook/PostToFacebook";
import getUrlRoute from "./Facebook/GetImageUrl";
import getFieldsRoute from "./getFields";
import hrLogsRoute from "./HRLogs/HRLogs.routes";
import publicAgreementSigningRoute from "./HRLogs/PublicAgreementSigning.routes";
import inventoryRoute from "./Inventory/inventory";
import lossesTrackingRoute from "./lossesTrackingRoute";
import otherCostsEntryRoute from "./otherCostsEntry";
import pictureTransferRoute from "./PictureTransfer/PictureTransfer";
import qualityPicturesRoute from "./PictureTransfer/QualityPictures";
import buyingRoute from "./Portal/BuyingRoute";
import fileTransferRoute from "./Portal/FileTransfer";
import foreignWorkersRoute from "./Portal/ForeignWorkers";
import portalRoute from "./Portal/Portal";
import purchaseDraftsRoute from "./Portal/PurchaseDrafts";
import purchaseJournalRoute from "./Portal/PurchaseJournal";
import purchaseRequestRoute from "./Portal/PurchaseRequest";
import receiptVoucherRoute from "./Portal/ReceiptVoucherRoute";
import roomsRoute from "./Portal/RoomsRoute";
import salesClientsRoute from "./Portal/SalesClientsRoute";
import suppliersRoute from "./Portal/SuppliersRoute";
import visitorsInfoRoute from "./Portal/VisitorsInfo";
import projectedRevenuesRoute from "./projectedRevenues.routes";
import rateConverterRoute from "./rateConverter";
import revenuesRoute from "./revenues";
import salaryPeriodsRoutes from "./salaryPeriods";
import salesOrdersRoute from "./sales/salesOrders";
import salesProductsRoute from "./sales/salesProducts";
import supervisorRoute from "./supervisors";
import taskCategoriesRoute from "./taskCategories";
import taskCostsRoute, { taskCostCreationRoute } from "./taskCosts";
import temperaturesRoute from "./Temperatures/temperatures";
import adminRoute from "./Timesheets/admin";
import timeSheetsCalculationsRoute from "./Timesheets/calculations";
import overtimeRoute from "./Timesheets/overtimeRoute";
import timesheetsSessionRoute from "./Timesheets/session";
import timesheetsTasksRoute from "./Timesheets/tasks";
import userDailyDurationRoute from "./Timesheets/userDailyDuration";
import toolboxesRoute from "./ToolBoxes/toolboxes";
import vehiclesRoute from "./ToolBoxes/vehicles";
import finishedProductsRoute from "./Trackability/finishedProducts";
import harvestingRoute from "./Trackability/harvesting";
import trackabilityRoute from "./Trackability/trackability";
import transportRoute from "./Transports/transport.routes";
import portalUnprotectedRoute from "./Unprotected/PortalUnprotected";
import unprotectedRoute from "./Unprotected/Unprotected";
import unitsSoldRoute from "./unitsSold";
import unitsSoldEntriesRoute from "./unitsSoldEntries";
import unspecifiedRoute from "./unspecified_route";
import vegReportsRouter from "./USDA";
import vegetablesRoute from "./vegetables";
import planRoute from "./Visitors/plan";
import visitorsRoute from "./Visitors/visitors";
import warehouseProductsRoute from "./Warehouse/products";
import weatherRoute from "./Weather/WeatherRoutes";
import workersScheduleRoute from "./WorkersSchedule/WorkersSchedule";
import employeesRoute from "./employees";
import journalRoute from "./journal";

function registerPublicRoutes(app: Express): void {
  app.get("/", async (_req, res) => {
    try {
      const result = await pool.query("SELECT NOW()");
      res.json(result.rows);
    } catch (error) {
      console.error("Database error:", error);
      res.status(500).json({ error: "Database error" });
    }
  });

  app.use("/unprotected", unprotectedRoute);
  app.use("/signature", signatureRoute);
  app.use("/plan", planRoute);
  app.use(
    "/generated",
    express.static(path.join(process.cwd(), "public", "generated")),
  );
  app.use("/api/rate-converter", rateConverterRoute);
  app.use("/api/vegReports", vegReportsRouter);
  app.use(
    "/generated-contracts",
    express.static(path.join(process.cwd(), "public", "generated-contracts")),
  );
  app.use("/picture-transfer", pictureTransferRoute);
  app.use("/purchase-request", purchaseRequestRoute);
  app.use("/buying", buyingRoute);
  app.use("/receipt-vouchers", receiptVoucherRoute);
  app.use("/suppliers", suppliersRoute);
  app.use("/sales", salesClientsRoute);
  app.use("/portal-unprotected", portalUnprotectedRoute);
  app.use("/hr-agreement-signing", publicAgreementSigningRoute);
  app.use("/facebook", publicFacebookRouter);

  if (process.env.NODE_ENV !== "production") {
    app.use("/test", testContractRoute);
  }

  app.use("/auth", authRoute);
  app.use("/file-transfer", fileTransferRoute);
}

function registerProtectedRoutes(app: Express): void {
  app.use(authMiddleware);
  app.use("/quality-pictures", qualityPicturesRoute);
  app.use("/sales", salesProductsRoute);
  app.use("/sales", salesOrdersRoute);
  app.use("/alternative-auth", alternativeAuthRoute);
  app.use("/hr-logs", hrLogsRoute);
  app.use(taskCostCreationRoute);
  app.use("/fix-field", addFieldsRoute);
  app.use(taskCostsRoute);
  app.use("/revenues", revenuesRoute);
  app.use("/employees", employeesRoute);
  app.use("/salary-periods", salaryPeriodsRoutes);
  app.use("/other-costs-entry", otherCostsEntryRoute);
  app.use("/units", unitsSoldRoute);
  app.use("/unspecified", unspecifiedRoute);
  app.use("/journal", journalRoute);
  app.use("/units-sold-entries", unitsSoldEntriesRoute);
  app.use("/getFields", getFieldsRoute);
  app.use("/supervisors", supervisorRoute);
  app.use("/vegetables", vegetablesRoute);
  app.use("/projected-revenues", projectedRevenuesRoute);
  app.use("/task-categories", taskCategoriesRoute);
  app.use("/losses-tracking", lossesTrackingRoute);
  app.use("/portal/visitors-info", visitorsInfoRoute);
  app.use("/portal", portalRoute);
  app.use("/portal/foreign-workers", foreignWorkersRoute);
  app.use("/evaluation", evaluationRoute);
  app.use("/evaluation-new", evaluationNewRouter);
  app.use("/warehouse", warehouseProductsRoute);
  app.use("/inventory", inventoryRoute);
  app.use("/trackability/harvesting", harvestingRoute);
  app.use("/trackability", trackabilityRoute);
  app.use("/finished-products", finishedProductsRoute);
  app.use("/transport", transportRoute);
  app.use("/timesheets/session", timesheetsSessionRoute);
  app.use("/timesheets/tasks", timesheetsTasksRoute);
  app.use("/timesheets/calculations", timeSheetsCalculationsRoute);
  app.use("/timesheets/user", userDailyDurationRoute);
  app.use("/timesheets/overtime", overtimeRoute);
  app.use("/timesheets/admin", adminRoute);
  app.use("/agrivision", agrivisionRoute);
  app.use("/toolboxes", toolboxesRoute);
  app.use("/vehicles", vehiclesRoute);
  app.use("/schedule", workersScheduleRoute);
  app.use("/converter", converterRoute);
  app.use("/visitors", visitorsRoute);
  app.use("/weather", weatherRoute);
  app.use("/temperatures", temperaturesRoute);
  app.use("/facebook", facebookRoute);
  app.use("/get-url", getUrlRoute);
  app.use("/rooms", roomsRoute);
  app.use("/purchase-journal", purchaseJournalRoute);
  app.use("/purchase-drafts", purchaseDraftsRoute);
}

export function registerRoutes(app: Express): void {
  registerPublicRoutes(app);
  registerProtectedRoutes(app);
}
