import mongoose, { Schema, Types } from "mongoose";

/**
 * Línea de kardex: cada entrada o salida de un producto en una bodega, con
 * el saldo y el costo promedio que quedaron después. El kardex es esta
 * colección ordenada por fecha.
 */
export const MOVEMENT_TYPES = [
  "INVENTARIO_INICIAL",
  "INGRESO_COMPRA",
  "INGRESO_IMPORTACION",
  "INGRESO_AJUSTE",
  "EGRESO_AJUSTE",
  "INGRESO_TRANSFERENCIA",
  "EGRESO_TRANSFERENCIA",
  "EGRESO_VENTA",
  "NOTA_CREDITO_VENTA",
  "NOTA_CREDITO_COMPRA",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const INBOUND_TYPES: MovementType[] = [
  "INVENTARIO_INICIAL",
  "INGRESO_COMPRA",
  "INGRESO_IMPORTACION",
  "INGRESO_AJUSTE",
  "INGRESO_TRANSFERENCIA",
  "NOTA_CREDITO_VENTA",
];

export interface IInventoryMovement {
  productId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  date: Date;
  type: MovementType;
  /** Positiva si entra, negativa si sale. */
  qty: number;
  unitCost: number;
  /** Centavos, con signo. */
  totalCost: number;
  balanceQty: number;
  balanceAvgCost: number;
  balanceValue: number;
  lot: string;
  partyId: Types.ObjectId | null;
  source: { module: string; docType: string; docId: Types.ObjectId | null; docNumber: string };
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const movementSchema = new Schema<IInventoryMovement>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true },
    date: { type: Date, required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    qty: { type: Number, required: true },
    unitCost: { type: Number, required: true },
    totalCost: { type: Number, required: true },
    balanceQty: { type: Number, required: true },
    balanceAvgCost: { type: Number, required: true },
    balanceValue: { type: Number, required: true },
    lot: { type: String, default: "" },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", default: null },
    source: {
      module: { type: String, default: "inventario" },
      docType: { type: String, default: "" },
      docId: { type: Schema.Types.ObjectId, default: null },
      docNumber: { type: String, default: "" },
    },
    createdBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

movementSchema.index({ productId: 1, warehouseId: 1, date: 1, createdAt: 1 });
movementSchema.index({ "source.docId": 1 });

export const InventoryMovement =
  mongoose.models.InventoryMovement ||
  mongoose.model<IInventoryMovement>("InventoryMovement", movementSchema);
