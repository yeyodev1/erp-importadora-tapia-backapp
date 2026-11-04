import mongoose, { Schema, Types } from "mongoose";

/**
 * Conciliación de una cuenta bancaria en un rango de fechas. Guarda qué
 * movimientos se cargaron y cuáles cobró el banco; al cerrar marca esos
 * movimientos (reconciledAt) y congela el resumen para el archivo de auditoría.
 * Los no cobrados quedan sin marca y se cargan en la conciliación siguiente.
 */
export interface IBankReconciliation {
  bankAccountId: Types.ObjectId;
  description: string;
  from: Date;
  to: Date;
  /** Saldo final según el estado de cuenta del banco (centavos, lo escribe el usuario). */
  statementBalance: number;
  status: "abierta" | "cerrada";
  movementIds: Types.ObjectId[];
  clearedIds: Types.ObjectId[];
  /** Resumen al momento de cerrar: el reporte de una cerrada no cambia. */
  closedSummary: Record<string, unknown> | null;
  forceReason: string;
  closedAt: Date | null;
  closedBy: { userId: Types.ObjectId | null; name: string };
  reopenLog: { at: Date; reason: string; name: string }[];
  createdBy: { userId: Types.ObjectId | null; name: string };
}

const actorShape = {
  userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  name: { type: String, default: "" },
};

const reconciliationSchema = new Schema<IBankReconciliation>(
  {
    bankAccountId: { type: Schema.Types.ObjectId, ref: "BankAccount", required: true },
    description: { type: String, default: "" },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    statementBalance: { type: Number, default: 0 },
    status: { type: String, enum: ["abierta", "cerrada"], default: "abierta" },
    movementIds: { type: [Schema.Types.ObjectId], default: [] },
    clearedIds: { type: [Schema.Types.ObjectId], default: [] },
    closedSummary: { type: Schema.Types.Mixed, default: null },
    forceReason: { type: String, default: "" },
    closedAt: { type: Date, default: null },
    closedBy: actorShape,
    reopenLog: { type: [{ at: Date, reason: String, name: String, _id: false }], default: [] },
    createdBy: actorShape,
  },
  { timestamps: true },
);

reconciliationSchema.index({ bankAccountId: 1, to: -1 });

export const BankReconciliation =
  mongoose.models.BankReconciliation ||
  mongoose.model<IBankReconciliation>("BankReconciliation", reconciliationSchema);
