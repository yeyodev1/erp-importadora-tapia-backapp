import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import * as uploadController from "../controllers/upload.controller";

const router = Router();

router.use(authMiddleware, requireRoles("contabilidad", "facturacion", "bodega", "cartera"));

router.get("/signature", uploadController.signature);

export default router;
