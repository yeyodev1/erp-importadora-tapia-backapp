import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import * as ar from "../controllers/receivables.controller";

/** Cuentas por cobrar: cartera y contabilidad escriben; facturación lee (auditor lee siempre). */
const router = Router();
router.use(authMiddleware);

const read = requireRoles("cartera", "contabilidad", "facturacion");
const write = requireRoles("cartera", "contabilidad");

router.get("/open-invoices", read, ar.openInvoices);

router.get("/receipts", read, ar.listReceipts);
router.post("/receipts", write, ar.createReceipt);
router.get("/receipts/:id", read, ar.getReceipt);
router.post("/receipts/:id/void", write, ar.voidReceipt);

router.get("/postdated-checks", read, ar.listChecks);
router.post("/postdated-checks/:id/deposit", write, ar.depositCheck);
router.post("/postdated-checks/:id/confirm", write, ar.confirmCheck);
router.post("/postdated-checks/:id/return", write, ar.returnCheck);

router.get("/withholdings", read, ar.listWithholdings);
router.post("/withholdings", write, ar.createWithholding);

router.get("/reports", read, ar.report);
router.get("/reports/withholdings", read, ar.withholdingsReport);
router.get("/reports/commissions", read, ar.commissions);

export default router;
