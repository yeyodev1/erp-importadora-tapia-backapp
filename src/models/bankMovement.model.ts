import mongoose, { Schema, Types } from "mongoose";

/**
 * Movimiento en una cuenta bancaria o caja: lo que la conciliación cruza
 * contra el estado de cuenta. Lo escriben Cobros (depósitos), Pagos
 * (cheques/transferencias) y Caja Bancos, siempre vía bankCore.service.
 */
export const BANK_MOVEMENT_TYPES = [
  "DEPOSITO",
  "CHEQUE",
  "TRANSFERENCIA",
  "NOTA_DEBITO",
  "NOTA_CREDITO",
  "INGRESO_CAJA",
  "EGRESO_CAJA",
] as const;
export type BankMovementType = (typeof BANK_MOVEMENT_TYPES)[number];

export interface IBankMovement {
  bankAccountId: Types.ObjectId;
  date: Date;
  type: BankMovementType;
  /** "in" suma al saldo del banco, "out" resta. */
  direction: "in" | "out";
  /** Centavos, siempre positivo. */
  amount: number;
  checkNumber: string;
  partyId: Types.ObjectId | null;
  beneficiary: string;
  description: string;
  source: { module: string; docType: string; docId: Types.ObjectId | null; docNumber: string };
  journalEntryId: Types.ObjectId | null;
  status: "vigente" | "anulado";
  reconciliationId: Types.ObjectId | null;
  reconciledAt: Date | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const bankMovementSchema = new Schema<IBankMovement>(
  {
    bankAccountId: { type: Schema.Types.ObjectId, ref: "BankAccount", required: true },
    date: { type: Date, required: true },
    type: { type: String, enum: BANK_MOVEMENT_TYPES, required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    amount: { type: Number, required: true, min: 1 },
    checkNumber: { type: String, default: "" },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", default: null },
    beneficiary: { type: String, default: "" },
    description: { type: String, default: "" },
    source: {
      module: { type: String, default: "bancos" },
      docType: { type: String, default: "" },
      docId: { type: Schema.Types.ObjectId, default: null },
      docNumber: { type: String, default: "" },
    },
    journalEntryId: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
    reconciliationId: { type: Schema.Types.ObjectId, default: null },
    reconciledAt: { type: Date, default: null },
    createdBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

bankMovementSchema.index({ bankAccountId: 1, date: 1 });
bankMovementSchema.index({ "source.docId": 1 });

export const BankMovement =
  mongoose.models.BankMovement || mongoose.model<IBankMovement>("BankMovement", bankMovementSchema);
