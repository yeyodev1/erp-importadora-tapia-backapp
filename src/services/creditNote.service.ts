import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { runInTransaction } from "../config/transaction";
import { Product } from "../models/product.model";
import { SalesInvoice, ISaleLine } from "../models/salesInvoice.model";
import { SalesCreditNote } from "../models/salesCreditNote.model";
import { cents, formatCents, roundQty, roundUnitCost, sum } from "../utils/money";
import { parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import * as inventory from "./inventoryCore.service";
import { nextDocNumber } from "./sequence.service";
import { addAr } from "./arLedger.service";
import * as salesSri from "./salesSri.service";
import {
  assignCosts, computeTotals, oid, paginate, parseQty, priceLine, requireText, salesEntryLines, sriStatusFilter,
} from "./salesCommon.service";

/**
 * Nota de crédito de venta sobre UNA factura. Devolución (`returnsStock`):
 * la mercadería vuelve al costo con que salió y se revierte el costo de
 * venta. Solo valor: baja venta e IVA, sin tocar stock. Nunca supera el
 * saldo de la factura y lo baja en cartera.
 */
export interface CreditNoteBody {
  invoiceId: unknown;
  date: unknown;
  reason?: string;
  returnsStock?: boolean;
  lines: { productId: unknown; qty: unknown; unitPrice?: unknown; discount?: unknown }[];
}

export async function createCreditNote(body: CreditNoteBody, actor: Actor) {
  const reason = requireText(body.reason, "el motivo de la nota de crédito");
  const date = parseDay(body.date);
  const returnsStock = body.returnsStock !== false;
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw new CustomError("La nota de crédito necesita al menos una línea", 400);

  const note = await runInTransaction(async (session) => {
    const invoice = await SalesInvoice.findById(oid(body.invoiceId, "factura")).session(session).lean<any>();
    if (!invoice) throw new CustomError("Factura no encontrada", 404);
    if (invoice.status !== "vigente") throw new CustomError("La factura está anulada", 409);
    if (date < invoice.date) throw new CustomError("La nota de crédito no puede ser anterior a la factura", 400);

    // Lo ya devuelto por producto en notas vigentes, para no devolver más de lo vendido.
    const previous = returnsStock
      ? await SalesCreditNote.find({ invoiceId: invoice._id, status: "vigente", returnsStock: true }).session(session).lean<any[]>()
      : [];
    const returned = new Map<string, number>();
    for (const l of previous.flatMap((n) => n.lines)) returned.set(String(l.productId), (returned.get(String(l.productId)) ?? 0) + l.qty);

    const lines: ISaleLine[] = body.lines.map((raw) => {
      const productId = String(oid(raw.productId, "producto"));
      const sold = invoice.lines.filter((l: ISaleLine) => String(l.productId) === productId);
      if (!sold.length) throw new CustomError("Ese producto no está en la factura", 400);
      const qty = parseQty(raw.qty);
      const soldQty = roundQty(sum(sold.map((l: ISaleLine) => l.qty)));
      if (returnsStock) {
        const left = roundQty(soldQty - (returned.get(productId) ?? 0));
        if (qty > left) throw new CustomError(`De ${sold[0].name} solo quedan ${left} por devolver`, 409);
        returned.set(productId, (returned.get(productId) ?? 0) + qty);
      }
      return priceLine({
        productId: sold[0].productId, code: sold[0].code, name: sold[0].name, groupId: sold[0].groupId, qty,
        unitPrice: raw.unitPrice === undefined ? sold[0].unitPrice : cents(raw.unitPrice, "precio"),
        discount: cents(raw.discount ?? 0, "descuento"),
        vatRate: sold[0].vatRate,
        // Vuelve al costo promedio con que salió en la factura.
        unitCost: roundUnitCost(sum(sold.map((l: ISaleLine) => l.costTotal)) / 100 / soldQty),
      });
    });
    const totals = computeTotals(lines);
    if (totals.total <= 0) throw new CustomError("La nota de crédito debe tener un total mayor que cero", 400);
    if (totals.total > invoice.balance) {
      throw new CustomError(`La nota de crédito (${formatCents(totals.total)}) supera el saldo de la factura (${formatCents(invoice.balance)})`, 409);
    }

    const { sequential, number } = await nextDocNumber("nota_credito", invoice.establishment, invoice.emissionPoint, session);
    const _id = new Types.ObjectId();
    const source = { module: "ventas", docType: "NOTA_CREDITO", docId: _id, docNumber: number };

    if (returnsStock) {
      const stockIds = new Set(
        (await Product.find({ _id: { $in: lines.map((l) => l.productId) }, controlsStock: true }).session(session).lean<any[]>()).map((p) => String(p._id)),
      );
      const applied = await inventory.applyMovement(
        {
          warehouseId: invoice.warehouseId, date, type: "NOTA_CREDITO_VENTA", partyId: invoice.partyId, source,
          lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.unitCost })),
        },
        actor,
        session,
      );
      assignCosts(lines, applied, (l) => stockIds.has(String(l.productId)));
    }

    const entry = await accounting.postEntry(
      {
        date, type: "NC_VENTA", description: `NC ${number} a factura ${invoice.number}: ${reason}`, source,
        lines: await salesEntryLines(lines, totals, invoice.partyId, true, session),
      },
      actor,
      session,
    );

    const [doc] = await SalesCreditNote.create(
      [{
        _id, number, sequential, establishment: invoice.establishment, emissionPoint: invoice.emissionPoint,
        invoiceId: invoice._id, invoiceNumber: invoice.number, warehouseId: invoice.warehouseId, partyId: invoice.partyId,
        date, reason, returnsStock, lines, ...totals, journalEntryId: entry._id, createdBy: actor,
      }],
      { session },
    );
    await addAr(
      { invoiceId: invoice._id, partyId: invoice.partyId, date, kind: "NOTA_CREDITO", amount: -totals.total, description: `NC ${number}`, source: { docType: "NOTA_CREDITO", docId: _id, docNumber: number } },
      session,
    );
    return doc;
  });
  return salesSri.emit(SalesCreditNote, "creditNote", note._id);
}

export function listCreditNotes(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  if (query.invoiceId) filter.invoiceId = oid(query.invoiceId, "factura");
  if (query.partyId) filter.partyId = oid(query.partyId, "cliente");
  Object.assign(filter, sriStatusFilter(query));
  return paginate(SalesCreditNote, filter, query, ["number", "invoiceNumber", "reason"]);
}

export async function getCreditNote(id: string) {
  const note = await SalesCreditNote.findById(oid(id, "nota de crédito")).select("-xml").lean();
  if (!note) throw new CustomError("Nota de crédito no encontrada", 404);
  return note;
}

export const retrySri = (id: string) => salesSri.retry(SalesCreditNote, "creditNote", id);
