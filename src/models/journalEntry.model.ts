import mongoose, { Schema, Types } from "mongoose";

/**
 * Asiento contable. Es la única fuente de saldos: no existe "mayorizar",
 * los reportes suman estas líneas. Un asiento nunca se edita: se anula con
 * un asiento de reverso (status "anulado" + reversedBy).
 */
export const ENTRY_TYPES = [
  "DIARIO",
  "VENTA",
  "NC_VENTA",
  "ND_VENTA",
  "RETENCION_VENTA",
  "COBRO",
  "CHEQUE_POSFECHADO",
  "COMPRA",
  "NC_COMPRA",
  "PAGO",
  "ANTICIPO",
  "BANCO",
  "INVENTARIO",
  "CIERRE",
  "NOMINA",
  "REVERSO",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export interface IEntryLine {
  accountCode: string;
  accountName: string;
  /** Centavos. Una línea tiene debe o haber, nunca ambos. */
  debit: number;
  credit: number;
  costCenter: string;
  partyId: Types.ObjectId | null;
  description: string;
}

export interface IJournalEntry {
  number: string;
  date: Date;
  /** "2026-09": para bloqueo de meses y reportes mensuales. */
  period: string;
  type: EntryType;
  description: string;
  source: { module: string; docType: string; docId: Types.ObjectId | null; docNumber: string };
  lines: IEntryLine[];
  totalDebit: number;
  totalCredit: number;
  status: "contabilizado" | "anulado";
  reversalOf: Types.ObjectId | null;
  reversedBy: Types.ObjectId | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
  createdAt?: Date;
}

const lineSchema = new Schema<IEntryLine>(
  {
    accountCode: { type: String, required: true },
    accountName: { type: String, required: true },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    costCenter: { type: String, default: "" },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", default: null },
    description: { type: String, default: "" },
  },
  { _id: false },
);

const entrySchema = new Schema<IJournalEntry>(
  {
    number: { type: String, required: true, unique: true },
    date: { type: Date, required: true, index: true },
    period: { type: String, required: true, index: true },
    type: { type: String, enum: ENTRY_TYPES, required: true },
    description: { type: String, default: "" },
    source: {
      module: { type: String, default: "contabilidad" },
      docType: { type: String, default: "" },
      docId: { type: Schema.Types.ObjectId, default: null },
      docNumber: { type: String, default: "" },
    },
    lines: { type: [lineSchema], required: true },
    totalDebit: { type: Number, required: true },
    totalCredit: { type: Number, required: true },
    status: { type: String, enum: ["contabilizado", "anulado"], default: "contabilizado" },
    reversalOf: { type: Schema.Types.ObjectId, default: null },
    reversedBy: { type: Schema.Types.ObjectId, default: null },
    createdBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

entrySchema.index({ "lines.accountCode": 1, date: 1 });
entrySchema.index({ "source.docId": 1 });

export const JournalEntry =
  mongoose.models.JournalEntry || mongoose.model<IJournalEntry>("JournalEntry", entrySchema);
