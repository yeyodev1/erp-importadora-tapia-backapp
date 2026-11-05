import mongoose, { Schema, Types } from "mongoose";

/**
 * Préstamo descontado en el rol. "interno": la empresa prestó `total` y se
 * descuenta `installment` hasta dejar `balance` en cero. Quirografario e
 * hipotecario son del IESS: la planilla dice la cuota; el saldo es opcional
 * (null = se descuenta la cuota cada mes mientras esté activo).
 */
export const LOAN_TYPES = ["interno", "quirografario", "hipotecario"] as const;
export type LoanType = (typeof LOAN_TYPES)[number];

export interface IEmployeeLoan {
  employeeId: Types.ObjectId;
  type: LoanType;
  /** Desde este día se descuenta (meses que terminan antes no). */
  date: Date;
  description: string;
  /** Centavos. */
  total: number;
  installment: number;
  balance: number | null;
  isActive: boolean;
}

const loanSchema = new Schema<IEmployeeLoan>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    type: { type: String, enum: LOAN_TYPES, required: true },
    date: { type: Date, required: true },
    description: { type: String, default: "" },
    total: { type: Number, default: 0, min: 0 },
    installment: { type: Number, required: true, min: 0 },
    balance: { type: Number, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const EmployeeLoan = mongoose.models.EmployeeLoan || mongoose.model<IEmployeeLoan>("EmployeeLoan", loanSchema);
