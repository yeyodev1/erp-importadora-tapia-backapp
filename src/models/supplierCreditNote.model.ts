import mongoose, { Schema, Types } from "mongoose";

/**
 * Nota de crédito del proveedor, casi siempre por faltantes (pidieron 100 lb
 * y llegaron 97). Se aplica a una factura y baja su saldo por pagar. Si trae
 * productos, saca ese stock con NOTA_CREDITO_COMPRA.
 */
export interface ISupplierCreditNote {
  supplierId: Types.ObjectId;
  invoiceId: Types.ObjectId;
  docNumber: string;
  date: Date;
  authorization: string;
  accessKey: string;
  reason: string;
  /** Cuenta que se acredita (gasto o inventario) por cada base. */
  lines: { accountCode: string; base0: number; baseVat: number; description: string }[];
  productLines: { productId: Types.ObjectId; qty: number; subtotal: number }[];
  warehouseId: Types.ObjectId | null;
  base0: number;
  baseVat: number;
  vat: number;
  total: number;
  journalEntryId: Types.ObjectId | null;
  status: "vigente" | "anulado";
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const supplierCreditNoteSchema = new Schema<ISupplierCreditNote>(
  {
    supplierId: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "PurchaseInvoice", required: true, index: true },
    docNumber: { type: String, required: true },
    date: { type: Date, required: true },
    authorization: { type: String, default: "" },
    accessKey: { type: String, default: "" },
    reason: { type: String, default: "" },
    lines: [
      {
        _id: false,
        accountCode: { type: String, required: true },
        base0: { type: Number, default: 0 },
        baseVat: { type: Number, default: 0 },
        description: { type: String, default: "" },
      },
    ],
    productLines: [
      {
        _id: false,
        productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
        qty: { type: Number, required: true },
        subtotal: { type: Number, required: true },
      },
    ],
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
    base0: { type: Number, default: 0 },
    baseVat: { type: Number, default: 0 },
    vat: { type: Number, default: 0 },
    total: { type: Number, required: true },
    journalEntryId: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    status: { type: String, enum: ["vigente", "anulado"], default: "vigente" },
    createdBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

export const SupplierCreditNote =
  mongoose.models.SupplierCreditNote ||
  mongoose.model<ISupplierCreditNote>("SupplierCreditNote", supplierCreditNoteSchema);
