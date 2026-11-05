import type { ISettings, AccountMapKey, Department } from "../models/settings.model";
import type { IPayroll, IPayrollLine } from "../models/payroll.model";
import { accountOf, type EntryLineInput } from "./accounting.service";

/**
 * Asiento del rol aprobado. Gasto por departamento al debe; al haber lo que
 * se debe al IESS, al empleado (neto), las provisiones y lo que se cobra de
 * préstamos y anticipos. Cuadra por construcción:
 * neto = ingresos − aporte personal − préstamos − otros descuentos.
 */

type Concept = "Salaries" | "Overtime" | "Commissions" | "EmployerIess" | "SecapIece" | "ReserveFund" | "Thirteenth" | "Fourteenth" | "Vacation";
const PREFIX: Record<Department, string> = { ventas: "payrollSales", administracion: "payrollAdmin" };
const expenseKey = (dept: Department, concept: Concept) => `${PREFIX[dept]}${concept}` as AccountMapKey;

export function payrollEntryLines(payroll: Pick<IPayroll, "period" | "lines">, settings: ISettings): EntryLineInput[] {
  const acc = (key: AccountMapKey) => accountOf(settings, key);
  const raw: EntryLineInput[] = [];
  const debit = (key: AccountMapKey, amount: number) => raw.push({ accountCode: acc(key), debit: amount });
  const credit = (key: AccountMapKey, amount: number, l?: IPayrollLine) =>
    raw.push({ accountCode: acc(key), credit: amount, partyId: l?.partyId ?? null, description: l ? `Rol ${payroll.period} · ${l.name}` : "" });

  for (const l of payroll.lines) {
    const e = l.employer;
    const exp = (concept: Concept, amount: number) => debit(expenseKey(l.department, concept), amount);
    exp("Salaries", l.salaryEarned);
    exp("Overtime", l.extras);
    exp("Commissions", l.commissions);
    exp("EmployerIess", e.iess);
    exp("SecapIece", e.secapIece);
    exp("ReserveFund", e.reserveFund);
    exp("Thirteenth", e.thirteenth);
    exp("Fourteenth", e.fourteenth);
    exp("Vacation", e.vacation);

    credit("payrollIessPersonal", l.iessPersonal);
    // Patronal, SECAP/IECE y préstamos del IESS se pagan juntos en la planilla del IESS.
    credit("payrollIessPayable", e.iess + e.secapIece + l.loanTotals.quirografario + l.loanTotals.hipotecario);
    credit("payrollThirteenthProvision", e.thirteenth);
    credit("payrollFourteenthProvision", e.fourteenth);
    credit("payrollVacationProvision", e.vacation);
    // Mensualizado: va en el neto del empleado; acumulado: queda por pagar al IESS.
    credit("payrollReserveFundProvision", e.reserveFund - l.reserveFundPaid);
    credit("employeeLoans", l.loanTotals.interno, l);
    credit("payrollOtherDeductions", l.otherDeductions, l);
    credit("payrollNetPayable", l.net, l);
  }

  // Una línea por cuenta (y por empleado donde importa el tercero).
  const grouped = new Map<string, EntryLineInput>();
  for (const line of raw) {
    const k = `${line.accountCode}|${line.debit !== undefined ? "D" : "C"}|${line.partyId ?? ""}`;
    const g = grouped.get(k);
    if (g) {
      g.debit = (g.debit ?? 0) + (line.debit ?? 0);
      g.credit = (g.credit ?? 0) + (line.credit ?? 0);
    } else grouped.set(k, { ...line });
  }
  const lines = [...grouped.values()];
  return [...lines.filter((l) => l.debit), ...lines.filter((l) => !l.debit)];
}
