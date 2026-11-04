import mongoose, { Schema, Types } from "mongoose";
import { saleLineSchema, customerSnapshotShape, totalsShape, createdByShape, ISaleLine, ITotals, ICustomerSnapshot } from "./salesInvoice.model";

/** Proforma: cotización sin asiento ni stock. Al facturarla queda enlazada a su factura. */
export interface ISalesProforma extends ITotals {
  number: string;
  warehouseId: Types.ObjectId;
  partyId: Types.ObjectId;
  customer: ICustomerSnapshot;
  sellerName: string;
  date: Date;
  creditDays: number;
  priceList: string;
  paymentMethod: string;
  notes: string;
  orderRef: string;
  lines: ISaleLine[];
  status: "abierta" | "facturada";
  invoiceId: Types.ObjectId | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const proformaSchema = new Schema<ISalesProforma>(
  {
    number: { type: String, required: true, unique: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    customer: customerSnapshotShape,
    sellerName: { type: String, default: "" },
    date: { type: Date, required: true },
    creditDays: { type: Number, default: 0 },
    priceList: { type: String, default: "GENERAL" },
    paymentMethod: { type: String, default: "20" },
    notes: { type: String, default: "" },
    orderRef: { type: String, default: "" },
    lines: { type: [saleLineSchema], required: true },
    ...totalsShape,
    status: { type: String, enum: ["abierta", "facturada"], default: "abierta" },
    invoiceId: { type: Schema.Types.ObjectId, default: null },
    createdBy: createdByShape,
  },
  { timestamps: true },
);

export const SalesProforma =
  mongoose.models.SalesProforma || mongoose.model<ISalesProforma>("SalesProforma", proformaSchema);
