import { CustomError } from "../errors/customError.error";
import { SalesInvoice } from "../models/salesInvoice.model";
import { ArMovement } from "../models/arMovement.model";
import { dayRange, parseDay } from "../utils/dates";
import { sum } from "../utils/money";
import { oid, reportFilter, todayEc } from "./salesCommon.service";

/**
 * Reportes de cartera a una fecha de corte. Todo sale del libro ArMovement
 * (línea fechada por cada factura, ND, NC, cobro, retención o anulación), así
 * el saldo a cualquier fecha coincide con el mayor de Clientes a esa fecha.
 */
type Q = Record<string, unknown>;

export const AGING_BUCKETS = ["notDue", "d0_30", "d31_60", "d61_90", "d91_120", "over120"] as const;
type Bucket = (typeof AGING_BUCKETS)[number];

/** Días vencidos al corte: ≤ 0 no vencido; 1–30 cae en el tramo "0-30". */
export function bucketOf(daysOverdue: number): Bucket {
  if (daysOverdue <= 0) return "notDue";
  if (daysOverdue <= 30) return "d0_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  if (daysOverdue <= 120) return "d91_120";
  return "over120";
}

const emptyBuckets = () => Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;

function cutoffOf(query: Q) {
  const cutoff = parseDay(query.cutoff ?? todayEc(), "fecha de corte");
  return { cutoff, end: dayRange(undefined, cutoff.toISOString())!.$lte! };
}

/** Facturas (también las anuladas después del corte) con su saldo al corte. */
async function invoicesAt(query: Q) {
  const { cutoff, end } = cutoffOf(query);
  const filter = await reportFilter({ ...query, includeVoided: "true" }, null);
  filter.date = { ...(dayRange(query.from, undefined) ?? {}), $lte: end };
  const invoices = await SalesInvoice.find(filter).select("-xml -lines").sort({ "customer.name": 1, date: 1 }).lean<any[]>();
  const ids = invoices.map((i) => i._id);
  const movements = await ArMovement.find({ invoiceId: { $in: ids }, date: { $lte: end } }).sort({ date: 1, createdAt: 1 }).lean<any[]>();
  const byInvoice = new Map<string, any[]>();
  for (const m of movements) byInvoice.set(String(m.invoiceId), [...(byInvoice.get(String(m.invoiceId)) ?? []), m]);
  const rows = invoices.map((inv) => {
    const movs = byInvoice.get(String(inv._id)) ?? [];
    const charged = sum(movs.filter((m) => m.amount > 0).map((m) => m.amount));
    const credited = -sum(movs.filter((m) => m.amount < 0).map((m) => m.amount));
    return { inv, movs, charged, credited, balance: charged - credited };
  });
  return { cutoff, end, ids, rows };
}

const head = (inv: any) => ({
  invoiceId: inv._id, number: inv.number, date: inv.date, dueDate: inv.dueDate, sellerName: inv.sellerName, warehouseId: inv.warehouseId,
});

function byCustomer<T>(rows: { inv: any }[], map: (list: any[]) => T) {
  const groups = new Map<string, any[]>();
  for (const r of rows) groups.set(String(r.inv.partyId), [...(groups.get(String(r.inv.partyId)) ?? []), r]);
  return [...groups].map(([partyId, list]) => ({
    partyId, name: list[0].inv.customer?.name, identification: list[0].inv.customer?.identification, parish: list[0].inv.customer?.parish, ...map(list),
  }));
}

/** Facturas y cobros, resumido o detallado (con cada abono y su medio). status: pending | paid | all. */
export async function invoicesAndReceipts(query: Q) {
  const { cutoff, rows } = await invoicesAt(query);
  const status = String(query.status ?? "pending");
  // due: "overdue" (vencidas al corte) | "notDue" (por vencer) | vacío (todas), como el sistema de hoy.
  const due = (r: { inv: any }) => !query.due || (query.due === "overdue") === new Date(r.inv.dueDate).getTime() < cutoff.getTime();
  const kept = rows.filter((r) => r.charged > 0 && due(r) && (status === "all" || (status === "paid" ? r.balance === 0 : r.balance !== 0)));
  const detailed = query.detailed === "true";
  const customers = byCustomer(kept, (list) => ({
    invoices: list.map((r) => ({
      ...head(r.inv), total: r.charged, paid: r.credited, balance: r.balance,
      ...(detailed ? { movements: r.movs.map((m: any) => ({ date: m.date, kind: m.kind, amount: m.amount, description: m.description, docNumber: m.source?.docNumber })) } : {}),
    })),
    total: sum(list.map((r) => r.charged)),
    paid: sum(list.map((r) => r.credited)),
    balance: sum(list.map((r) => r.balance)),
  }));
  return { cutoff, customers, total: sum(kept.map((r) => r.charged)), paid: sum(kept.map((r) => r.credited)), balance: sum(kept.map((r) => r.balance)) };
}

/** Estado de cuenta de un cliente: saldo inicial, cada movimiento con saldo corrido y saldo final. */
export async function statement(query: Q) {
  const partyId = oid(query.partyId, "cliente");
  const range = dayRange(query.from, query.to) ?? {};
  const before = range.$gte
    ? await ArMovement.aggregate([{ $match: { partyId, date: { $lt: range.$gte } } }, { $group: { _id: null, total: { $sum: "$amount" } } }])
    : [];
  const opening = before[0]?.total ?? 0;
  const movements = await ArMovement.find({ partyId, ...(Object.keys(range).length ? { date: range } : {}) })
    .sort({ date: 1, createdAt: 1 })
    .lean<any[]>();
  const invoices = new Map(
    (await SalesInvoice.find({ _id: { $in: movements.map((m) => m.invoiceId) } }).select("number dueDate balance").lean<any[]>()).map((i) => [String(i._id), i]),
  );
  let running = opening;
  const rows = movements.map((m) => {
    running += m.amount;
    const inv = invoices.get(String(m.invoiceId));
    return {
      // Vencimiento solo en la línea de la factura y si aún tiene saldo: así se ve su atraso.
      dueDate: m.kind === "FACTURA" && inv?.balance > 0 ? inv.dueDate : null,
      date: m.date, kind: m.kind, invoiceNumber: inv?.number, docNumber: m.source?.docNumber, description: m.description,
      debit: m.amount > 0 ? m.amount : 0, credit: m.amount < 0 ? -m.amount : 0, balance: running,
    };
  });
  return { partyId, opening, rows, closing: running };
}

/**
 * Cartera por edades al corte, resumida (por cliente) y detallada (por
 * factura). `cuadra` compara ambas contra una suma directa del libro: es la
 * verificación que piden los auditores.
 */
export async function aging(query: Q) {
  const { cutoff, end, ids, rows } = await invoicesAt(query);
  const open = rows.filter((r) => r.balance !== 0);
  const detail = open.map((r) => {
    const daysOverdue = Math.round((cutoff.getTime() - new Date(r.inv.dueDate).getTime()) / 86_400_000);
    return { ...head(r.inv), partyId: r.inv.partyId, customer: r.inv.customer?.name, total: r.charged, balance: r.balance, daysOverdue, bucket: bucketOf(daysOverdue) };
  });
  const bucketById = new Map(detail.map((d) => [String(d.invoiceId), d.bucket]));
  const summary = byCustomer(open, (list) => {
    const buckets = emptyBuckets();
    for (const r of list) buckets[bucketById.get(String(r.inv._id))!] += r.balance;
    return { ...buckets, total: sum(list.map((r) => r.balance)) };
  });
  const totals = emptyBuckets();
  for (const d of detail) totals[d.bucket] += d.balance;
  const ledger = await ArMovement.aggregate([{ $match: { invoiceId: { $in: ids }, date: { $lte: end } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
  const summaryTotal = sum(summary.map((c) => c.total));
  const detailTotal = sum(detail.map((d) => d.balance));
  const ledgerTotal = ledger[0]?.total ?? 0;
  const bucketsTotal = sum(Object.values(totals));
  return {
    cutoff,
    totals: { ...totals, total: detailTotal },
    summaryTotal,
    detailTotal,
    ledgerTotal,
    cuadra: summaryTotal === detailTotal && detailTotal === ledgerTotal && bucketsTotal === detailTotal,
    ...(query.detailed === "true" ? { detail } : { summary }),
  };
}

export function receivablesReport(query: Q) {
  switch (query.type ?? "aging") {
    case "invoices": return invoicesAndReceipts(query);
    case "statement": return statement(query);
    case "aging": return aging(query);
    default: throw new CustomError("Tipo de reporte: invoices, statement o aging", 400);
  }
}
