import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import * as sales from "../controllers/sales.controller";

/** Facturación: facturacion y contabilidad escriben; cartera también lee (auditor lee siempre). */
const router = Router();
router.use(authMiddleware);

const read = requireRoles("facturacion", "contabilidad", "cartera");
const write = requireRoles("facturacion", "contabilidad");

router.get("/invoices", read, sales.listInvoices);
router.post("/invoices", write, sales.createInvoice);
router.get("/invoices/:id", read, sales.getInvoice);
router.post("/invoices/:id/void", write, sales.voidInvoice);
router.post("/invoices/:id/sri-retry", write, sales.retryInvoiceSri);
router.get("/invoices/:id/ride", read, sales.invoiceRide);

router.get("/credit-notes", read, sales.listCreditNotes);
router.post("/credit-notes", write, sales.createCreditNote);
router.get("/credit-notes/:id", read, sales.getCreditNote);
router.post("/credit-notes/:id/sri-retry", write, sales.retryCreditNoteSri);
router.get("/credit-notes/:id/ride", read, sales.creditNoteRide);

router.get("/debit-notes", read, sales.listDebitNotes);
router.post("/debit-notes", write, sales.createDebitNote);
router.post("/debit-notes/:id/sri-retry", write, sales.retryDebitNoteSri);
router.get("/debit-notes/:id/ride", read, sales.debitNoteRide);

router.get("/proformas", read, sales.listProformas);
router.post("/proformas", write, sales.createProforma);
router.get("/proformas/:id", read, sales.getProforma);
router.post("/proformas/:id/invoice", write, sales.invoiceProforma);

router.get("/reports/sales", read, sales.salesReport);
router.get("/reports/top-products", read, sales.topProducts);

export default router;
