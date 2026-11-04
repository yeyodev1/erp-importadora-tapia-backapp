import mongoose, { Schema } from "mongoose";

/**
 * Cuenta del plan de cuentas. Formato de Tapia: 9.9.99.99.99.999
 * (ej. 1.1.01.02.01.004 Banco Pichincha). Solo las cuentas de movimiento
 * reciben asientos; las de mayor agrupan.
 */
export const ACCOUNT_KINDS = ["mayor", "movimiento"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Primer dígito del código → naturaleza. 1/5 son deudoras; 2/3/4 acreedoras. */
export const NATURE_BY_GROUP: Record<string, "deudora" | "acreedora"> = {
  "1": "deudora",
  "2": "acreedora",
  "3": "acreedora",
  "4": "acreedora",
  "5": "deudora",
};

export const ACCOUNT_CODE = /^\d(\.\d{1,3})*$/;

export interface IAccount {
  code: string;
  name: string;
  parentCode: string | null;
  level: number;
  kind: AccountKind;
  requiresCostCenter: boolean;
  isExpense: boolean;
  isActive: boolean;
}

const accountSchema = new Schema<IAccount>(
  {
    code: { type: String, required: true, unique: true, trim: true, match: ACCOUNT_CODE },
    name: { type: String, required: true, trim: true },
    parentCode: { type: String, default: null, index: true },
    level: { type: Number, required: true },
    kind: { type: String, enum: ACCOUNT_KINDS, default: "movimiento" },
    requiresCostCenter: { type: Boolean, default: false },
    isExpense: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Account = mongoose.models.Account || mongoose.model<IAccount>("Account", accountSchema);
