import mongoose, { Schema } from "mongoose";

/** Contador atómico por clave ("asiento-2026", "factura-001-001"). */
export interface ISequence {
  _id: string;
  value: number;
}

const sequenceSchema = new Schema<ISequence>({
  _id: { type: String, required: true },
  value: { type: Number, default: 0 },
});

export const Sequence =
  mongoose.models.Sequence || mongoose.model<ISequence>("Sequence", sequenceSchema);
