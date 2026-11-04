import { CustomError } from "../errors/customError.error";
import { runInTransaction } from "../config/transaction";
import { Warehouse } from "../models/warehouse.model";
import { SalesInvoice, ISaleLine } from "../models/salesInvoice.model";
import { SalesProforma } from "../models/salesProforma.model";
import { parseDay } from "../utils/dates";
import type { Actor } from "./accounting.service";
import * as sequence from "./sequence.service";
import * as salesSri from "./salesSri.service";
import { postInvoice, InvoiceBody } from "./invoice.service";
import { buildLines, customerOf, oid, paginate, todayEc } from "./salesCommon.service";

/** Proforma: misma cabecera y líneas que la factura, sin número SRI, sin stock y sin asiento. */
export async function createProforma(body: InvoiceBody, actor: Actor) {
  const warehouse = await Warehouse.findById(oid(body.warehouseId, "bodega")).lean<any>();
  if (!warehouse) throw new CustomError("Bodega no encontrada", 404);
  const { party, snapshot } = await customerOf(body.partyId);
  const priceList = body.priceList || party.customer?.priceList || "GENERAL";
  const { lines, totals } = await buildLines(body.lines, priceList);
  const number = `PRO-${sequence.pad9(await sequence.next("proforma"))}`;
  const doc = await SalesProforma.create({
    number, warehouseId: warehouse._id, partyId: party._id, customer: snapshot,
    sellerName: body.sellerName ?? party.customer?.sellerName ?? "", date: parseDay(body.date),
    creditDays: Number(body.creditDays ?? party.customer?.creditDays ?? 0), priceList,
    paymentMethod: body.paymentMethod || "20", notes: body.notes ?? "", orderRef: body.orderRef ?? "",
    lines, ...totals, createdBy: actor,
  });
  return doc.toObject();
}

/** Factura la proforma con sus precios; `date` y `warehouseId` pueden cambiar al facturar. */
export async function invoiceProforma(id: string, body: { date?: string; warehouseId?: string }, actor: Actor) {
  const invoice = await runInTransaction(async (session) => {
    const pf = await SalesProforma.findById(oid(id, "proforma")).session(session);
    if (!pf) throw new CustomError("Proforma no encontrada", 404);
    if (pf.status !== "abierta") throw new CustomError("La proforma ya fue facturada", 409);
    const inv = await postInvoice(
      {
        warehouseId: body.warehouseId ?? pf.warehouseId, partyId: pf.partyId, date: body.date ?? todayEc(),
        sellerName: pf.sellerName, priceList: pf.priceList, creditDays: pf.creditDays, paymentMethod: pf.paymentMethod,
        notes: pf.notes, orderRef: pf.orderRef || pf.number,
        lines: pf.lines.map((l: ISaleLine) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount })),
      },
      actor,
      session,
      pf._id,
    );
    pf.status = "facturada";
    pf.invoiceId = inv._id;
    await pf.save({ session });
    return inv;
  });
  return salesSri.emit(SalesInvoice, "invoice", invoice._id);
}

export function listProformas(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = String(query.status);
  if (query.partyId) filter.partyId = oid(query.partyId, "cliente");
  return paginate(SalesProforma, filter, query, ["number", "customer.name", "orderRef"]);
}

export async function getProforma(id: string) {
  const pf = await SalesProforma.findById(oid(id, "proforma")).lean();
  if (!pf) throw new CustomError("Proforma no encontrada", 404);
  return pf;
}
