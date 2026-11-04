import mongoose, { Schema, Types } from "mongoose";

/**
 * Movimientos de dinero de Cuentas por pagar:
 * - pago: ejecuta aprobaciones (Proveedores / Banco).
 * - anticipo: cheque o transferencia sin factura, a proveedor o a empleado
 *   (Anticipo a proveedores / Banco). `applied` = lo cruzado + devuelto.
 * - cruce: aplica un anticipo a facturas de uno o varios proveedores.
 * - devolucion: el sobrante del anticipo que se deposita en el banco.
 */
export const PAYABLE_TX_KINDS = ["pago", "anticipo", "cruce", "devolucion"] as const;
export type PayableTxKind = (typeof PAYABLE_TX_KINDS)[number];

export interface IPayableTransaction {
  kind: PayableTxKind;
  number: string;
  date: Date;
  partyId: Types.ObjectId;
  bankAccountId: Types.ObjectId | null;
  method: "CHEQUE" | "TRANSFERENCIA" | "DEPOSITO" | "";
  checkNumber: string;
  amount: number;
  lines: { invoiceId: Types.ObjectId; supplierId: Types.ObjectId; amount: number }[];
  approvalIds: Types.ObjectId[];
  advanceId: Types.ObjectId | null;
  applied: number;
  description: string;
  journalEntryId: Types.ObjectId | null;
  status: "vigente" | "anulado";
  voidReason: string;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const payableTransactionSchema = new Schema<IPayableTransaction>(
  {
    kind: { type: String, enum: PAYABLE_TX_KINDS, required: true, index: true },
    number: { type: String, required: true },
    date: { type: Date, required: true, index: true },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },
    bankAccountId: { type: Schema.Types.ObjectId, ref: "BankAccount", default: null },
    method: { type: String, enum: ["CHEQUE", "TRANSFERENCIA", "DEPOSITO", ""], default: "" },
    checkNumber: { type: String, default: "" },
    amount: { type: Number, required: true, min: 1 },
    lines: [
      {
        _id: false,
        invoiceId: { type: Schema.Types.ObjectId, ref: "PurchaseInvoice", required: true },
        supplierId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
        amount: { type: Number, required: true },
      },
    ],
    approvalIds: { type: [Schema.Types.ObjectId], default: [] },
    advanceId: { type: Schema.Types.ObjectId, default: null, index: true },
    applied: { type: Number, default: 0 },
    description: { type: String, default: "" },
    journalEntryId: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
    voidReason: { type: String, default: "" },
    createdBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

export const PayableTransaction =
  mongoose.models.PayableTransaction ||
  mongoose.model<IPayableTransaction>("PayableTransaction", payableTransactionSchema);
