import express, { Application } from "express";
import authRoutes from "./auth.routes";
import healthRoutes from "./health.routes";
import uploadRoutes from "./upload.routes";
import catalogRoutes from "./catalog.routes";
import settingsRoutes from "./settings.routes";
import inventoryRoutes from "./inventory.routes";
import salesRoutes from "./sales.routes";
import receivablesRoutes from "./receivables.routes";
import purchasesRoutes from "./purchases.routes";
import banksRoutes from "./banks.routes";
import accountingRoutes from "./accounting.routes";
import taxesRoutes from "./taxes.routes";
import dashboardRoutes from "./dashboard.routes";
import notificationsRoutes from "./notifications.routes";
import migrationRoutes from "./migration.routes";
import { dbMiddleware } from "../middlewares/db.middleware";

/**
 * Un router por módulo, con los mismos nombres del sistema actual:
 * Inventario, Facturación (sales), Cuentas por cobrar, Cuentas por pagar
 * (purchases), Caja Bancos, Contabilidad e Impuestos.
 */
function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/health", healthRoutes);
  // Todo lo que sigue consulta Mongo: primero se asegura la conexión.
  router.use(dbMiddleware);
  router.use("/auth", authRoutes);
  router.use("/uploads", uploadRoutes);
  router.use("/catalog", catalogRoutes);
  router.use("/settings", settingsRoutes);
  router.use("/inventory", inventoryRoutes);
  router.use("/sales", salesRoutes);
  router.use("/receivables", receivablesRoutes);
  router.use("/purchases", purchasesRoutes);
  router.use("/banks", banksRoutes);
  router.use("/accounting", accountingRoutes);
  router.use("/taxes", taxesRoutes);
  router.use("/dashboard", dashboardRoutes);
  router.use("/notifications", notificationsRoutes);
  router.use("/migration", migrationRoutes);
}

export default routerApi;
