import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import { crudHandlers } from "../controllers/crud.controller";
import * as settingsController from "../controllers/settings.controller";
import * as catalogService from "../services/catalog.service";
import type { Role } from "../models/user.model";

/**
 * Catálogos maestros. Todos los usuarios los leen (para buscar al facturar);
 * solo quien administra cada uno lo escribe.
 */
const router = Router();
router.use(authMiddleware);

const ALL: Role[] = ["contabilidad", "facturacion", "cartera", "bodega", "vendedor"];

function mount(path: string, crud: ReturnType<typeof crudHandlers>, writers: Role[]) {
  router.get(path, requireRoles(...ALL), crud.list);
  router.get(`${path}/:id`, requireRoles(...ALL), crud.get);
  router.post(path, requireRoles(...writers), crud.create);
  router.put(`${path}/:id`, requireRoles(...writers), crud.update);
}

router.get("/parties/by-id/:identification", requireRoles(...ALL), settingsController.partyByIdentification);

mount("/accounts", crudHandlers(catalogService.accounts), ["contabilidad"]);
mount("/parties", crudHandlers(catalogService.parties), ["contabilidad", "facturacion", "cartera"]);
mount("/warehouses", crudHandlers(catalogService.warehouses), []);
mount("/product-groups", crudHandlers(catalogService.productGroups), ["contabilidad"]);
mount("/bank-accounts", crudHandlers(catalogService.bankAccounts), ["contabilidad"]);
mount("/products", crudHandlers(catalogService.products), ["contabilidad", "bodega"]);

export default router;
