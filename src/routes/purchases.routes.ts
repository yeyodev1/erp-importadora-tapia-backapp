import express, { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import { crudHandlers } from "../controllers/crud.controller";
import * as purchases from "../controllers/purchases.controller";
import { withholdingCodes } from "../services/withholdingCode.service";

/**
 * Compras y Cuentas por pagar. Contabilidad escribe (gerencia pasa siempre,
 * también para aprobar pagos); el auditor solo lee.
 */
const router = Router();
router.use(authMiddleware, requireRoles("contabilidad"));

const codes = crudHandlers(withholdingCodes);
router.get("/withholding-codes", codes.list);
router.get("/withholding-codes/:id", codes.get);
router.post("/withholding-codes", codes.create);
router.put("/withholding-codes/:id", codes.update);

// El XML puede llegar crudo (text/xml) o como { xml } en JSON.
const xmlText = express.text({ type: ["text/xml", "application/xml", "text/plain"], limit: "5mb" });
router.post("/invoices/xml", xmlText, purchases.importXml);
router.post("/invoices/xml/batch", purchases.importBatch);

router.get("/invoices", purchases.listInvoices);
router.post("/invoices", purchases.createInvoice);
router.get("/invoices/:id", purchases.getInvoice);
router.post("/invoices/:id/void", purchases.voidInvoice);
router.post("/invoices/:id/withholding/resend", purchases.resendWithholding);

router.get("/credit-notes", purchases.listCreditNotes);
router.post("/credit-notes", purchases.createCreditNote);

router.get("/approvals", purchases.listApprovals);
router.post("/approvals", purchases.approve);
router.post("/approvals/:id/cancel", purchases.cancelApproval);

router.get("/transactions", purchases.listTransactions);
router.post("/payments", purchases.executePayment);
router.post("/advances", purchases.createAdvance);
router.post("/advances/:id/cross", purchases.crossAdvance);
router.post("/advances/:id/refund", purchases.refundAdvance);
router.post("/transactions/:id/void", purchases.voidTransaction);

router.get("/reports/balances", purchases.supplierBalances);
router.get("/reports/statement/:id", purchases.supplierStatement);
router.get("/reports/advances", purchases.openAdvances);
router.get("/reports/by-supplier", purchases.purchasesBySupplier);
router.get("/reports/by-account", purchases.purchasesByAccount);
router.get("/reports/by-tax-support", purchases.purchasesByTaxSupport);
router.get("/reports/withholdings", purchases.withholdingsReport);

export default router;
