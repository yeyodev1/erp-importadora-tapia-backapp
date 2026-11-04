import mongoose, { Schema, Types } from "mongoose";

/**
 * Factura de venta. Montos en centavos. Se graba junto con su egreso de
 * stock, su asiento VENTA y su movimiento de cartera (ArMovement); `balance`
 * es el saldo vivo de la cuenta por cobrar y solo lo mueve arLedger.service.
 */
export interface ISaleLine {
  productId: Types.ObjectId;
  code: string;
  name: string;
  groupId: Types.ObjectId;
  qty: number;
  /** Centavos por unidad. */
  unitPrice: number;
  discount: number;
  vatRate: number;
  /** qty × unitPrice − discount. */
  subtotal: number;
  vat: number;
  /** Costo promedio con que salió (dólares por unidad) y su total en centavos. */
  unitCost: number;
  costTotal: number;
}

export interface ICustomerSnapshot {
  identification: string;
  idType: string;
  name: string;
  address: string;
  email: string;
  customerType: string;
  parish: string;
}

export interface ISriFields {
  accessKey: string;
  /** SriStatus o "" mientras no se emite. */
  sriStatus: string;
  authorizationNumber: string;
  authorizationDate: Date | null;
  sriMessages: string[];
  xml: string;
}

export interface ITotals {
  subtotal0: number;
  subtotalVat: number;
  discount: number;
  vat: number;
  total: number;
}

export interface ISalesInvoice extends ISriFields, ITotals {
  number: string;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  warehouseId: Types.ObjectId;
  partyId: Types.ObjectId;
  customer: ICustomerSnapshot;
  sellerName: string;
  date: Date;
  creditDays: number;
  dueDate: Date;
  priceList: string;
  paymentMethod: string;
  notes: string;
  orderRef: string;
  proformaId: Types.ObjectId | null;
  lines: ISaleLine[];
  balance: number;
  status: "vigente" | "anulado";
  voidReason: string;
  journalEntryId: Types.ObjectId | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
  createdAt?: Date;
}

export const saleLineSchema = new Schema<ISaleLine>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    code: String,
    name: String,
    groupId: { type: Schema.Types.ObjectId, ref: "ProductGroup" },
    qty: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    vatRate: { type: Number, default: 0 },
    subtotal: { type: Number, required: true },
    vat: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0 },
    costTotal: { type: Number, default: 0 },
  },
  { _id: false },
);

export const customerSnapshotShape = {
  identification: String,
  idType: String,
  name: String,
  address: String,
  email: String,
  customerType: String,
  parish: String,
};

export const sriShape = {
  accessKey: { type: String, default: "" },
  sriStatus: { type: String, default: "" },
  authorizationNumber: { type: String, default: "" },
  authorizationDate: { type: Date, default: null },
  sriMessages: { type: [String], default: [] },
  xml: { type: String, default: "" },
};

export const totalsShape = {
  subtotal0: { type: Number, default: 0 },
  subtotalVat: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  vat: { type: Number, default: 0 },
  total: { type: Number, required: true },
};

export const createdByShape = {
  userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  name: { type: String, default: "" },
};

const salesInvoiceSchema = new Schema<ISalesInvoice>(
  {
    number: { type: String, required: true, unique: true },
    establishment: String,
    emissionPoint: String,
    sequential: String,
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },
    customer: customerSnapshotShape,
    sellerName: { type: String, default: "" },
    date: { type: Date, required: true, index: true },
    creditDays: { type: Number, default: 0 },
    dueDate: { type: Date, required: true },
    priceList: { type: String, default: "GENERAL" },
    paymentMethod: { type: String, default: "20" },
    notes: { type: String, default: "" },
    orderRef: { type: String, default: "" },
    proformaId: { type: Schema.Types.ObjectId, default: null },
    lines: { type: [saleLineSchema], required: true },
    ...totalsShape,
    balance: { type: Number, required: true },
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
    voidReason: { type: String, default: "" },
    journalEntryId: { type: Schema.Types.ObjectId, default: null },
    ...sriShape,
    createdBy: createdByShape,
  },
  { timestamps: true },
);

export const SalesInvoice =
  mongoose.models.SalesInvoice || mongoose.model<ISalesInvoice>("SalesInvoice", salesInvoiceSchema);
