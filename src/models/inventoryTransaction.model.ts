import mongoose, { Schema, Types } from "mongoose";

/**
 * Transacción manual de inventario (pantalla "Transacciones" del sistema de
 * Macio). El egreso por venta y las notas de crédito no nacen aquí: los
 * genera Facturación. Una transferencia es un solo documento: sale de la
 * bodega de origen y entra a la de destino al mismo costo.
 */
export const TRANSACTION_TYPES = [
  "INVENTARIO_INICIAL",
  "INGRESO_COMPRA",
  "INGRESO_IMPORTACION",
  "INGRESO_AJUSTE",
  "EGRESO_AJUSTE",
  "TRANSFERENCIA",
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export interface ITransactionLine {
  productId: Types.ObjectId;
  /** En unidad de control (libras). */
  qty: number;
  /** Dólares por unidad, 6 decimales: el que se aplicó. */
  unitCost: number;
  /** Centavos. */
  totalCost: number;
  lot: string;
}

export interface IInventoryTransaction {
  number: string;
  type: TransactionType;
  warehouseId: Types.ObjectId;
  /** Solo en transferencias. */
  targetWarehouseId: Types.ObjectId | null;
  date: Date;
  /** Proveedor (compra, importación). */
  partyId: Types.ObjectId | null;
  /** Persona que responde (transferencias, ajustes). */
  responsible: string;
  costCenter: string;
  /** Solo en importación. */
  containers: number;
  lines: ITransactionLine[];
  /** Centavos. */
  totalCost: number;
  description: string;
  imageUrl: string;
  status: "contabilizado" | "anulado";
  journalEntryId: Types.ObjectId | null;
  voidReason: string;
  voidedAt: Date | null;
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const lineSchema = new Schema<ITransactionLine>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    lot: { type: String, default: "" },
  },
  { _id: false },
);

const transactionSchema = new Schema<IInventoryTransaction>(
  {
    number: { type: String, required: true },
    type: { type: String, enum: TRANSACTION_TYPES, required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true },
    targetWarehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
    date: { type: Date, required: true },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", default: null },
    responsible: { type: String, default: "" },
    costCenter: { type: String, default: "" },
    containers: { type: Number, default: 0 },
    lines: { type: [lineSchema], default: [] },
    totalCost: { type: Number, default: 0 },
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    status: { type: String, enum: ["contabilizado", "anulado"], default: "contabilizado" },
    journalEntryId: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    voidReason: { type: String, default: "" },
    voidedAt: { type: Date, default: null },
    createdBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

transactionSchema.index({ type: 1, warehouseId: 1, number: 1 }, { unique: true });
transactionSchema.index({ date: -1 });

export const InventoryTransaction =
  mongoose.models.InventoryTransaction ||
  mongoose.model<IInventoryTransaction>("InventoryTransaction", transactionSchema);
