import mongoose, { Schema } from "mongoose";

/**
 * Bodega = establecimiento SRI. Guayaquil y Quito facturan cada una con su
 * serie (establecimiento-punto de emisión), su stock y su costo promedio.
 */
export interface IWarehouse {
  code: string;
  name: string;
  /** "001" — establecimiento del SRI. */
  establishment: string;
  /** "001" — punto de emisión del SRI. */
  emissionPoint: string;
  address: string;
  isActive: boolean;
}

const warehouseSchema = new Schema<IWarehouse>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    establishment: { type: String, required: true, match: /^\d{3}$/ },
    emissionPoint: { type: String, required: true, match: /^\d{3}$/ },
    address: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Warehouse =
  mongoose.models.Warehouse || mongoose.model<IWarehouse>("Warehouse", warehouseSchema);
