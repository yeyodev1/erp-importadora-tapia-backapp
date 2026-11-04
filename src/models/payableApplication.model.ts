import mongoose, { Schema, Types } from "mongoose";

/**
 * Cada abono a una factura de proveedor: pago ejecutado, nota de crédito o
 * cruce de anticipo. Con la fecha de cada fila sale el saldo a cualquier
 * fecha de corte; al anular el documento origen, sus filas pasan a "anulado".
 */
export interface IPayableApplication {
  invoiceId: Types.ObjectId;
  supplierId: Types.ObjectId;
  date: Date;
  kind: "pago" | "nc" | "anticipo";
  amount: number;
  sourceId: Types.ObjectId;
  status: "vigente" | "anulado";
}

const payableApplicationSchema = new Schema<IPayableApplication>(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: "PurchaseInvoice", required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    date: { type: Date, required: true },
    kind: { type: String, enum: ["pago", "nc", "anticipo"], required: true },
    amount: { type: Number, required: true, min: 1 },
    sourceId: { type: Schema.Types.ObjectId, required: true, index: true },
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
  },
  { timestamps: true },
);

export const PayableApplication =
  mongoose.models.PayableApplication ||
  mongoose.model<IPayableApplication>("PayableApplication", payableApplicationSchema);
