import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import * as inventoryController from "../controllers/inventory.controller";
import type { Role } from "../models/user.model";

const router = Router();
router.use(authMiddleware);

// Bodega y contabilidad graban; todos los internos consultan (auditor solo GET).
const WRITERS: Role[] = ["bodega", "contabilidad"];
const READERS: Role[] = ["contabilidad", "facturacion", "cartera", "bodega", "vendedor"];

router.get("/transactions", requireRoles(...READERS), inventoryController.listTransactions);
router.get("/transactions/:id", requireRoles(...READERS), inventoryController.getTransaction);
router.post("/transactions", requireRoles(...WRITERS), inventoryController.createTransaction);
router.post("/transactions/:id/void", requireRoles(...WRITERS), inventoryController.voidTransaction);

router.get("/reports/kardex", requireRoles(...READERS), inventoryController.kardex);
router.get("/reports/balances", requireRoles(...READERS), inventoryController.balances);
router.get("/reports/physical-count", requireRoles(...READERS), inventoryController.physicalCount);
router.post("/reports/physical-count/adjust", requireRoles(...WRITERS), inventoryController.adjustFromCount);
router.get("/reports/negatives", requireRoles(...READERS), inventoryController.negatives);
router.get("/reports/below-minimum", requireRoles(...READERS), inventoryController.belowMinimum);
router.get("/reports/transfers", requireRoles(...READERS), inventoryController.transfers);

export default router;
