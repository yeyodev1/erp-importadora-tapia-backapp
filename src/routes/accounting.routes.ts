import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import * as accountingController from "../controllers/accounting.controller";

// Contabilidad escribe; admin pasa siempre y el auditor solo lee (GET).
const router = Router();
router.use(authMiddleware, requireRoles("contabilidad"));

router.get("/entries", accountingController.searchEntries);
router.post("/entries", accountingController.createEntry);
router.get("/entries/:id", accountingController.getEntry);
router.post("/entries/:id/void", accountingController.voidEntry);

router.get("/reports/journal", accountingController.journalBook);
router.get("/reports/ledger", accountingController.ledger);
router.get("/reports/trial-balance", accountingController.trialBalance);
router.get("/reports/income-statement", accountingController.incomeStatement);
router.get("/reports/balance-sheet", accountingController.balanceSheet);
router.get("/reports/comparative", accountingController.comparative);

router.get("/year-close", accountingController.listCloses);
router.post("/year-close", accountingController.closeYear);
router.post("/year-close/:year/reopen", accountingController.reopenYear);

router.post("/chart/import", accountingController.importChart);

export default router;
