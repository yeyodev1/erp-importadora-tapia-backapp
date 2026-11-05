import mongoose, { Schema, Types } from "mongoose";
import { DEPARTMENTS, Department, PayrollRates } from "./settings.model";
import { LOAN_TYPES, LoanType } from "./employeeLoan.model";

/**
 * Rol de pagos mensual: una línea por empleado. Todos los montos en centavos.
 * borrador (se edita) → aprobado (asiento NOMINA, rebaja préstamos) → anulado
 * (asiento de reverso, devuelve los saldos de préstamos).
 */
export const PAYROLL_STATUSES = ["borrador", "aprobado", "anulado"] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export interface ILoanDeduction {
  loanId: Types.ObjectId;
  type: LoanType;
  amount: number;
  /** El préstamo lleva saldo: al aprobar se rebaja y al anular se devuelve. */
  tracksBalance: boolean;
}

export interface IPayrollLine {
  employeeId: Types.ObjectId;
  partyId: Types.ObjectId;
  name: string;
  identification: string;
  department: Department;
  position: string;
  hireDate: Date;
  salary: number;
  reserveFundMonthly: boolean;
  days: number;
  salaryEarned: number;
  extras: number;
  commissions: number;
  /** Materia gravada del IESS: sueldo del mes + extras + comisiones. */
  iessBase: number;
  iessPersonal: number;
  loans: ILoanDeduction[];
  loanTotals: Record<LoanType, number>;
  otherDeductions: number;
  /** Fondo de reserva pagado en el rol (solo si es mensualizado). */
  reserveFundPaid: number;
  totalIncome: number;
  totalDeductions: number;
  net: number;
  employer: { iess: number; secapIece: number; thirteenth: number; fourteenth: number; vacation: number; reserveFund: number };
}

export interface IPayroll {
  period: string;
  /** Último día del mes: fecha del asiento. */
  date: Date;
  status: PayrollStatus;
  rates: PayrollRates;
  lines: IPayrollLine[];
  totals: { totalIncome: number; totalDeductions: number; net: number; employerCost: number };
  journalEntryId: Types.ObjectId | null;
  voidReason: string;
  createdBy: { userId: Types.ObjectId | null; name: string };
  approvedBy: { userId: Types.ObjectId | null; name: string };
}

const money = { type: Number, default: 0 };
const actorShape = { userId: { type: Schema.Types.ObjectId, default: null }, name: String };

const lineSchema = new Schema<IPayrollLine>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    name: String,
    identification: String,
    department: { type: String, enum: DEPARTMENTS },
    position: String,
    hireDate: Date,
    salary: money,
    reserveFundMonthly: Boolean,
    days: { type: Number, default: 30 },
    salaryEarned: money,
    extras: money,
    commissions: money,
    iessBase: money,
    iessPersonal: money,
    loans: [
      {
        _id: false,
        loanId: { type: Schema.Types.ObjectId, ref: "EmployeeLoan" },
        type: { type: String, enum: LOAN_TYPES },
        amount: Number,
        tracksBalance: Boolean,
      },
    ],
    loanTotals: { interno: money, quirografario: money, hipotecario: money },
    otherDeductions: money,
    reserveFundPaid: money,
    totalIncome: money,
    totalDeductions: money,
    net: money,
    employer: { iess: money, secapIece: money, thirteenth: money, fourteenth: money, vacation: money, reserveFund: money },
  },
  { _id: false },
);

const payrollSchema = new Schema<IPayroll>(
  {
    period: { type: String, required: true, index: true },
    date: { type: Date, required: true },
    status: { type: String, enum: PAYROLL_STATUSES, default: "borrador" },
    rates: { type: Schema.Types.Mixed, required: true },
    lines: [lineSchema],
    totals: { totalIncome: money, totalDeductions: money, net: money, employerCost: money },
    journalEntryId: { type: Schema.Types.ObjectId, default: null },
    voidReason: { type: String, default: "" },
    createdBy: actorShape,
    approvedBy: actorShape,
  },
  { timestamps: true },
);

export const Payroll = mongoose.models.Payroll || mongoose.model<IPayroll>("Payroll", payrollSchema);
