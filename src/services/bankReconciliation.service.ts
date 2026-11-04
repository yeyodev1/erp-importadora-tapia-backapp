import { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { BankMovement } from "../models/bankMovement.model";
import { BankReconciliation } from "../models/bankReconciliation.model";
import { cents, formatCents } from "../utils/money";
import { dayRange, parseDay } from "../utils/dates";
import { getSettings } from "./accounting.service";
import type { Actor } from "./accounting.service";
import { accountingBalanceOf } from "./bankBalances.service";
import * as bankCore from "./bankCore.service";

export const SUMMARY_TYPES = ["DEPOSITO", "NOTA_CREDITO", "NOTA_DEBITO", "CHEQUE"] as const;
type SummaryType = (typeof SUMMARY_TYPES)[number];

/**
 * El resumen tiene cuatro filas como el sistema actual. Una transferencia
 * entrante el banco la muestra como nota de crédito y una saliente como
 * nota de débito, así que caen ahí.
 */
function bucket(m: any): SummaryType {
  if ((SUMMARY_TYPES as readonly string[]).includes(m.type)) return m.type;
  return m.direction === "in" ? "NOTA_CREDITO" : "NOTA_DEBITO";
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function findReconciliation(id: string, session?: ClientSession) {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Conciliación no encontrada", 404);
  const rec = await BankReconciliation.findById(id).session(session ?? null);
  if (!rec) throw new CustomError("Conciliación no encontrada", 404);
  return rec;
}

export async function openReconciliation(id: string, session?: ClientSession) {
  const rec = await findReconciliation(id, session);
  if (rec.status === "cerrada") throw new CustomError("La conciliación está cerrada: reábrela para moverla", 409);
  return rec;
}

/** Movimientos cargados. En una abierta solo cuentan los vigentes que nadie más concilió. */
export async function loadedMovements(rec: any, session?: ClientSession) {
  const filter: Record<string, unknown> = { _id: { $in: rec.movementIds } };
  if (rec.status === "abierta") Object.assign(filter, { status: "vigente", reconciledAt: null });
  const cleared = new Set(rec.clearedIds.map(String));
  const movements = await BankMovement.find(filter).sort({ date: 1, createdAt: 1 }).session(session ?? null).lean<any[]>();
  return movements.map((m) => ({ ...m, cleared: cleared.has(String(m._id)) }));
}

/** Resumen: saldo del estado de cuenta ajustado por lo elaborado y no efectivizado, contra el libro de bancos. */
export async function summarize(rec: any, movements: any[], session?: ClientSession) {
  if (rec.status === "cerrada" && rec.closedSummary) return rec.closedSummary;
  const bank = await bankCore.getBankAccount(rec.bankAccountId, session);
  const bookBalance = await accountingBalanceOf(bank.accountCode, dayRange(undefined, ymd(rec.to))!.$lte!);
  const rows = SUMMARY_TYPES.map((type) => {
    const mine = movements.filter((m) => bucket(m) === type);
    const pending = mine.filter((m) => !m.cleared);
    const total = (list: any[]) => list.reduce((a, m) => a + m.amount, 0);
    return {
      type,
      previousMonths: total(pending.filter((m) => m.date < rec.from)),
      pendingInPeriod: total(pending.filter((m) => m.date >= rec.from)),
      bookInPeriod: total(mine.filter((m) => m.date >= rec.from)),
      records: { pending: pending.length, cleared: mine.length - pending.length },
    };
  });
  const pendingOf = (dir: "in" | "out") =>
    movements.filter((m) => !m.cleared && m.direction === dir).reduce((a, m) => a + m.amount, 0);
  const adjustedBalance = rec.statementBalance + pendingOf("in") - pendingOf("out");
  const difference = adjustedBalance - bookBalance;
  return {
    statementBalance: rec.statementBalance,
    bookBalance,
    rows,
    adjustedBalance,
    difference,
    balanced: difference === 0,
    message: difference === 0 ? "Conciliación cuadrada" : `Diferencia de ${formatCents(difference)}`,
    totalRecords: movements.length,
  };
}

export async function createReconciliation(body: Record<string, any>, actor: Actor) {
  if (!body?.bankAccountId) throw new CustomError("Seleccione banco", 400);
  const bank = await bankCore.getBankAccount(String(body.bankAccountId));
  if (bank.kind !== "banco") throw new CustomError("Solo se concilian cuentas bancarias", 400);
  const from = parseDay(body.from, "fecha desde");
  const to = parseDay(body.to, "fecha hasta");
  if (from > to) throw new CustomError("La fecha desde no puede ser mayor que hasta", 400);
  const rec = await BankReconciliation.create({
    bankAccountId: bank._id,
    description: `Conciliación ${bank.name} ${bank.number} desde: ${ymd(from)} hasta: ${ymd(to)}`,
    from,
    to,
    statementBalance: cents(body.statementBalance ?? 0, "saldo del estado de cuenta", true),
    createdBy: { userId: actor.userId, name: actor.name },
  });
  return rec.toObject();
}

export async function listReconciliations(query: Record<string, unknown>) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const filter: Record<string, unknown> = {};
  if (query.bankAccountId) filter.bankAccountId = String(query.bankAccountId);
  if (query.status) filter.status = String(query.status);
  const [items, total] = await Promise.all([
    BankReconciliation.find(filter, { movementIds: 0, clearedIds: 0 }).sort({ to: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    BankReconciliation.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getReconciliation(id: string) {
  const rec = await findReconciliation(id);
  const movements = await loadedMovements(rec);
  return { ...rec.toObject(), movements, summary: await summarize(rec, movements) };
}

/**
 * "Carga movimientos": los vigentes no conciliados hasta la fecha hasta,
 * incluidos los pendientes de meses anteriores. Conserva las marcas previas.
 */
export async function loadMovements(id: string) {
  const rec = await openReconciliation(id);
  const ids = await BankMovement.find({
    bankAccountId: rec.bankAccountId,
    status: "vigente",
    reconciledAt: null,
    date: { $lte: dayRange(undefined, ymd(rec.to))!.$lte },
  }).distinct("_id");
  const loaded = new Set(ids.map(String));
  rec.movementIds = ids;
  rec.clearedIds = rec.clearedIds.filter((c: Types.ObjectId) => loaded.has(String(c)));
  await rec.save();
  return getReconciliation(id);
}

/** Cambia el saldo del estado de cuenta y/o las marcas de cobrado (reemplaza la lista completa). */
export async function updateReconciliation(id: string, body: Record<string, any>) {
  const rec = await openReconciliation(id);
  if (body?.statementBalance !== undefined) {
    rec.statementBalance = cents(body.statementBalance, "saldo del estado de cuenta", true);
  }
  if (body?.clearedIds !== undefined) {
    if (!Array.isArray(body.clearedIds)) throw new CustomError("clearedIds debe ser una lista", 400);
    rec.clearedIds = toLoadedIds(rec, body.clearedIds);
  }
  await rec.save();
  return getReconciliation(id);
}

/** Valida que los ids pertenezcan a los movimientos cargados. */
export function toLoadedIds(rec: any, raw: unknown[]): Types.ObjectId[] {
  const loaded = new Map<string, Types.ObjectId>(rec.movementIds.map((m: Types.ObjectId) => [String(m), m]));
  return [...new Set(raw.map(String))].map((id) => {
    const found = loaded.get(id);
    if (!found) throw new CustomError(`El movimiento ${id} no está cargado en esta conciliación`, 400);
    return found;
  });
}

/** Cierra: exige que cuadre o `force` con motivo. Marca como conciliados los cobrados. */
export async function closeReconciliation(id: string, body: Record<string, any>, actor: Actor) {
  const force = body?.force === true;
  const reason = String(body?.reason ?? "").trim();
  await runInTransaction(async (session) => {
    const rec = await openReconciliation(id, session);
    const movements = await loadedMovements(rec, session);
    const summary = await summarize(rec, movements, session);
    if (!summary.balanced && !force) {
      throw new CustomError(`La conciliación no cuadra: ${summary.message}. Para cerrarla igual envía force con el motivo`, 409, summary);
    }
    if (!summary.balanced && !reason) throw new CustomError("Indica el motivo para cerrar con diferencia", 400);
    const cleared = movements.filter((m) => m.cleared).map((m) => m._id);
    const res = await BankMovement.updateMany(
      { _id: { $in: cleared }, status: "vigente", reconciledAt: null },
      { reconciledAt: new Date(), reconciliationId: rec._id },
      { session },
    );
    if (res.modifiedCount !== cleared.length) {
      throw new CustomError("Algunos movimientos cambiaron mientras tanto; vuelve a cargar movimientos", 409);
    }
    rec.movementIds = movements.map((m) => m._id);
    rec.clearedIds = cleared;
    rec.closedSummary = summary;
    rec.forceReason = summary.balanced ? "" : reason;
    rec.status = "cerrada";
    rec.closedAt = new Date();
    rec.closedBy = { userId: actor.userId as any, name: actor.name };
    await rec.save({ session });
  });
  return getReconciliation(id);
}

/** Reabre: limpia las marcas de conciliado. No si ya hay una posterior cerrada del mismo banco. */
export async function reopenReconciliation(id: string, body: Record<string, any>, actor: Actor) {
  const reason = String(body?.reason ?? "").trim();
  if (!reason) throw new CustomError("Indica el motivo para reabrir", 400);
  await runInTransaction(async (session) => {
    const rec = await findReconciliation(id, session);
    if (rec.status !== "cerrada") throw new CustomError("La conciliación ya está abierta", 409);
    const later = await BankReconciliation.exists({
      bankAccountId: rec.bankAccountId, status: "cerrada", to: { $gt: rec.to }, _id: { $ne: rec._id },
    }).session(session);
    if (later) throw new CustomError("Hay una conciliación posterior cerrada de este banco: reábrela primero", 409);
    await BankMovement.updateMany({ reconciliationId: rec._id }, { reconciledAt: null, reconciliationId: null }, { session });
    rec.status = "abierta";
    rec.closedSummary = null;
    rec.closedAt = null;
    rec.reopenLog.push({ at: new Date(), reason, name: actor.name });
    await rec.save({ session });
  });
  return getReconciliation(id);
}

/**
 * Reporte de conciliación como el del sistema actual. El saldo ajustado
 * contable es el saldo según contabilidad: lo que está en el banco y no en
 * libros (comisiones) se registra como nota de débito antes de cerrar.
 */
export async function reconciliationReport(id: string) {
  const rec = await findReconciliation(id);
  const [bank, settings] = await Promise.all([bankCore.getBankAccount(rec.bankAccountId), getSettings()]);
  const movements = await loadedMovements(rec);
  const summary = await summarize(rec, movements);
  const pending = movements.filter((m) => !m.cleared);
  const detail = (list: any[]) => ({
    items: list.map((m) => ({ _id: m._id, date: m.date, type: m.type, checkNumber: m.checkNumber, description: m.description, amount: m.amount })),
    total: list.reduce((a, m) => a + m.amount, 0),
  });
  return {
    company: settings.company,
    bankAccount: { _id: bank._id, name: bank.name, number: bank.number },
    title: rec.description,
    from: rec.from,
    to: rec.to,
    status: rec.status,
    statementBalance: summary.statementBalance,
    outstandingChecks: detail(pending.filter((m) => m.direction === "out")),
    depositsInTransit: detail(pending.filter((m) => m.direction === "in")),
    reconciledBankBalance: summary.adjustedBalance,
    accountingBalance: summary.bookBalance,
    adjustedBalance: summary.bookBalance,
    difference: summary.difference,
    message: summary.message,
    totalRecords: summary.totalRecords,
    forceReason: rec.forceReason,
    closedAt: rec.closedAt,
    closedBy: rec.closedBy,
  };
}
