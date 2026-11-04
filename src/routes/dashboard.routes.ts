import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import * as dashboard from "../controllers/dashboard.controller";

/** Tablero de Inicio: todos los roles internos leen; el service recorta las secciones según el rol. ?month=AAAA-MM */
const router = Router();
router.use(authMiddleware, requireRoles("contabilidad", "facturacion", "cartera", "bodega", "vendedor"));

router.get("/", dashboard.getDashboard);

export default router;
