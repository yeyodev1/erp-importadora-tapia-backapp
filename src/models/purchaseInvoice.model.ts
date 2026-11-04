import mongoose, { Schema, Types } from "mongoose";

/**
 * Factura de proveedor ("Transacciones proveedores"): electrónica importada
 * por XML o física ingresada a mano. `payable` es el neto a pagar (total −
 * retenciones); `balance` baja con pagos ejecutados, notas de crédito y cruces
 * de anticipo (cada uno deja su fila en PayableApplication). `approved` es lo
 * aprobado para pago que aún no sale del banco.
 */
export const PURCHASE_DOC_TYPES: Record<string, string> = {
  "01": "Factura",
  "02": "Nota de venta",
  "03": "Liquidación de compra",
};

export interface IWithholdingLine {
  codeId: Types.ObjectId;
  tax: "renta" | "iva";
  code: string;
  description: string;
  base: number;
  rate: number;
  amount: number;
  accountCode: string;
}

export interface IPurchaseInvoice {
  supplierId: Types.ObjectId;
  supplierRuc: string;
  supplierName: string;
  docType: string;
  /** "001-002-000012345" */
  docNumber: string;
  date: Date;
  dueDate: Date;
  expiryDate: Date | null;
  authorization: string;
  /** Clave de acceso de 49 dígitos de la factura del proveedor (si es electrónica). */
  accessKey: string;
  creditDays: number;
  /** Código de sustento tributario SRI (01 crédito tributario IVA…). */
  taxSupport: string;
  goodsOrServices: "bien" | "servicio";
  /** Forma de pago SRI (20 = otros con utilización del sistema financiero). */
  paymentMethod: string;
  description: string;
  expenseLines: { accountCode: string; base0: number; baseVat: number; description: string; costCenter: string }[];
  productLines: { productId: Types.ObjectId; qty: number; subtotal: number; vatRate: number; accountCode: string; description: string }[];
  warehouseId: Types.ObjectId | null;
  vatRate: number;
  base0: number;
  baseVat: number;
  vat: number;
  total: number;
  withholdings: IWithholdingLine[];
  withholdingTotal: number;
  payable: number;
  balance: number;
  approved: number;
  /** Comprobante de retención que emitimos (07). */
  withholding: {
    number: string;
    accessKey: string;
    sriStatus: string;
    authorizationNumber: string;
    messages: string[];
    xml: string;
  } | null;
  journalEntryId: Types.ObjectId | null;
  status: "vigente" | "anulado";
  voidReason: string;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const withholdingLineSchema = new Schema<IWithholdingLine>(
  {
    codeId: { type: Schema.Types.ObjectId, ref: "WithholdingCode", required: true },
    tax: { type: String, enum: ["renta", "iva"], required: true },
    code: { type: String, required: true },
    description: { type: String, default: "" },
    base: { type: Number, required: true },
    rate: { type: Number, required: true },
    amount: { type: Number, required: true },
    accountCode: { type: String, required: true },
  },
  { _id: false },
);

const voucherSchema = new Schema(
  {
    number: { type: String, required: true },
    accessKey: { type: String, default: "" },
    sriStatus: { type: String, default: "" },
    authorizationNumber: { type: String, default: "" },
    messages: { type: [String], default: [] },
    xml: { type: String, default: "" },
  },
  { _id: false },
);

const purchaseInvoiceSchema = new Schema<IPurchaseInvoice>(
  {
    supplierId: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },
    supplierRuc: { type: String, required: true },
    supplierName: { type: String, default: "" },
    docType: { type: String, enum: Object.keys(PURCHASE_DOC_TYPES), default: "01" },
    docNumber: { type: String, required: true },
    date: { type: Date, required: true, index: true },
    dueDate: { type: Date, required: true },
    expiryDate: { type: Date, default: null },
    authorization: { type: String, default: "" },
    accessKey: { type: String, default: "", index: true },
    creditDays: { type: Number, default: 0 },
    taxSupport: { type: String, default: "01" },
    goodsOrServices: { type: String, enum: ["bien", "servicio"], default: "bien" },
    paymentMethod: { type: String, default: "20" },
    description: { type: String, default: "" },
    expenseLines: [
      {
        _id: false,
        accountCode: { type: String, required: true },
        base0: { type: Number, default: 0 },
        baseVat: { type: Number, default: 0 },
        description: { type: String, default: "" },
        costCenter: { type: String, default: "" },
      },
    ],
    productLines: [
      {
        _id: false,
        productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
        qty: { type: Number, required: true },
        subtotal: { type: Number, required: true },
        vatRate: { type: Number, default: 0 },
        accountCode: { type: String, required: true },
        description: { type: String, default: "" },
      },
    ],
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
    vatRate: { type: Number, default: 15 },
    base0: { type: Number, default: 0 },
    baseVat: { type: Number, default: 0 },
    vat: { type: Number, default: 0 },
    total: { type: Number, required: true },
    withholdings: { type: [withholdingLineSchema], default: [] },
    withholdingTotal: { type: Number, default: 0 },
    payable: { type: Number, required: true },
    balance: { type: Number, required: true },
    approved: { type: Number, default: 0 },
    withholding: { type: voucherSchema, default: null },
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

purchaseInvoiceSchema.index({ supplierRuc: 1, docType: 1, docNumber: 1 });

export const PurchaseInvoice =
  mongoose.models.PurchaseInvoice || mongoose.model<IPurchaseInvoice>("PurchaseInvoice", purchaseInvoiceSchema);
