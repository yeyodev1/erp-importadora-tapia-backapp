import mongoose, { Schema, Types } from "mongoose";
import { saleLineSchema, sriShape, totalsShape, createdByShape, ISaleLine, ISriFields, ITotals } from "./salesInvoice.model";

/**
 * Nota de crédito de venta aplicada a una factura. Con `returnsStock` la
 * mercadería reingresa al costo con que salió en la factura; sin él es solo
 * valor (descuento posterior) y no toca stock ni costo.
 */
export interface ISalesCreditNote extends ISriFields, ITotals {
  number: string;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  invoiceId: Types.ObjectId;
  invoiceNumber: string;
  warehouseId: Types.ObjectId;
  partyId: Types.ObjectId;
  date: Date;
  reason: string;
  returnsStock: boolean;
  lines: ISaleLine[];
  status: "vigente" | "anulado";
  journalEntryId: Types.ObjectId | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const creditNoteSchema = new Schema<ISalesCreditNote>(
  {
    number: { type: String, required: true, unique: true },
    establishment: String,
    emissionPoint: String,
    sequential: String,
    invoiceId: { type: Schema.Types.ObjectId, ref: "SalesInvoice", required: true, index: true },
    invoiceNumber: String,
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    date: { type: Date, required: true },
    reason: { type: String, required: true },
    returnsStock: { type: Boolean, default: true },
    lines: { type: [saleLineSchema], required: true },
    ...totalsShape,
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
    journalEntryId: { type: Schema.Types.ObjectId, default: null },
    ...sriShape,
    createdBy: createdByShape,
  },
  { timestamps: true },
);

export const SalesCreditNote =
  mongoose.models.SalesCreditNote || mongoose.model<ISalesCreditNote>("SalesCreditNote", creditNoteSchema);
