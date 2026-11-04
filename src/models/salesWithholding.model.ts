import mongoose, { Schema, Types } from "mongoose";
import { createdByShape } from "./salesInvoice.model";

/** Retención que el cliente nos hizo sobre una factura (renta y/o IVA). Baja el saldo de esa factura. */
export interface ISalesWithholding {
  invoiceId: Types.ObjectId;
  invoiceNumber: string;
  partyId: Types.ObjectId;
  sellerName: string;
  date: Date;
  voucherNumber: string;
  authorization: string;
  lines: { tax: "renta" | "iva"; rate: number; base: number; amount: number }[];
  total: number;
  status: "vigente" | "anulado";
  journalEntryId: Types.ObjectId | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const salesWithholdingSchema = new Schema<ISalesWithholding>(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: "SalesInvoice", required: true, index: true },
    invoiceNumber: String,
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    sellerName: { type: String, default: "" },
    date: { type: Date, required: true, index: true },
    voucherNumber: { type: String, required: true },
    authorization: { type: String, default: "" },
    lines: {
      type: [{ tax: { type: String, enum: ["renta", "iva"] }, rate: Number, base: Number, amount: Number, _id: false }],
      required: true,
    },
    total: { type: Number, required: true },
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
    journalEntryId: { type: Schema.Types.ObjectId, default: null },
    createdBy: createdByShape,
  },
  { timestamps: true },
);

export const SalesWithholding =
  mongoose.models.SalesWithholding || mongoose.model<ISalesWithholding>("SalesWithholding", salesWithholdingSchema);
