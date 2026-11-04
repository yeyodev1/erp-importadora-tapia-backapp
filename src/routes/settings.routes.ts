import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminOnly, requireRoles } from "../middlewares/roles.middleware";
import * as settingsController from "../controllers/settings.controller";

const router = Router();
router.use(authMiddleware);

router.get("/", requireRoles("contabilidad", "facturacion", "cartera", "bodega"), settingsController.get);
router.put("/", requireRoles("contabilidad"), settingsController.update);
// Cerrar o reabrir meses: contabilidad, que es quien declara.
router.put("/lock", requireRoles("contabilidad"), settingsController.lock);

router.get("/users", adminOnly, settingsController.listUsers);
router.post("/users", adminOnly, settingsController.createUser);
router.put("/users/:id", adminOnly, settingsController.updateUser);

export default router;
