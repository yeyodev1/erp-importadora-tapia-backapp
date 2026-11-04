import mongoose, { Schema, Types } from "mongoose";

/**
 * Saldo vivo de un producto en una bodega, con su costo promedio ponderado.
 * Se actualiza solo desde inventoryCore.service, dentro de la transacción
 * del documento que mueve el stock.
 */
export interface IStockBalance {
  productId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  qty: number;
  /** Dólares por unidad, 6 decimales. */
  avgCost: number;
  /** Centavos. */
  totalValue: number;
}

const stockBalanceSchema = new Schema<IStockBalance>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true },
    qty: { type: Number, default: 0 },
    avgCost: { type: Number, default: 0 },
    totalValue: { type: Number, default: 0 },
  },
  { timestamps: true },
);

stockBalanceSchema.index({ productId: 1, warehouseId: 1 }, { unique: true });

export const StockBalance =
  mongoose.models.StockBalance ||
  mongoose.model<IStockBalance>("StockBalance", stockBalanceSchema);
