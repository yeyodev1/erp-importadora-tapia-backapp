import mongoose, { Schema, Types } from "mongoose";

/**
 * Producto. El stock se controla en `unit` (libras) y se compra en
 * `purchaseUnit` (saco de 100 lb, bulto de 55 lb): factor = cuántas `unit`
 * trae una `purchaseUnit`. La toma física muestra ambas.
 */
export interface IProduct {
  code: string;
  barcode: string;
  name: string;
  kind: "bien" | "servicio";
  groupId: Types.ObjectId;
  subgroup: string;
  supplierId: Types.ObjectId | null;
  location: string;
  unit: string;
  purchaseUnit: { name: string; factor: number };
  minQty: number;
  controlsStock: boolean;
  controlsLot: boolean;
  /** 15 o 0 (%). */
  vatRate: number;
  /** Precios en centavos por `unit`. */
  prices: { list: string; price: number }[];
  imageUrl: string;
  isActive: boolean;
  /** Notas internas (ej. "factor pendiente" de la migración). */
  notes: string;
  /** Importación que lo creó (Migración de datos): "Quitar datos importados" lo borra. */
  importBatchId: Types.ObjectId | null;
}

const productSchema = new Schema<IProduct>(
  {
    code: { type: String, required: true, unique: true, trim: true },
    barcode: { type: String, default: "" },
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ["bien", "servicio"], default: "bien" },
    groupId: { type: Schema.Types.ObjectId, ref: "ProductGroup", required: true },
    subgroup: { type: String, default: "" },
    supplierId: { type: Schema.Types.ObjectId, ref: "Party", default: null },
    location: { type: String, default: "" },
    unit: { type: String, default: "LIBRAS" },
    purchaseUnit: {
      name: { type: String, default: "SACOS" },
      factor: { type: Number, default: 1, min: 0.0001 },
    },
    minQty: { type: Number, default: 0 },
    controlsStock: { type: Boolean, default: true },
    controlsLot: { type: Boolean, default: false },
    vatRate: { type: Number, enum: [0, 5, 15], default: 0 },
    prices: { type: [{ list: String, price: Number, _id: false }], default: [] },
    imageUrl: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: "" },
    importBatchId: { type: Schema.Types.ObjectId, default: null, index: true },
  },
  { timestamps: true },
);

productSchema.index({ name: "text", code: "text" });

export const Product = mongoose.models.Product || mongoose.model<IProduct>("Product", productSchema);
