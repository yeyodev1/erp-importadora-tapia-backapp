import { CustomError } from "../errors/customError.error";
import { SalesInvoice } from "../models/salesInvoice.model";
import { SalesWithholding } from "../models/salesWithholding.model";
import { CustomerReceipt } from "../models/customerReceipt.model";
import { dayRange } from "../utils/dates";
import { percentOf, sum } from "../utils/money";
import { oid } from "./salesCommon.service";

type Q = Record<string, unknown>;

/**
 * Retenciones en venta del rango: por factura (con el comprobante debajo) o
 * por tipo (renta/IVA y porcentaje). `tax` filtra renta o iva. Solo salen
 * las aplicadas: las pendientes no existen hasta que llega el comprobante.
 */
export async function withholdingsReport(query: Q) {
  const filter: Record<string, unknown> = { status: "vigente" };
  const range = dayRange(query.from, query.to);
  if (range) filter.date = range;
  if (query.partyId) filter.partyId = oid(query.partyId, "cliente");
  if (query.sellerName) filter.sellerName = String(query.sellerName);
  const tax = query.tax === "renta" || query.tax === "iva" ? query.tax : null;
  const docs = await SalesWithholding.find(filter).sort({ date: 1, invoiceNumber: 1 }).lean<any[]>();
  const invoices = new Map(
    (await SalesInvoice.find({ _id: { $in: docs.map((d) => d.invoiceId) } }).select("customer date").lean<any[]>()).map((i) => [String(i._id), i]),
  );
  const rows = docs
    .map((d) => {
      const inv = invoices.get(String(d.invoiceId));
      const lines = d.lines.filter((l: any) => !tax || l.tax === tax);
      return {
        date: d.date, invoiceDate: inv?.date, invoiceNumber: d.invoiceNumber, customer: inv?.customer?.name, identification: inv?.customer?.identification,
        sellerName: d.sellerName, voucherNumber: d.voucherNumber, authorization: d.authorization, lines, total: sum(lines.map((l: any) => l.amount)),
      };
    })
    .filter((r) => r.lines.length > 0);
  const allLines = rows.flatMap((r) => r.lines);
  const totals = {
    renta: sum(allLines.filter((l: any) => l.tax === "renta").map((l: any) => l.amount)),
    iva: sum(allLines.filter((l: any) => l.tax === "iva").map((l: any) => l.amount)),
    total: sum(allLines.map((l: any) => l.amount)),
  };
  if (query.groupBy === "type") {
    const types = new Map<string, { tax: string; rate: number; count: number; base: number; amount: number }>();
    for (const l of allLines) {
      const k = `${l.tax}-${l.rate}`;
      const t = types.get(k) ?? { tax: l.tax, rate: l.rate, count: 0, base: 0, amount: 0 };
      t.count += 1;
      t.base += l.base;
      t.amount += l.amount;
      types.set(k, t);
    }
    return { types: [...types.values()].sort((a, b) => a.tax.localeCompare(b.tax) || a.rate - b.rate), totals };
  }
  return { rows, totals };
}

/**
 * Comisiones por vendedor sobre lo COBRADO en el rango (abonos de cobros
 * vigentes; NC y retenciones no cuentan), al `rate` % que llegue en query.
 * shortcut: la regla real de Tapia está pendiente (¿base sin IVA? ¿cheques aún no acreditados?); hoy cuenta el abono completo en la fecha del cobro.
 */
export async function commissions(query: Q) {
  const rate = Number(query.rate ?? 1);
  if (!(rate >= 0 && rate <= 100)) throw new CustomError("Porcentaje de comisión inválido", 400);
  const filter: Record<string, unknown> = { status: "vigente", "check.status": { $ne: "devuelto" } };
  const range = dayRange(query.from, query.to);
  if (range) filter.date = range;
  const receipts = await CustomerReceipt.find(filter).lean<any[]>();
  const apps = receipts.flatMap((r) => r.applications);
  const sellers = new Map(
    (await SalesInvoice.find({ _id: { $in: apps.map((a) => a.invoiceId) } }).select("sellerName").lean<any[]>()).map((i) => [String(i._id), i.sellerName || "(sin vendedor)"]),
  );
  const bySeller = new Map<string, number>();
  for (const a of apps) {
    const seller = sellers.get(String(a.invoiceId))!;
    bySeller.set(seller, (bySeller.get(seller) ?? 0) + a.amount);
  }
  const items = [...bySeller]
    .filter(([seller]) => !query.sellerName || seller === query.sellerName)
    .map(([sellerName, collected]) => ({ sellerName, collected, rate, commission: percentOf(collected, rate) }))
    .sort((a, b) => b.collected - a.collected);
  return { rate, items, collected: sum(items.map((i) => i.collected)), commission: sum(items.map((i) => i.commission)) };
}
