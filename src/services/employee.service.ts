import { CustomError } from "../errors/customError.error";
import { Employee } from "../models/employee.model";
import { EmployeeLoan, LOAN_TYPES } from "../models/employeeLoan.model";
import { ID_TYPES, Party } from "../models/party.model";
import { DEPARTMENTS } from "../models/settings.model";
import { cents } from "../utils/money";
import { parseDay } from "../utils/dates";
import { makeCrud } from "./crud.service";
import { idProblem } from "./migrationRules.service";

/** Ficha del trabajador y sus préstamos. Catálogos: no se borran, se desactivan. */

function requireText(data: Record<string, unknown>, key: string, label: string) {
  if (data[key] === undefined) return;
  data[key] = String(data[key] ?? "").trim();
  if (!data[key]) throw new CustomError(`Falta ${label}`, 400);
}

/** Usa el tercero de esa cédula (lo marca empleado) o crea uno: cheques y anticipos caen en el mismo. */
async function linkParty(data: Record<string, unknown>) {
  const identification = String(data.identification);
  const existing = await Party.findOneAndUpdate({ identification }, { $set: { isEmployee: true } }, { new: true }).lean<any>();
  if (existing) return existing._id;
  const party = await Party.create({
    identification,
    idType: ID_TYPES.CEDULA,
    name: `${data.lastName} ${data.firstName}`.toUpperCase(),
    address: data.address ?? "",
    phone: data.phone ?? "",
    email: data.email ?? "",
    isEmployee: true,
  });
  return party._id;
}

async function validateEmployee(data: Record<string, unknown>, isNew: boolean) {
  requireText(data, "firstName", "los nombres");
  requireText(data, "lastName", "los apellidos");
  if (data.department !== undefined && !DEPARTMENTS.includes(data.department as any)) {
    throw new CustomError("Departamento inválido: administración o ventas", 400);
  }
  if (data.salary !== undefined) data.salary = cents(data.salary, "sueldo");
  if (data.commissionRate !== undefined) {
    const rate = Number(data.commissionRate);
    if (!(rate >= 0 && rate <= 100)) throw new CustomError("El % de comisión debe estar entre 0 y 100", 400);
    data.commissionRate = rate;
  }
  if (data.hireDate !== undefined) data.hireDate = parseDay(data.hireDate, "fecha de ingreso");
  if (data.exitDate !== undefined) data.exitDate = data.exitDate ? parseDay(data.exitDate, "fecha de salida") : null;

  if (!isNew) {
    // La cédula ata la ficha a su tercero: no cambia.
    delete data.identification;
    return;
  }
  const id = String(data.identification ?? "").trim();
  const problem = /^\d{10}$/.test(id) ? idProblem(id) : "debe tener 10 dígitos";
  if (problem) throw new CustomError(`Cédula inválida: ${problem}`, 400);
  data.identification = id;
  for (const [key, label] of [["firstName", "los nombres"], ["lastName", "los apellidos"], ["hireDate", "la fecha de ingreso"], ["department", "el departamento"], ["salary", "el sueldo"]]) {
    if (data[key] === undefined) throw new CustomError(`Falta ${label}`, 400);
  }
  if (await Employee.exists({ identification: id })) throw new CustomError("Ya hay un empleado con esa cédula", 409);
  data.partyId = await linkParty(data);
}

export const employees = makeCrud(Employee, {
  label: "Empleado",
  searchFields: ["identification", "firstName", "lastName", "position", "sellerName"],
  sort: { lastName: 1, firstName: 1 },
  writable: [
    "identification",
    "firstName",
    "lastName",
    "address",
    "phone",
    "email",
    "hireDate",
    "department",
    "position",
    "salary",
    "sellerName",
    "commissionRate",
    "reserveFundMonthly",
    "isActive",
    "exitDate",
  ],
  filters: ["department"],
  validate: validateEmployee,
});

const nullableCents = (v: unknown, field: string) => (v === null || v === "" ? null : cents(v, field));

async function validateLoan(data: Record<string, unknown>, isNew: boolean) {
  if (data.installment !== undefined) data.installment = cents(data.installment, "cuota");
  if (data.balance !== undefined) data.balance = nullableCents(data.balance, "saldo");
  if (data.date !== undefined) data.date = parseDay(data.date, "fecha del préstamo");
  if (!isNew) {
    // Empleado, tipo y monto prestado no cambian; la cuota, el saldo y el estado sí.
    delete data.employeeId;
    delete data.type;
    delete data.total;
    return;
  }
  if (!data.employeeId || !(await Employee.exists({ _id: String(data.employeeId) }))) {
    throw new CustomError("Elige el empleado del préstamo", 400);
  }
  if (!LOAN_TYPES.includes(data.type as any)) throw new CustomError("Tipo de préstamo inválido", 400);
  if (!data.date) throw new CustomError("Falta la fecha del préstamo", 400);
  if (!data.installment) throw new CustomError("La cuota mensual debe ser mayor que cero", 400);
  data.total = data.total === undefined || data.total === null || data.total === "" ? 0 : cents(data.total, "monto prestado");
  if (data.type === "interno") {
    if (!data.total) throw new CustomError("Falta el monto prestado", 400);
    // Un préstamo que ya venía pagándose entra con su saldo; si no, el saldo es el total.
    data.balance ??= data.total;
    if ((data.balance as number) > (data.total as number)) throw new CustomError("El saldo no puede superar el monto prestado", 400);
  } else {
    data.balance ??= null;
  }
}

export const loans = makeCrud(EmployeeLoan, {
  label: "Préstamo",
  searchFields: ["description"],
  sort: { date: -1 },
  writable: ["employeeId", "type", "date", "description", "total", "installment", "balance", "isActive"],
  filters: ["employeeId", "type"],
  populate: ["employeeId"],
  validate: validateLoan,
});
