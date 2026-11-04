import mongoose, { Schema, Types } from "mongoose";

/**
 * Libro auxiliar de cartera: cada cosa que sube o baja el saldo de una
 * factura, con su fecha. La cartera por edades a una fecha de corte suma
 * estas líneas; una anulación no borra nada, agrega la línea contraria en
 * su fecha (así el corte coincide con el mayor de Clientes).
 */
export const AR_KINDS = ["FACTURA", "NOTA_DEBITO", "NOTA_CREDITO", "COBRO", "RETENCION", "CHEQUE_DEVUELTO"] as const;
export type ArKind = (typeof AR_KINDS)[number];

export interface IArMovement {
  invoiceId: Types.ObjectId;
  partyId: Types.ObjectId;
  date: Date;
  kind: ArKind;
  /** Centavos con signo: + sube el saldo (factura, ND), − lo baja (cobro, NC, retención). */
  amount: number;
  description: string;
  source: { docType: string; docId: Types.ObjectId; docNumber: string };
  /** true si ya tiene su línea contraria (anulación). */
  reversed: boolean;
  reversalOf: Types.ObjectId | null;
}

const arMovementSchema = new Schema<IArMovement>(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: "SalesInvoice", required: true },
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    date: { type: Date, required: true },
    kind: { type: String, enum: AR_KINDS, required: true },
    amount: { type: Number, required: true },
    description: { type: String, default: "" },
    source: {
      docType: String,
      docId: { type: Schema.Types.ObjectId, required: true },
      docNumber: String,
    },
    reversed: { type: Boolean, default: false },
    reversalOf: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

arMovementSchema.index({ invoiceId: 1, date: 1 });
arMovementSchema.index({ "source.docId": 1 });
arMovementSchema.index({ partyId: 1, date: 1 });

export const ArMovement = mongoose.models.ArMovement || mongoose.model<IArMovement>("ArMovement", arMovementSchema);
