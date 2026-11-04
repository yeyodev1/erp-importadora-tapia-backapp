import { ClientSession, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { runInTransaction } from "../config/transaction";
import { Warehouse } from "../models/warehouse.model";
import { SalesInvoice, ISaleLine } from "../models/salesInvoice.model";
import { ArMovement } from "../models/arMovement.model";
import { parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import * as inventory from "./inventoryCore.service";
import { nextDocNumber } from "./sequence.service";
import { addAr, hasApplications, reverseAr } from "./arLedger.service";
import * as salesSri from "./salesSri.service";
import {
  addDays, assignCosts, buildLines, customerOf, invoiceFilter, oid, paginate, requireText, salesEntryLines, sriStatusFilter, todayEc,
} from "./salesCommon.service";

/**
 * Factura de venta: número de la serie de la bodega, egreso de stock al costo
 * promedio, asiento VENTA y la cuenta por cobrar, todo en una transacción.
 */
export interface InvoiceBody {
  warehouseId: unknown;
  partyId: unknown;
  date: unknown;
  sellerName?: string;
  priceList?: string;
  creditDays?: unknown;
  paymentMethod?: string;
  notes?: string;
  orderRef?: string;
  lines: unknown;
}

export async function postInvoice(body: InvoiceBody, actor: Actor, session: ClientSession, proformaId: Types.ObjectId | null = null) {
  const warehouse = await Warehouse.findById(oid(body.warehouseId, "bodega")).session(session).lean<any>();
  if (!warehouse || !warehouse.isActive) throw new CustomError("Bodega no encontrada", 404);
  const { party, snapshot } = await customerOf(body.partyId, session);
  const date = parseDay(body.date);
  const priceList = body.priceList || party.customer?.priceList || "GENERAL";
  const { lines, totals, products } = await buildLines(body.lines, priceList, session);
  if (totals.total <= 0) throw new CustomError("La factura debe tener un total mayor que cero", 400);
  const creditDays = Number(body.creditDays ?? party.customer?.creditDays ?? 0);
  if (!Number.isInteger(creditDays) || creditDays < 0) throw new CustomError("Los días de crédito deben ser un entero ≥ 0", 400);

  const { sequential, number } = await nextDocNumber("factura", warehouse.establishment, warehouse.emissionPoint, session);
  const _id = new Types.ObjectId();
  const source = { module: "ventas", docType: "FACTURA", docId: _id, docNumber: number };

  const applied = await inventory.applyMovement(
    { warehouseId: warehouse._id, date, type: "EGRESO_VENTA", partyId: party._id, source, lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })) },
    actor,
    session,
  );
  assignCosts(lines, applied, (l) => products.get(String(l.productId)).controlsStock);

  const entry = await accounting.postEntry(
    { date, type: "VENTA", description: `Factura ${number} ${party.name}`, source, lines: await salesEntryLines(lines, totals, party._id, false, session) },
    actor,
    session,
  );

  const [invoice] = await SalesInvoice.create(
    [{
      _id, number, sequential, establishment: warehouse.establishment, emissionPoint: warehouse.emissionPoint,
      warehouseId: warehouse._id, partyId: party._id, customer: snapshot,
      sellerName: body.sellerName ?? party.customer?.sellerName ?? "", date, creditDays, dueDate: addDays(date, creditDays),
      priceList, paymentMethod: body.paymentMethod || "20", notes: body.notes ?? "", orderRef: body.orderRef ?? "", proformaId,
      lines, ...totals, balance: 0, journalEntryId: entry._id, createdBy: actor,
    }],
    { session },
  );
  await addAr(
    { invoiceId: _id, partyId: party._id, date, kind: "FACTURA", amount: totals.total, description: `Factura ${number}`, source: { docType: "FACTURA", docId: _id, docNumber: number } },
    session,
  );
  return invoice;
}

export async function createInvoice(body: InvoiceBody, actor: Actor) {
  const invoice = await runInTransaction((s) => postInvoice(body, actor, s));
  return salesSri.emit(SalesInvoice, "invoice", invoice._id);
}

/**
 * Anula una factura sin abonos: reverso del asiento, reingreso del stock al
 * mismo costo con que salió y la línea contraria en cartera.
 * shortcut: el reingreso usa el costo unitario de la línea; si la salida se llevó el último centavo del saldo, puede diferir en 1 ¢ del asiento revertido.
 */
export async function voidInvoice(id: string, body: { reason?: string; date?: string }, actor: Actor) {
  const reason = requireText(body.reason, "el motivo de anulación");
  const date = parseDay(body.date ?? todayEc());
  return runInTransaction(async (session) => {
    const invoice = await SalesInvoice.findById(oid(id, "factura")).session(session);
    if (!invoice) throw new CustomError("Factura no encontrada", 404);
    if (invoice.status === "anulado") throw new CustomError("La factura ya está anulada", 409);
    if (date < invoice.date) throw new CustomError("La anulación no puede ser anterior a la factura", 400);
    if (await hasApplications(invoice._id, session)) {
      throw new CustomError("La factura tiene abonos, notas o retenciones: anúlalos primero", 409);
    }
    const source = { module: "ventas", docType: "ANULACION_FACTURA", docId: invoice._id, docNumber: invoice.number };
    await accounting.reverseBySource(invoice._id, reason, date, actor, session);
    await inventory.applyMovement(
      {
        warehouseId: invoice.warehouseId, date, type: "NOTA_CREDITO_VENTA", partyId: invoice.partyId, source,
        lines: invoice.lines.map((l: ISaleLine) => ({ productId: l.productId, qty: l.qty, unitCost: l.unitCost })),
      },
      actor,
      session,
    );
    await reverseAr(invoice._id, date, `Anulación factura ${invoice.number}`, session);
    // updateOne: reverseAr ya movió `balance` en la base; el documento en memoria lo tiene viejo.
    await SalesInvoice.updateOne({ _id: invoice._id }, { status: "anulado", voidReason: reason }, { session });
    return SalesInvoice.findById(invoice._id).session(session).select("-xml").lean<any>();
  });
}

export async function listInvoices(query: Record<string, unknown>) {
  const filter = invoiceFilter({ includeVoided: "true", ...query });
  if (query.status) filter.status = String(query.status);
  if (query.pending === "true") filter.balance = { $gt: 0 };
  Object.assign(filter, sriStatusFilter(query));
  return paginate(SalesInvoice, filter, query, ["number", "customer.name", "customer.identification", "orderRef"]);
}

export async function getInvoice(id: string) {
  const invoice = await SalesInvoice.findById(oid(id, "factura")).select("-xml").lean<any>();
  if (!invoice) throw new CustomError("Factura no encontrada", 404);
  const movements = await ArMovement.find({ invoiceId: invoice._id }).sort({ date: 1, createdAt: 1 }).lean();
  return { ...invoice, movements };
}

export const retrySri = (id: string) => salesSri.retry(SalesInvoice, "invoice", id);
