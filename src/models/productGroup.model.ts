import mongoose, { Schema } from "mongoose";

/**
 * Grupo de producto (Especias, Frutos secos, Granos y semillas). Cada grupo
 * trae sus cuentas: así el estado de resultados sale por grupo, como hoy.
 */
export interface IProductGroup {
  name: string;
  subgroups: string[];
  accounts: { inventory: string; sales: string; cost: string };
  isActive: boolean;
}

const productGroupSchema = new Schema<IProductGroup>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    subgroups: { type: [String], default: [] },
    accounts: {
      inventory: { type: String, required: true },
      sales: { type: String, required: true },
      cost: { type: String, required: true },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const ProductGroup =
  mongoose.models.ProductGroup || mongoose.model<IProductGroup>("ProductGroup", productGroupSchema);
