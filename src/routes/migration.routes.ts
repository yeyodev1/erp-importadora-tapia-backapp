import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminOnly } from "../middlewares/roles.middleware";
import * as migration from "../controllers/migration.controller";

/** Migración de datos (Macio, app de Proveedores, datos de ejemplo): solo gerencia. */
const router = Router();
router.use(authMiddleware, adminOnly);

router.post("/macio/preview", migration.macioPreview);
router.post("/macio/apply", migration.macioApply);
router.post("/proveedores/preview", migration.suppliersPreview);
router.post("/proveedores/apply", migration.suppliersApply);
router.post("/proveedores-excel/preview", migration.supplierListPreview);
router.post("/proveedores-excel/apply", migration.supplierListApply);
router.post("/demo/preview", migration.demoPreview);
router.post("/demo/apply", migration.demoApply);
router.get("/batches", migration.listBatches);
router.post("/batches/:id/undo", migration.undoBatch);

export default router;
