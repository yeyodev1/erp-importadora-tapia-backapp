import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Party } from "../models/party.model";
import { PayableApplication } from "../models/payableApplication.model";
import { PayableTransaction } from "../models/payableTransaction.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { dayRange } from "../utils/dates";
import { sum } from "../utils/money";

/**
 * Consultas de Cuentas por pagar (pantalla "Saldos"): saldos por proveedor
 * con fecha de corte, estado de cuenta y anticipos abiertos.
 * shortcut: el corte usa el estado actual (vigente/anulado) de cada documento; un documento anulado
 * después de la fecha de corte no aparece. Si contabilidad pide corte histórico exacto, guardar voidedAt.
 */
function cutoffOf(value: unknown): Date {
  return dayRange(undefined, value ?? new Date().toISOString().slice(0, 10))!.$lte!;
}

async function paidByInvoice(invoiceIds: Types.ObjectId[], cutoff: Date) {
  const rows = await PayableApplication.aggregate([
    { $match: { status: "vigente", date: { $lte: cutoff }, invoiceId: { $in: invoiceIds } } },
    { $group: { _id: "$invoiceId", paid: { $sum: "$amount" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.paid as number]));
}

/** Saldo de cada anticipo a la fecha de corte: valor − cruces − devoluciones hasta esa fecha. */
async function advanceBalances(cutoff: Date, partyId?: unknown) {
  const filter: Record<string, unknown> = { kind: "anticipo", status: "vigente", date: { $lte: cutoff } };
  if (partyId) filter.partyId = partyId;
  const advances = await PayableTransaction.find(filter).lean<any[]>();
  const used = await PayableTransaction.aggregate([
    { $match: { kind: { $in: ["cruce", "devolucion"] }, status: "vigente", date: { $lte: cutoff }, advanceId: { $in: advances.map((a) => a._id) } } },
    { $group: { _id: "$advanceId", used: { $sum: "$amount" } } },
  ]);
  const usedBy = new Map(used.map((u) => [String(u._id), u.used as number]));
  return advances.map((a) => ({ ...a, open: a.amount - (usedBy.get(String(a._id)) ?? 0) }));
}

/** ?mode=todas|por_pagar|canceladas &cutoff=AAAA-MM-DD &supplierId &includeAdvances=true */
export async function supplierBalances(query: Record<string, unknown>) {
  const cutoff = cutoffOf(query.cutoff);
  const filter: Record<string, unknown> = { status: "vigente", date: { $lte: cutoff } };
  if (query.supplierId) filter.supplierId = query.supplierId;
  const invoices = await PurchaseInvoice.find(filter).select("supplierId supplierRuc supplierName payable dueDate").lean<any[]>();
  const paid = await paidByInvoice(invoices.map((i) => i._id), cutoff);

  const bySupplier = new Map<string, any>();
  const row = (id: string, identification: string, name: string) => {
    if (!bySupplier.has(id)) bySupplier.set(id, { supplierId: id, identification, name, invoices: 0, billed: 0, paid: 0, balance: 0, advances: 0, oldestDue: null });
    return bySupplier.get(id);
  };
  for (const inv of invoices) {
    const p = paid.get(String(inv._id)) ?? 0;
    const balance = inv.payable - p;
    if (query.mode === "por_pagar" && balance <= 0) continue;
    if (query.mode === "canceladas" && balance > 0) continue;
    const r = row(String(inv.supplierId), inv.supplierRuc, inv.supplierName);
    r.invoices += 1;
    r.billed += inv.payable;
    r.paid += p;
    r.balance += balance;
    // Vencimiento de la factura con saldo más antigua: los días de atraso del proveedor.
    if (balance > 0 && (!r.oldestDue || inv.dueDate < r.oldestDue)) r.oldestDue = inv.dueDate;
  }
  if (query.includeAdvances === "true") {
    const advances = (await advanceBalances(cutoff, query.supplierId)).filter((a) => a.open > 0);
    const parties = await Party.find({ _id: { $in: advances.map((a) => a.partyId) } }).select("name identification").lean<any[]>();
    const partyBy = new Map(parties.map((p) => [String(p._id), p]));
    for (const a of advances) {
      const p = partyBy.get(String(a.partyId));
      row(String(a.partyId), p?.identification ?? "", p?.name ?? "").advances += a.open;
    }
  }
  const items = [...bySupplier.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totals = { billed: sum(items.map((i) => i.billed)), paid: sum(items.map((i) => i.paid)), balance: sum(items.map((i) => i.balance)), advances: sum(items.map((i) => i.advances)) };
  return { cutoff, items, totals, total: items.length };
}

/** Estado de cuenta: facturas (haber) y abonos (debe) con saldo corrido. */
export async function supplierStatement(supplierId: string, query: Record<string, unknown>) {
  if (!Types.ObjectId.isValid(supplierId)) throw new CustomError("Proveedor inválido", 400);
  const supplier = await Party.findById(supplierId).select("name identification").lean<any>();
  if (!supplier) throw new CustomError("Proveedor no encontrado", 404);
  const range = dayRange(query.from, query.to) ?? {};
  const invoices = await PurchaseInvoice.find({ supplierId, status: "vigente" }).select("docType docNumber date dueDate payable").lean<any[]>();
  const apps = await PayableApplication.find({ supplierId, status: "vigente" }).lean<any[]>();
  const docBy = new Map(invoices.map((i) => [String(i._id), i.docNumber]));
  const paidBy = new Map<string, number>();
  for (const a of apps) paidBy.set(String(a.invoiceId), (paidBy.get(String(a.invoiceId)) ?? 0) + a.amount);
  const moves = [
    // `open`: saldo de hoy de la factura, para marcar solo las que siguen vencidas.
    ...invoices.map((i) => ({ date: i.date, kind: "factura", docNumber: i.docNumber, dueDate: i.dueDate, open: i.payable - (paidBy.get(String(i._id)) ?? 0), invoiceId: i._id, charge: i.payable, credit: 0 })),
    ...apps.map((a) => ({ date: a.date, kind: a.kind, docNumber: docBy.get(String(a.invoiceId)) ?? "", invoiceId: a.invoiceId, sourceId: a.sourceId, charge: 0, credit: a.amount })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime() || b.charge - a.charge);

  let opening = 0;
  let balance = 0;
  const items = [];
  for (const m of moves) {
    if (range.$gte && m.date < range.$gte) {
      opening += m.charge - m.credit;
      balance = opening;
      continue;
    }
    if (range.$lte && m.date > range.$lte) break;
    balance += m.charge - m.credit;
    items.push({ ...m, balance });
  }
  return { supplier, opening, items, closing: balance };
}

/** Anticipos con saldo por cruzar o devolver (?partyId). */
export async function openAdvances(query: Record<string, unknown>) {
  const advances = (await advanceBalances(cutoffOf(query.cutoff), query.partyId)).filter((a) => a.open > 0);
  const parties = await Party.find({ _id: { $in: advances.map((a) => a.partyId) } }).select("name identification isEmployee").lean<any[]>();
  const partyBy = new Map(parties.map((p) => [String(p._id), p]));
  const items = advances.map((a) => ({
    _id: a._id,
    number: a.number,
    date: a.date,
    party: partyBy.get(String(a.partyId)) ?? null,
    method: a.method,
    checkNumber: a.checkNumber,
    amount: a.amount,
    open: a.open,
  }));
  return { items, total: items.length, totalOpen: sum(items.map((i) => i.open)) };
}
