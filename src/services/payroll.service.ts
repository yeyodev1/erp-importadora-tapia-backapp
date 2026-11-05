import { ClientSession, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { runInTransaction } from "../config/transaction";
import { Employee } from "../models/employee.model";
import { EmployeeLoan } from "../models/employeeLoan.model";
import { Payroll, IPayrollLine } from "../models/payroll.model";
import { PAYROLL_DEFAULTS, PayrollRates } from "../models/settings.model";
import { cents, formatCents } from "../utils/money";
import { parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import { commissions } from "./collectionsReport.service";
import { computeLine, daysIn, payrollTotals, periodBounds, type LineBase, type LineEdits, type LoanInput } from "./payrollCalc.service";
import { payrollEntryLines } from "./payrollEntry.service";
import { oid, requireText, todayEc } from "./salesCommon.service";

/**
 * Rol de pagos mensual: se genera en borrador con los empleados activos,
 * se ajustan días, extras, comisiones y descuentos, y al aprobar se graba el
 * asiento NOMINA y se rebajan los préstamos. Anular reversa ambos.
 */

/** Préstamos vigentes en el período, por empleado. */
async function loansByEmployee(employeeIds: Types.ObjectId[], periodEnd: Date, session?: ClientSession) {
  const loans = await EmployeeLoan.find({
    employeeId: { $in: employeeIds },
    isActive: true,
    date: { $lte: periodEnd },
    $or: [{ balance: null }, { balance: { $gt: 0 } }],
  })
    .session(session ?? null)
    .sort({ date: 1 })
    .lean<any[]>();
  const map = new Map<string, LoanInput[]>();
  for (const l of loans) {
    const list = map.get(String(l.employeeId)) ?? [];
    list.push({ loanId: l._id, type: l.type, installment: l.installment, balance: l.balance });
    map.set(String(l.employeeId), list);
  }
  return map;
}

/** Comisión del mes sobre lo cobrado (reporte de comisiones), en centavos. */
async function commissionOf(emp: any, period: string): Promise<number> {
  if (!emp.sellerName || !emp.commissionRate) return 0;
  const { start, end } = periodBounds(period);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const report = await commissions({ from: iso(start), to: iso(end), rate: emp.commissionRate, sellerName: emp.sellerName });
  return report.items[0]?.commission ?? 0;
}

async function ratesNow(): Promise<PayrollRates> {
  return { ...PAYROLL_DEFAULTS, ...((await accounting.getSettings()).payroll ?? {}) };
}

export async function generate(body: { period?: unknown }, actor: Actor) {
  const period = String(body.period ?? "");
  const { start, end } = periodBounds(period);
  if (await Payroll.exists({ period, status: { $ne: "anulado" } })) {
    throw new CustomError(`Ya hay un rol de ${period}: ábrelo o anúlalo para generarlo de nuevo`, 409);
  }
  const employees = await Employee.find({
    hireDate: { $lte: end },
    $or: [{ isActive: true }, { exitDate: { $gte: start } }],
  })
    .sort({ lastName: 1, firstName: 1 })
    .lean<any[]>();
  if (employees.length === 0) throw new CustomError("No hay empleados activos para ese mes", 400);
  const rates = await ratesNow();
  const loans = await loansByEmployee(employees.map((e) => e._id), end);

  const lines: IPayrollLine[] = [];
  for (const emp of employees) {
    const base: LineBase = {
      employeeId: emp._id,
      partyId: emp.partyId,
      name: `${emp.lastName} ${emp.firstName}`,
      identification: emp.identification,
      department: emp.department,
      position: emp.position,
      hireDate: emp.hireDate,
      salary: emp.salary,
      reserveFundMonthly: emp.reserveFundMonthly,
    };
    const edits: LineEdits = { days: daysIn(period, emp.hireDate, emp.exitDate), extras: 0, commissions: await commissionOf(emp, period), otherDeductions: 0 };
    lines.push(computeLine(base, edits, loans.get(String(emp._id)) ?? [], rates, period));
  }
  const doc = await Payroll.create({ period, date: end, rates, lines, totals: payrollTotals(lines), createdBy: actor });
  return doc.toObject();
}

function editsOf(raw: any, current: IPayrollLine): LineEdits {
  const days = raw?.days === undefined ? current.days : Number(raw.days);
  if (!(Number.isInteger(days) && days >= 0 && days <= 30)) throw new CustomError(`Días inválidos para ${current.name} (0 a 30)`, 400);
  const money = (key: keyof LineEdits, label: string) => (raw?.[key] === undefined ? (current[key] as number) : cents(raw[key], `${label} de ${current.name}`));
  return { days, extras: money("extras", "extras"), commissions: money("commissions", "comisiones"), otherDeductions: money("otherDeductions", "otros descuentos") };
}

/** Ajusta el borrador: `lines: [{ employeeId, days, extras, commissions, otherDeductions }]`. Recalcula con los saldos de préstamos actuales. */
export async function update(id: string, body: { lines?: unknown }) {
  const payroll = await Payroll.findById(oid(id, "rol")).lean<any>();
  if (!payroll) throw new CustomError("Rol no encontrado", 404);
  if (payroll.status !== "borrador") throw new CustomError("Solo se edita un rol en borrador", 409);
  const changes = new Map((Array.isArray(body.lines) ? body.lines : []).map((l: any) => [String(l?.employeeId), l]));
  const loans = await loansByEmployee(payroll.lines.map((l: IPayrollLine) => l.employeeId), payroll.date);
  const lines = payroll.lines.map((l: IPayrollLine) =>
    computeLine(l, editsOf(changes.get(String(l.employeeId)), l), loans.get(String(l.employeeId)) ?? [], payroll.rates, payroll.period),
  );
  return Payroll.findByIdAndUpdate(payroll._id, { lines, totals: payrollTotals(lines) }, { new: true }).lean();
}

export async function approve(id: string, actor: Actor) {
  return runInTransaction(async (session) => {
    const payroll = await Payroll.findById(oid(id, "rol")).session(session).lean<any>();
    if (!payroll) throw new CustomError("Rol no encontrado", 404);
    if (payroll.status !== "borrador") throw new CustomError("Ese rol ya no está en borrador", 409);
    const negative = payroll.lines.find((l: IPayrollLine) => l.net < 0);
    if (negative) throw new CustomError(`Los descuentos de ${negative.name} superan sus ingresos (${formatCents(negative.net)})`, 400);

    for (const l of payroll.lines as IPayrollLine[]) {
      for (const d of l.loans.filter((x) => x.tracksBalance)) {
        const res = await EmployeeLoan.updateOne({ _id: d.loanId, balance: { $gte: d.amount } }, { $inc: { balance: -d.amount } }, { session });
        if (res.modifiedCount === 0) throw new CustomError(`El saldo de un préstamo de ${l.name} cambió: guarda el rol para recalcularlo`, 409);
      }
    }
    const settings = await accounting.getSettings(session);
    const entry = await accounting.postEntry(
      {
        date: payroll.date,
        type: "NOMINA",
        description: `Rol de pagos ${payroll.period}`,
        source: { module: "nomina", docType: "ROL_PAGOS", docId: payroll._id, docNumber: payroll.period },
        lines: payrollEntryLines(payroll, settings),
      },
      actor,
      session,
    );
    return Payroll.findByIdAndUpdate(payroll._id, { status: "aprobado", journalEntryId: entry._id, approvedBy: actor }, { new: true, session }).lean();
  });
}

/** Anula un borrador o un rol aprobado (reverso del asiento y devuelve saldos de préstamos). */
export async function voidPayroll(id: string, body: { reason?: string }, actor: Actor) {
  const reason = requireText(body.reason, "el motivo de anulación");
  return runInTransaction(async (session) => {
    const payroll = await Payroll.findById(oid(id, "rol")).session(session).lean<any>();
    if (!payroll) throw new CustomError("Rol no encontrado", 404);
    if (payroll.status === "anulado") throw new CustomError("El rol ya está anulado", 409);
    if (payroll.status === "aprobado") {
      // El reverso va hoy, salvo que el rol sea de un mes que aún no termina (nunca antes que el original).
      const today = parseDay(todayEc());
      const date = today > payroll.date ? today : payroll.date;
      await accounting.reverseBySource(payroll._id, reason, date, actor, session);
      for (const l of payroll.lines as IPayrollLine[]) {
        for (const d of l.loans.filter((x) => x.tracksBalance)) {
          await EmployeeLoan.updateOne({ _id: d.loanId }, { $inc: { balance: d.amount } }, { session });
        }
      }
    }
    return Payroll.findByIdAndUpdate(payroll._id, { status: "anulado", voidReason: reason }, { new: true, session }).lean();
  });
}

export async function list(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  if (query.period) filter.period = String(query.period);
  if (query.status) filter.status = String(query.status);
  const items = await Payroll.find(filter).sort({ period: -1, createdAt: -1 }).limit(60).select("-lines").lean();
  return { items, total: items.length, page: 1, pages: 1 };
}

export async function get(id: string) {
  const payroll = await Payroll.findById(oid(id, "rol")).lean();
  if (!payroll) throw new CustomError("Rol no encontrado", 404);
  return payroll;
}
