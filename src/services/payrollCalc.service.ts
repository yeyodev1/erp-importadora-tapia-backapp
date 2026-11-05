import { CustomError } from "../errors/customError.error";
import type { PayrollRates } from "../models/settings.model";
import type { LoanType } from "../models/employeeLoan.model";
import type { ILoanDeduction, IPayrollLine } from "../models/payroll.model";
import { percentOf, roundCents, sum } from "../utils/money";

/**
 * Cálculo puro de una línea del rol (sin base de datos). Centavos enteros.
 * Mes comercial de 30 días: el sueldo y el décimo cuarto son proporcionales
 * a los días trabajados.
 */

export interface LoanInput {
  loanId: ILoanDeduction["loanId"];
  type: LoanType;
  installment: number;
  balance: number | null;
}

export type LineBase = Pick<
  IPayrollLine,
  "employeeId" | "partyId" | "name" | "identification" | "department" | "position" | "hireDate" | "salary" | "reserveFundMonthly"
>;

export interface LineEdits {
  days: number;
  extras: number;
  commissions: number;
  otherDeductions: number;
}

/** "2026-11" → primer y último día del mes (12:00 UTC, como parseDay). */
export function periodBounds(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new CustomError("Período inválido (AAAA-MM)", 400);
  const [y, m] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1, 12)), end: new Date(Date.UTC(y, m, 0, 12)) };
}

/** Días del mes comercial (1–30) que caen entre `from` y `to` dentro del período. */
export function daysIn(period: string, from: Date | null, to: Date | null): number {
  const { start, end } = periodBounds(period);
  const first = from && from > start ? from.getUTCDate() : 1;
  const last = to && to < end ? to.getUTCDate() : 30;
  return Math.max(0, Math.min(30, last) - Math.min(30, first) + 1);
}

/**
 * Días del mes con derecho a fondo de reserva: desde que cumple un año.
 * Mes del aniversario = proporcional; antes, 0; después, 30.
 */
export function reserveFundDays(hireDate: Date, period: string): number {
  const anniversary = new Date(hireDate);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  const { end } = periodBounds(period);
  if (anniversary > end) return 0;
  return daysIn(period, anniversary, null);
}

/** Cuota del mes: la del préstamo, sin pasar del saldo pendiente (si lo lleva). */
export function loanDeduction(loan: LoanInput): ILoanDeduction {
  const tracksBalance = loan.balance !== null && loan.balance !== undefined;
  const amount = tracksBalance ? Math.min(loan.installment, Math.max(0, loan.balance!)) : loan.installment;
  return { loanId: loan.loanId, type: loan.type, amount, tracksBalance };
}

export function computeLine(base: LineBase, edits: LineEdits, loans: LoanInput[], rates: PayrollRates, period: string): IPayrollLine {
  const { days, extras, commissions, otherDeductions } = edits;
  const salaryEarned = roundCents((base.salary * days) / 30);
  const iessBase = salaryEarned + extras + commissions;
  const iessPersonal = percentOf(iessBase, rates.iessPersonalRate);

  const deductions = loans.map(loanDeduction).filter((l) => l.amount > 0);
  const loanTotals = { interno: 0, quirografario: 0, hipotecario: 0 };
  for (const l of deductions) loanTotals[l.type] += l.amount;

  const rfDays = reserveFundDays(base.hireDate, period);
  const reserveFund = percentOf(roundCents((iessBase * rfDays) / 30), rates.reserveFundRate);
  const reserveFundPaid = base.reserveFundMonthly ? reserveFund : 0;

  const totalIncome = iessBase + reserveFundPaid;
  const totalDeductions = iessPersonal + sum(deductions.map((l) => l.amount)) + otherDeductions;
  return {
    ...base,
    days,
    salaryEarned,
    extras,
    commissions,
    iessBase,
    iessPersonal,
    loans: deductions,
    loanTotals,
    otherDeductions,
    reserveFundPaid,
    totalIncome,
    totalDeductions,
    net: totalIncome - totalDeductions,
    employer: {
      iess: percentOf(iessBase, rates.iessEmployerRate),
      secapIece: percentOf(iessBase, rates.secapRate + rates.ieceRate),
      thirteenth: roundCents(iessBase / 12),
      fourteenth: roundCents((rates.sbu * days) / 30 / 12),
      vacation: roundCents(iessBase / 24),
      reserveFund,
    },
  };
}

/** Costo de la empresa de una línea: lo que gana el empleado + aportes y provisiones. */
export function employerCost(l: IPayrollLine): number {
  const e = l.employer;
  return l.iessBase + e.iess + e.secapIece + e.thirteenth + e.fourteenth + e.vacation + e.reserveFund;
}

export function payrollTotals(lines: IPayrollLine[]) {
  return {
    totalIncome: sum(lines.map((l) => l.totalIncome)),
    totalDeductions: sum(lines.map((l) => l.totalDeductions)),
    net: sum(lines.map((l) => l.net)),
    employerCost: sum(lines.map(employerCost)),
  };
}
