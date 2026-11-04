import mongoose, { Schema, Types } from "mongoose";
import { createdByShape } from "./salesInvoice.model";

/**
 * Cobro a un cliente, aplicado a una o varias de sus facturas. El cheque
 * posfechado vive aquí: en_cartera → depositado (depósito en tránsito) →
 * acreditado (banco); o devuelto, que reabre el saldo de las facturas.
 */
export const RECEIPT_METHODS = ["DEPOSITO", "TRANSFERENCIA", "EFECTIVO", "CHEQUE_POSFECHADO"] as const;
export type ReceiptMethod = (typeof RECEIPT_METHODS)[number];
export const CHECK_STATUSES = ["en_cartera", "depositado", "acreditado", "devuelto"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface ICustomerReceipt {
  number: string;
  date: Date;
  partyId: Types.ObjectId;
  method: ReceiptMethod;
  /** Banco (depósito/transferencia) o caja (efectivo). En el cheque, el banco donde se depositó. */
  bankAccountId: Types.ObjectId | null;
  reference: string;
  amount: number;
  applications: { invoiceId: Types.ObjectId; invoiceNumber: string; amount: number }[];
  check: {
    number: string;
    bank: string;
    dueDate: Date | null;
    status: CheckStatus | "";
    depositedAt: Date | null;
    creditedAt: Date | null;
    returnedAt: Date | null;
    returnReason: string;
  };
  notes: string;
  status: "vigente" | "anulado";
  voidReason: string;
  journalEntryId: Types.ObjectId | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const customerReceiptSchema = new Schema<ICustomerReceipt>(
  {
    number: { type: String, required: true, unique: true },
    date: { type: Date, required: true, index: true },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },
    method: { type: String, enum: RECEIPT_METHODS, required: true },
    bankAccountId: { type: Schema.Types.ObjectId, ref: "BankAccount", default: null },
    reference: { type: String, default: "" },
    amount: { type: Number, required: true },
    applications: {
      type: [{ invoiceId: { type: Schema.Types.ObjectId, ref: "SalesInvoice" }, invoiceNumber: String, amount: Number, _id: false }],
      required: true,
    },
    check: {
      number: { type: String, default: "" },
      bank: { type: String, default: "" },
      dueDate: { type: Date, default: null },
      status: { type: String, enum: [...CHECK_STATUSES, ""], default: "" },
      depositedAt: { type: Date, default: null },
      creditedAt: { type: Date, default: null },
      returnedAt: { type: Date, default: null },
      returnReason: { type: String, default: "" },
    },
    notes: { type: String, default: "" },
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
    voidReason: { type: String, default: "" },
    journalEntryId: { type: Schema.Types.ObjectId, default: null },
    createdBy: createdByShape,
  },
  { timestamps: true },
);

export const CustomerReceipt =
  mongoose.models.CustomerReceipt || mongoose.model<ICustomerReceipt>("CustomerReceipt", customerReceiptSchema);
