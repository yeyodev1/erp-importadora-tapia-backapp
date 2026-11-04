import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { runInTransaction } from "../config/transaction";
import { ProductGroup } from "../models/productGroup.model";
import { SalesInvoice } from "../models/salesInvoice.model";
import { SalesDebitNote } from "../models/salesDebitNote.model";
import { cents, percentOf } from "../utils/money";
import { parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import { nextDocNumber } from "./sequence.service";
import { addAr } from "./arLedger.service";
import * as salesSri from "./salesSri.service";
import { oid, paginate, requireText, sriStatusFilter } from "./salesCommon.service";

/**
 * Nota de débito: cobra un valor adicional sobre una factura (interés,
 * flete). El ingreso va a la cuenta de ventas del grupo indicado (por
 * defecto, el de la primera línea de la factura) y sube su saldo.
 */
export async function createDebitNote(
  body: { invoiceId: unknown; date: unknown; reason?: string; amount: unknown; vatRate?: unknown; groupId?: unknown },
  actor: Actor,
) {
  const reason = requireText(body.reason, "el motivo de la nota de débito");
  const date = parseDay(body.date);
  const base = cents(body.amount, "valor");
  if (base <= 0) throw new CustomError("El valor de la nota de débito debe ser mayor que cero", 400);
  const vatRate = Number(body.vatRate ?? 15);
  if (![0, 5, 15].includes(vatRate)) throw new CustomError("IVA inválido: 0, 5 o 15", 400);
  const vat = percentOf(base, vatRate);
  const totals = { subtotal0: vatRate === 0 ? base : 0, subtotalVat: vatRate > 0 ? base : 0, discount: 0, vat, total: base + vat };

  const note = await runInTransaction(async (session) => {
    const invoice = await SalesInvoice.findById(oid(body.invoiceId, "factura")).session(session).lean<any>();
    if (!invoice) throw new CustomError("Factura no encontrada", 404);
    if (invoice.status !== "vigente") throw new CustomError("La factura está anulada", 409);
    if (date < invoice.date) throw new CustomError("La nota de débito no puede ser anterior a la factura", 400);
    const group = await ProductGroup.findById(body.groupId ? oid(body.groupId, "grupo") : invoice.lines[0].groupId).session(session).lean<any>();
    if (!group) throw new CustomError("Grupo de producto no encontrado", 404);

    const { sequential, number } = await nextDocNumber("nota_debito", invoice.establishment, invoice.emissionPoint, session);
    const _id = new Types.ObjectId();
    const source = { module: "ventas", docType: "NOTA_DEBITO", docId: _id, docNumber: number };
    const entry = await accounting.postEntry(
      {
        date, type: "ND_VENTA", description: `ND ${number} a factura ${invoice.number}: ${reason}`, source,
        lines: [
          { accountCode: await accounting.mappedAccount("customers", session), debit: totals.total, partyId: invoice.partyId },
          { accountCode: group.accounts.sales, credit: base },
          { accountCode: await accounting.mappedAccount("vatSales", session), credit: vat },
        ],
      },
      actor,
      session,
    );
    const [doc] = await SalesDebitNote.create(
      [{
        _id, number, sequential, establishment: invoice.establishment, emissionPoint: invoice.emissionPoint,
        invoiceId: invoice._id, invoiceNumber: invoice.number, partyId: invoice.partyId, date, reason, vatRate,
        incomeAccount: group.accounts.sales, ...totals, journalEntryId: entry._id, createdBy: actor,
      }],
      { session },
    );
    await addAr(
      { invoiceId: invoice._id, partyId: invoice.partyId, date, kind: "NOTA_DEBITO", amount: totals.total, description: `ND ${number}`, source: { docType: "NOTA_DEBITO", docId: _id, docNumber: number } },
      session,
    );
    return doc;
  });
  return salesSri.emit(SalesDebitNote, "debitNote", note._id);
}

export function listDebitNotes(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  if (query.invoiceId) filter.invoiceId = oid(query.invoiceId, "factura");
  if (query.partyId) filter.partyId = oid(query.partyId, "cliente");
  Object.assign(filter, sriStatusFilter(query));
  return paginate(SalesDebitNote, filter, query, ["number", "invoiceNumber", "reason"]);
}

export const retrySri = (id: string) => salesSri.retry(SalesDebitNote, "debitNote", id);
