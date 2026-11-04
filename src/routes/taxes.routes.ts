import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import * as taxes from "../controllers/taxes.controller";

/** Impuestos: contabilidad (gerencia pasa siempre; el auditor solo lee). ?period=AAAA-MM */
const router = Router();
router.use(authMiddleware, requireRoles("contabilidad"));

router.get("/ats", taxes.atsSummary);
router.get("/ats/xml", taxes.atsFile);
router.get("/reconciliation", taxes.monthlyReconciliation);

router.get("/reports/purchases-by-tax-support", taxes.purchasesByTaxSupport);
router.get("/reports/withholdings", taxes.purchaseWithholdings);
router.get("/reports/sales-withholdings", taxes.salesWithholdings);

export default router;
