import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import * as notifications from "../controllers/notifications.controller";

/** Avisos de la campana: todos los roles internos leen; el service recorta según el rol. */
const router = Router();
router.use(authMiddleware, requireRoles("contabilidad", "facturacion", "cartera", "bodega", "vendedor"));

router.get("/", notifications.list);

export default router;
