import mongoose, { Schema, Types } from "mongoose";
import { sriShape, totalsShape, createdByShape, ISriFields, ITotals } from "./salesInvoice.model";

/** Nota de débito: valor adicional (con IVA) que se suma al saldo de una factura. */
export interface ISalesDebitNote extends ISriFields, ITotals {
  number: string;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  invoiceId: Types.ObjectId;
  invoiceNumber: string;
  partyId: Types.ObjectId;
  date: Date;
  reason: string;
  vatRate: number;
  /** Cuenta de ingreso (la de ventas del grupo indicado). */
  incomeAccount: string;
  status: "vigente" | "anulado";
  journalEntryId: Types.ObjectId | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const debitNoteSchema = new Schema<ISalesDebitNote>(
  {
    number: { type: String, required: true, unique: true },
    establishment: String,
    emissionPoint: String,
    sequential: String,
    invoiceId: { type: Schema.Types.ObjectId, ref: "SalesInvoice", required: true, index: true },
    invoiceNumber: String,
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    date: { type: Date, required: true },
    reason: { type: String, required: true },
    vatRate: { type: Number, default: 15 },
    incomeAccount: String,
    ...totalsShape,
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
    journalEntryId: { type: Schema.Types.ObjectId, default: null },
    ...sriShape,
    createdBy: createdByShape,
  },
  { timestamps: true },
);

export const SalesDebitNote =
  mongoose.models.SalesDebitNote || mongoose.model<ISalesDebitNote>("SalesDebitNote", debitNoteSchema);
