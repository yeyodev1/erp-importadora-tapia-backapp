import { CustomerReceipt } from "../models/customerReceipt.model";
import { Product } from "../models/product.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { SalesCreditNote } from "../models/salesCreditNote.model";
import { SalesDebitNote } from "../models/salesDebitNote.model";
import { SalesInvoice } from "../models/salesInvoice.model";
import { StockBalance } from "../models/stockBalance.model";
import { Warehouse } from "../models/warehouse.model";
import type { Role } from "../models/user.model";
import { dayRange } from "../utils/dates";
import { periodBounds, todayStr } from "./ledgerReports.service";
import { aging } from "./receivablesReport.service";
import { topProducts } from "./salesReport.service";

/**
 * Tablero de Inicio. Cada rol recibe solo sus secciones; el vendedor ve sus
 * propias ventas y clientes. Ventas = base sin IVA de facturas vigentes (como
 * "Ventas Factura"); las NC no se restan aquí, el neto está en el cuadre de impuestos.
 * shortcut: el usuario vendedor se cruza con sellerName por su nombre; si no coinciden, ligar User ↔ vendedor.
 */
const SECTIONS: Record<string, Role[]> = {
  sales: ["contabilidad", "facturacion", "cartera", "vendedor", "auditor"],
  topProducts: ["contabilidad", "facturacion", "bodega", "vendedor", "auditor"],
  topCustomers: ["contabilidad", "facturacion", "cartera", "vendedor", "auditor"],
  receivables: ["contabilidad", "cartera", "auditor"],
  payables: ["contabilidad", "auditor"],
  lowStock: ["contabilidad", "facturacion", "bodega", "auditor"],
  postdatedChecks: ["contabilidad", "cartera", "auditor"],
  sriPending: ["contabilidad", "facturacion", "auditor"],
};

export interface Viewer {
  role: Role;
  name: string;
}

const base = { $add: ["$subtotal0", "$subtotalVat"] };
const shiftMonth = (period: string, delta: number) => {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

async function salesByMonth(match: Record<string, unknown>, period: string) {
  const prev = shiftMonth(period, -1);
  const date = { $gte: periodBounds(prev).start, $lte: periodBounds(period).end };
  const [rows, warehouses] = await Promise.all([
    SalesInvoice.aggregate([
      { $match: { ...match, date } },
      { $project: { month: { $dateToString: { date: "$date", format: "%Y-%m" } }, warehouseId: 1, sellerName: 1, base, total: 1 } },
      {
        $facet: {
          month: [{ $group: { _id: "$month", sales: { $sum: "$base" }, total: { $sum: "$total" }, count: { $sum: 1 } } }],
          warehouse: [{ $group: { _id: { m: "$month", k: "$warehouseId" }, sales: { $sum: "$base" }, count: { $sum: 1 } } }],
          seller: [{ $group: { _id: { m: "$month", k: "$sellerName" }, sales: { $sum: "$base" }, count: { $sum: 1 } } }],
        },
      },
    ]),
    Warehouse.find().select("name").lean<any[]>(),
  ]);
  const { month, warehouse, seller } = rows[0];
  const names = new Map(warehouses.map((w) => [String(w._id), w.name]));
  const of = (p: string) => {
    const m = month.find((r: any) => r._id === p);
    return {
      period: p,
      sales: m?.sales ?? 0,
      total: m?.total ?? 0,
      count: m?.count ?? 0,
      byWarehouse: warehouse.filter((r: any) => r._id.m === p).map((r: any) => ({ warehouseId: r._id.k, name: names.get(String(r._id.k)) ?? "", sales: r.sales, count: r.count })).sort((a: any, b: any) => b.sales - a.sales),
      bySeller: seller.filter((r: any) => r._id.m === p).map((r: any) => ({ sellerName: r._id.k || "(sin vendedor)", sales: r.sales, count: r.count })).sort((a: any, b: any) => b.sales - a.sales),
    };
  };
  return { current: of(period), previous: of(prev) };
}

async function monthlySeries(match: Record<string, unknown>, period: string) {
  const first = shiftMonth(period, -11);
  const rows = await SalesInvoice.aggregate([
    { $match: { ...match, date: { $gte: periodBounds(first).start, $lte: periodBounds(period).end } } },
    { $group: { _id: { $dateToString: { date: "$date", format: "%Y-%m" } }, sales: { $sum: base }, count: { $sum: 1 } } },
  ]);
  const by = new Map(rows.map((r) => [r._id, r]));
  return Array.from({ length: 12 }, (_, i) => {
    const p = shiftMonth(first, i);
    return { period: p, sales: by.get(p)?.sales ?? 0, count: by.get(p)?.count ?? 0 };
  });
}

async function topCustomers(match: Record<string, unknown>, from: Date, to: Date) {
  const rows = await SalesInvoice.aggregate([
    { $match: { ...match, date: { $gte: from, $lte: to } } },
    { $group: { _id: "$partyId", name: { $last: "$customer.name" }, identification: { $last: "$customer.identification" }, sales: { $sum: base }, count: { $sum: 1 } } },
    { $sort: { sales: -1, name: 1 } },
    { $limit: 10 },
  ]);
  return rows.map((r) => ({ partyId: r._id, name: r.name, identification: r.identification, sales: r.sales, count: r.count }));
}

export async function lowStock() {
  const rows = await Product.aggregate([
    { $match: { isActive: true, controlsStock: true, minQty: { $gt: 0 } } },
    { $lookup: { from: StockBalance.collection.name, localField: "_id", foreignField: "productId", as: "stock" } },
    { $project: { qty: { $sum: "$stock.qty" }, minQty: 1 } },
    { $match: { $expr: { $lt: ["$qty", "$minQty"] } } },
    { $count: "n" },
  ]);
  return { products: rows[0]?.n ?? 0 };
}

export async function overduePayables(today: Date) {
  const rows = await PurchaseInvoice.aggregate([
    { $match: { status: "vigente", balance: { $gt: 0 }, dueDate: { $lt: today } } },
    { $group: { _id: null, amount: { $sum: "$balance" }, count: { $sum: 1 } } },
  ]);
  return { amount: rows[0]?.amount ?? 0, count: rows[0]?.count ?? 0 };
}

export async function postdatedChecksDue(from: Date, to: Date) {
  const rows = await CustomerReceipt.aggregate([
    { $match: { method: "CHEQUE_POSFECHADO", status: "vigente", "check.status": "en_cartera", "check.dueDate": { $gte: from, $lte: to } } },
    { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  return { amount: rows[0]?.amount ?? 0, count: rows[0]?.count ?? 0 };
}

/** Comprobantes que emitimos y el SRI aún no autoriza ("" = todavía no se envió). */
async function sriPending() {
  const notAuthorized = { status: "vigente", sriStatus: { $ne: "autorizado" } };
  const [invoices, creditNotes, debitNotes, withholdings] = await Promise.all([
    SalesInvoice.countDocuments({ ...notAuthorized, isOpening: { $ne: true } }),
    SalesCreditNote.countDocuments(notAuthorized),
    SalesDebitNote.countDocuments(notAuthorized),
    PurchaseInvoice.countDocuments({ status: "vigente", withholding: { $ne: null }, "withholding.sriStatus": { $ne: "autorizado" } }),
  ]);
  return { invoices, creditNotes, debitNotes, withholdings, total: invoices + creditNotes + debitNotes + withholdings };
}

export async function getDashboard(viewer: Viewer, query: Record<string, unknown>) {
  const today = todayStr();
  const period = String(query.month ?? today.slice(0, 7));
  periodBounds(period); // valida AAAA-MM
  const can = (section: string) => viewer.role === "admin" || SECTIONS[section].includes(viewer.role);
  const own = viewer.role === "vendedor" ? { sellerName: viewer.name } : {};
  const match = { status: "vigente", isOpening: { $ne: true }, ...own };
  const yearStart = new Date(Date.UTC(Number(period.slice(0, 4)), 0, 1));
  const { end } = periodBounds(period);
  const todayRange = dayRange(today, today)!;
  const inAWeek = new Date(todayRange.$lte!.getTime() + 7 * 86_400_000);

  const tasks: Record<string, () => Promise<unknown>> = {
    sales: () => salesByMonth(match, period).then(async (s) => ({ ...s, series: await monthlySeries(match, period) })),
    topProducts: async () => (await topProducts({ from: yearStart.toISOString(), to: end.toISOString(), by: "value", limit: 10, ...own })).items,
    topCustomers: () => topCustomers(match, yearStart, end),
    receivables: async () => {
      const a: any = await aging({ cutoff: today });
      return { total: a.totals.total, overdue: a.totals.total - a.totals.notDue, buckets: a.totals, cuadra: a.cuadra };
    },
    payables: async () => ({ overdue: await overduePayables(todayRange.$gte!) }),
    lowStock,
    postdatedChecks: () => postdatedChecksDue(todayRange.$gte!, inAWeek),
    sriPending,
  };
  const keys = Object.keys(tasks).filter(can);
  const values = await Promise.all(keys.map((k) => tasks[k]()));
  return { period, today, role: viewer.role, ...Object.fromEntries(keys.map((k, i) => [k, values[i]])) };
}
