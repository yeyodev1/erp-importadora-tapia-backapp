import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import * as banksController from "../controllers/banks.controller";

// Caja Bancos: contabilidad graba y consulta; el auditor solo lee (GET); admin pasa siempre.
const router = Router();
router.use(authMiddleware);
router.use(requireRoles("contabilidad"));

router.get("/transactions", banksController.listTransactions);
router.get("/transactions/:id", banksController.getTransaction);
router.post("/transactions", banksController.createTransaction);
router.post("/transactions/:id/void", banksController.voidTransaction);

router.get("/balances", banksController.cashAndBankBalances);
router.get("/accounts/:id/balance", banksController.balanceOf);
router.get("/accounts/:id/book", banksController.bankBook);
router.get("/reports/pending-checks", banksController.pendingChecks);

router.get("/reconciliations", banksController.listReconciliations);
router.post("/reconciliations", banksController.createReconciliation);
router.get("/reconciliations/:id", banksController.getReconciliation);
router.patch("/reconciliations/:id", banksController.updateReconciliation);
router.post("/reconciliations/:id/load", banksController.loadMovements);
router.post("/reconciliations/:id/close", banksController.closeReconciliation);
router.post("/reconciliations/:id/reopen", banksController.reopenReconciliation);
router.get("/reconciliations/:id/report", banksController.reconciliationReport);

// Conciliación semiautomática: match solo propone; confirm y note graban.
router.post("/reconciliations/:id/statement/match", banksController.matchStatement);
router.post("/reconciliations/:id/statement/confirm", banksController.confirmMatches);
router.post("/reconciliations/:id/statement/note", banksController.noteFromLine);

export default router;
