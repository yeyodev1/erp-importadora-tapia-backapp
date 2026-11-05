import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/roles.middleware";
import { crudHandlers } from "../controllers/crud.controller";
import * as payroll from "../controllers/payroll.controller";
import * as employeeService from "../services/employee.service";

/** Nómina: empleados, préstamos y rol de pagos. Contabilidad escribe; admin pasa siempre y el auditor solo lee. */
const router = Router();
router.use(authMiddleware, requireRoles("contabilidad"));

for (const [path, crud] of [
  ["/employees", crudHandlers(employeeService.employees)],
  ["/loans", crudHandlers(employeeService.loans)],
] as const) {
  router.get(path, crud.list);
  router.get(`${path}/:id`, crud.get);
  router.post(path, crud.create);
  router.put(`${path}/:id`, crud.update);
}

router.get("/payrolls", payroll.list);
router.post("/payrolls", payroll.generate);
router.get("/payrolls/:id", payroll.get);
router.put("/payrolls/:id", payroll.update);
router.post("/payrolls/:id/approve", payroll.approve);
router.post("/payrolls/:id/void", payroll.voidPayroll);

export default router;
