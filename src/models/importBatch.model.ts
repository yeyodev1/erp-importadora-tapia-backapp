import mongoose, { Schema, Types } from "mongoose";

/**
 * Una importación de la Migración de datos (Macio o app de Proveedores).
 * Todo lo que crea lleva su `importBatchId`; "Quitar datos importados" usa
 * este registro para deshacerla. `restores` guarda lo que se completó en
 * fichas que ya existían, para devolverlas a como estaban.
 */
export interface IRestore {
  model: "Party" | "Product";
  id: Types.ObjectId;
  /** Valores antes de la importación (rutas con punto: "customer.sellerName"). */
  previous: Record<string, unknown>;
  /** Lo que puso la importación: solo se restaura si nadie lo cambió después. */
  applied: Record<string, unknown>;
}

export interface IImportBatch {
  number: string;
  source: "macio" | "proveedores";
  status: "aplicado" | "quitado";
  counts: Record<string, number>;
  /** Centavos. */
  totals: Record<string, number>;
  warnings: string[];
  cutoff: Date;
  journalEntryId: Types.ObjectId | null;
  restores: IRestore[];
  createdBy: { userId: Types.ObjectId | null; name: string };
  createdAt?: Date;
  undoneAt: Date | null;
  undoneBy: { userId: Types.ObjectId | null; name: string };
  undoReason: string;
}

const by = {
  userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  name: { type: String, default: "" },
};

const importBatchSchema = new Schema<IImportBatch>(
  {
    number: { type: String, required: true, unique: true },
    source: { type: String, enum: ["macio", "proveedores"], required: true },
    status: { type: String, enum: ["aplicado", "quitado"], default: "aplicado" },
    counts: { type: Schema.Types.Mixed, default: {} },
    totals: { type: Schema.Types.Mixed, default: {} },
    warnings: { type: [String], default: [] },
    cutoff: { type: Date, required: true },
    journalEntryId: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    restores: {
      type: [{ _id: false, model: String, id: Schema.Types.ObjectId, previous: Schema.Types.Mixed, applied: Schema.Types.Mixed }],
      default: [],
    },
    createdBy: by,
    undoneAt: { type: Date, default: null },
    undoneBy: by,
    undoReason: { type: String, default: "" },
  },
  { timestamps: true, minimize: false },
);

export const ImportBatch =
  mongoose.models.ImportBatch || mongoose.model<IImportBatch>("ImportBatch", importBatchSchema);
