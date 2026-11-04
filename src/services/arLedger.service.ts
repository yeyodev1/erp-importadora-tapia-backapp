import { ClientSession, Types } from "mongoose";
import { ArMovement, ArKind } from "../models/arMovement.model";
import { SalesInvoice } from "../models/salesInvoice.model";

/**
 * Única puerta al saldo de cartera: cada cambio graba su línea fechada en
 * ArMovement y mueve `balance` de la factura en la misma transacción, así el
 * saldo vivo y el saldo a una fecha de corte nunca se separan.
 */
export interface ArInput {
  invoiceId: Types.ObjectId;
  partyId: Types.ObjectId;
  date: Date;
  kind: ArKind;
  /** + sube el saldo, − lo baja. */
  amount: number;
  description: string;
  source: { docType: string; docId: Types.ObjectId; docNumber: string };
}

export async function addAr(input: ArInput, session: ClientSession) {
  if (input.amount === 0) return;
  await ArMovement.create([input], { session });
  await SalesInvoice.updateOne({ _id: input.invoiceId }, { $inc: { balance: input.amount } }, { session });
}

/** Deshace en `date` lo que un documento hizo en cartera (anulación o cheque devuelto). */
export async function reverseAr(docId: Types.ObjectId, date: Date, description: string, session: ClientSession, kind?: ArKind) {
  const movements = await ArMovement.find({ "source.docId": docId, reversed: false, reversalOf: null }).session(session);
  for (const m of movements) {
    await ArMovement.create(
      [{
        invoiceId: m.invoiceId, partyId: m.partyId, date, kind: kind ?? m.kind, amount: -m.amount, description,
        source: m.source, reversed: true, reversalOf: m._id,
      }],
      { session },
    );
    m.reversed = true;
    await m.save({ session });
    await SalesInvoice.updateOne({ _id: m.invoiceId }, { $inc: { balance: -m.amount } }, { session });
  }
}

/** ¿La factura tiene abonos, NC, ND o retenciones vivos? (bloquea anularla). */
export async function hasApplications(invoiceId: Types.ObjectId, session: ClientSession): Promise<boolean> {
  const n = await ArMovement.countDocuments({ invoiceId, kind: { $ne: "FACTURA" }, reversed: false, reversalOf: null }).session(session);
  return n > 0;
}
