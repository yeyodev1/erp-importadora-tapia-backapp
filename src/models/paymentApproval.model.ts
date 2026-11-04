import mongoose, { Schema, Types } from "mongoose";

/**
 * "Aprueba pagos CXP": autoriza pagar todo o parte (200 de 1.000) de una o
 * varias facturas, de uno o varios proveedores. No mueve contabilidad: el
 * asiento sale cuando Caja Bancos ejecuta el pago (status "pagada").
 */
export interface IPaymentApproval {
  number: number;
  date: Date;
  /** A nombre de quién sale el cheque/transferencia. */
  beneficiaryId: Types.ObjectId;
  lines: { invoiceId: Types.ObjectId; supplierId: Types.ObjectId; amount: number }[];
  total: number;
  note: string;
  status: "pendiente" | "pagada" | "anulada";
  paymentId: Types.ObjectId | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const paymentApprovalSchema = new Schema<IPaymentApproval>(
  {
    number: { type: Number, required: true, unique: true },
    date: { type: Date, required: true },
    beneficiaryId: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },
    lines: [
      {
        _id: false,
        invoiceId: { type: Schema.Types.ObjectId, ref: "PurchaseInvoice", required: true },
        supplierId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
        amount: { type: Number, required: true, min: 1 },
      },
    ],
    total: { type: Number, required: true },
    note: { type: String, default: "" },
    status: { type: String, enum: ["pendiente", "pagada", "anulada"], default: "pendiente", index: true },
    paymentId: { type: Schema.Types.ObjectId, default: null },
    createdBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

export const PaymentApproval =
  mongoose.models.PaymentApproval || mongoose.model<IPaymentApproval>("PaymentApproval", paymentApprovalSchema);
