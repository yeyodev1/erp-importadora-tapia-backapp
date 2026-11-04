import mongoose, { Schema } from "mongoose";

/**
 * Cuenta bancaria o caja de la empresa (Banco de Guayaquil, Austro,
 * Internacional, Pichincha, cajas chicas). Une el banco con su cuenta contable.
 */
export interface IBankAccount {
  kind: "banco" | "caja";
  name: string;
  bank: string;
  number: string;
  type: "corriente" | "ahorros" | "";
  accountCode: string;
  /** Próximo número de cheque. */
  nextCheck: number;
  isActive: boolean;
}

const bankAccountSchema = new Schema<IBankAccount>(
  {
    kind: { type: String, enum: ["banco", "caja"], default: "banco" },
    name: { type: String, required: true, trim: true },
    bank: { type: String, default: "" },
    number: { type: String, default: "" },
    type: { type: String, enum: ["corriente", "ahorros", ""], default: "corriente" },
    accountCode: { type: String, required: true },
    nextCheck: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const BankAccount =
  mongoose.models.BankAccount || mongoose.model<IBankAccount>("BankAccount", bankAccountSchema);
