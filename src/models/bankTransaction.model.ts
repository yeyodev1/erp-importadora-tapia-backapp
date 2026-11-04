import mongoose, { Schema, Types } from "mongoose";

/**
 * Transacción bancaria manual de Caja Bancos (depósito, nota de débito o
 * crédito, cheque suelto, transferencia entre cuentas propias, ingreso o
 * egreso de caja chica). Las contrapartidas las elige el usuario; la línea
 * de Bancos/Caja sale sola. No se edita: se anula y se rehace.
 */
export const BANK_TRANSACTION_TYPES = [
  "DEPOSITO",
  "NOTA_DEBITO",
  "NOTA_CREDITO",
  "CHEQUE",
  "TRANSFERENCIA",
  "INGRESO_CAJA",
  "EGRESO_CAJA",
] as const;
export type BankTransactionType = (typeof BANK_TRANSACTION_TYPES)[number];

export interface IBankTransactionLine {
  accountCode: string;
  /** Centavos, positivo. */
  amount: number;
  costCenter: string;
  description: string;
}

export interface IBankTransaction {
  number: string;
  type: BankTransactionType;
  date: Date;
  bankAccountId: Types.ObjectId;
  /** Solo transferencias: cuenta propia que recibe. */
  targetBankAccountId: Types.ObjectId | null;
  checkNumber: string;
  partyId: Types.ObjectId | null;
  beneficiary: string;
  description: string;
  amount: number;
  lines: IBankTransactionLine[];
  journalEntryId: Types.ObjectId | null;
  status: "vigente" | "anulado";
  voidReason: string;
  voidedAt: Date | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const lineSchema = new Schema<IBankTransactionLine>(
  {
    accountCode: { type: String, required: true },
    amount: { type: Number, required: true, min: 1 },
    costCenter: { type: String, default: "" },
    description: { type: String, default: "" },
  },
  { _id: false },
);

const bankTransactionSchema = new Schema<IBankTransaction>(
  {
    number: { type: String, required: true, unique: true },
    type: { type: String, enum: BANK_TRANSACTION_TYPES, required: true },
    date: { type: Date, required: true, index: true },
    bankAccountId: { type: Schema.Types.ObjectId, ref: "BankAccount", required: true },
    targetBankAccountId: { type: Schema.Types.ObjectId, ref: "BankAccount", default: null },
    checkNumber: { type: String, default: "" },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", default: null },
    beneficiary: { type: String, default: "" },
    description: { type: String, default: "" },
    amount: { type: Number, required: true, min: 1 },
    lines: { type: [lineSchema], default: [] },
    journalEntryId: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
    voidReason: { type: String, default: "" },
    voidedAt: { type: Date, default: null },
    createdBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

bankTransactionSchema.index({ bankAccountId: 1, date: -1 });

export const BankTransaction =
  mongoose.models.BankTransaction ||
  mongoose.model<IBankTransaction>("BankTransaction", bankTransactionSchema);
