import { CustomError } from "../errors/customError.error";
import { SalesInvoice } from "../models/salesInvoice.model";
import { Warehouse } from "../models/warehouse.model";
import { TIMEZONE } from "../utils/dates";
import { sum } from "../utils/money";
import { invoiceFilter, oid, reportFilter } from "./salesCommon.service";

/**
 * Reportes de ventas ("Ventas Factura" del sistema actual): resumido por
 * bodega y día, detallado con líneas, por vendedor, por cliente y más
 * vendidos. Las anuladas salen solo con includeVoided=true y no suman.
 */
type Q = Record<string, unknown>;

const money = (docs: any[]) => {
  const live = docs.filter((d) => d.status === "vigente");
  return {
    count: live.length,
    subtotal0: sum(live.map((d) => d.subtotal0)),
    subtotalVat: sum(live.map((d) => d.subtotalVat)),
    discount: sum(live.map((d) => d.discount)),
    vat: sum(live.map((d) => d.vat)),
    total: sum(live.map((d) => d.total)),
  };
};

const dayOf = (d: Date) => new Date(d).toISOString().slice(0, 10);
const hourOf = (d: Date) => new Date(d).toLocaleTimeString("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });

function row(inv: any, withLines: boolean) {
  return {
    _id: inv._id,
    hour: hourOf(inv.createdAt),
    series: `${inv.establishment}-${inv.emissionPoint}`,
    sequential: inv.sequential,
    number: inv.number,
    customer: inv.customer?.name,
    identification: inv.customer?.identification,
    sellerName: inv.sellerName,
    subtotal0: inv.subtotal0,
    subtotalVat: inv.subtotalVat,
    discount: inv.discount,
    vat: inv.vat,
    total: inv.total,
    status: inv.status,
    ...(withLines ? { lines: inv.lines.map((l: any) => ({ code: l.code, name: l.name, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount, subtotal: l.subtotal, vatRate: l.vatRate })) } : {}),
  };
}

async function find(query: Q) {
  return SalesInvoice.find(await reportFilter(query)).select("-xml").sort({ date: 1, createdAt: 1 }).lean<any[]>();
}

/** Resumido o detallado: bodega → día → facturas, con subtotales en cada nivel. */
export async function salesByDay(query: Q, detailed: boolean) {
  const docs = await find(query);
  const warehouses = new Map((await Warehouse.find().lean<any[]>()).map((w) => [String(w._id), w.name]));
  const byWarehouse = new Map<string, any[]>();
  for (const d of docs) byWarehouse.set(String(d.warehouseId), [...(byWarehouse.get(String(d.warehouseId)) ?? []), d]);
  const groups = [...byWarehouse].map(([warehouseId, invs]) => {
    const byDay = new Map<string, any[]>();
    for (const d of invs) byDay.set(dayOf(d.date), [...(byDay.get(dayOf(d.date)) ?? []), d]);
    return {
      warehouseId,
      warehouse: warehouses.get(warehouseId) ?? "",
      days: [...byDay].map(([date, list]) => ({ date, rows: list.map((d) => row(d, detailed)), totals: money(list) })),
      totals: money(invs),
    };
  });
  return { from: query.from ?? null, to: query.to ?? null, groups, totals: money(docs) };
}

/** Resumido por vendedor o por cliente. */
export async function salesBy(query: Q, key: "seller" | "customer") {
  const docs = await find(query);
  const buckets = new Map<string, { label: string; docs: any[] }>();
  for (const d of docs) {
    const k = key === "seller" ? d.sellerName || "(sin vendedor)" : String(d.partyId);
    const label = key === "seller" ? k : d.customer?.name;
    buckets.set(k, { label, docs: [...(buckets.get(k)?.docs ?? []), d] });
  }
  const items = [...buckets]
    .map(([k, b]) => ({ key: k, name: b.label, ...money(b.docs) }))
    .sort((a, b) => b.total - a.total);
  return { items, totals: money(docs) };
}

/** Más vendidos por cantidad o por valor (base neta), top N. */
export async function topProducts(query: Q) {
  const by = query.by === "value" ? "value" : "qty";
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 20));
  const filter = invoiceFilter({ ...query, includeVoided: "false" });
  const lineMatch = query.groupId ? [{ $match: { "lines.groupId": oid(query.groupId, "grupo") } }] : [];
  const items = await SalesInvoice.aggregate([
    { $match: filter },
    { $unwind: "$lines" },
    ...lineMatch,
    {
      $group: {
        _id: "$lines.productId",
        code: { $first: "$lines.code" },
        name: { $first: "$lines.name" },
        qty: { $sum: "$lines.qty" },
        value: { $sum: "$lines.subtotal" },
        invoices: { $sum: 1 },
      },
    },
    { $sort: { [by]: -1, code: 1 } },
    { $limit: limit },
  ]);
  return { by, items: items.map((i) => ({ productId: i._id, code: i.code, name: i.name, qty: Math.round(i.qty * 10000) / 10000, value: i.value, invoices: i.invoices })) };
}

export function salesReport(query: Q) {
  switch (query.type ?? "summary") {
    case "summary": return salesByDay(query, false);
    case "detailed": return salesByDay(query, true);
    case "seller": return salesBy(query, "seller");
    case "customer": return salesBy(query, "customer");
    default: throw new CustomError("Tipo de reporte: summary, detailed, seller o customer", 400);
  }
}
