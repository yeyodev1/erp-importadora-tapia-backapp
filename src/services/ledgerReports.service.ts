import { ClientSession, PipelineStage } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Account } from "../models/account.model";
import { JournalEntry } from "../models/journalEntry.model";
import { Party } from "../models/party.model";
import { dayRange, TIMEZONE } from "../utils/dates";
import { escapeRegex } from "../utils/regex";
import { sum } from "../utils/money";

/**
 * Reportes contables que salen de sumar JournalEntry.lines (no hay saldos
 * guardados ni "mayorizar"). Un asiento anulado y su reverso se compensan,
 * así que por defecto se incluyen los dos; excludeVoided=true oculta el par.
 */
export interface Sums {
  debit: number;
  credit: number;
}
type Query = Record<string, unknown>;
type DateFilter = { $gte?: Date; $lte?: Date; $lt?: Date };
type CodeMatch = string | RegExp;

export const DEBIT_MINUS_CREDIT = "saldo = debe − haber (deudor positivo, acreedor negativo)";

export const isTrue = (v: unknown) => v === true || v === "true";

/** Hoy en Ecuador como "AAAA-MM-DD". */
export function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

/** "2026-09" → primer y último instante del mes (UTC; los asientos van al mediodía). */
export function periodBounds(period: string): { start: Date; end: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new CustomError("Período inválido (AAAA-MM)", 400);
  const [y, m] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1) - 1) };
}

/** Código exacto o, si es cuenta de mayor, ella y todas sus hijas. */
export function subtreeOf(code: string): RegExp {
  return new RegExp(`^${escapeRegex(code)}(\\.|$)`);
}

export function entryMatch(date: DateFilter | null, excludeVoided = false, excludeTypes: string[] = []) {
  const m: Record<string, unknown> = {};
  if (date) m.date = date;
  if (excludeVoided) {
    m.status = "contabilizado";
    m.reversalOf = null;
  }
  if (excludeTypes.length) m.type = { $nin: excludeTypes };
  return m;
}

/** Debe y haber por cuenta de movimiento, agregados en Mongo. */
export async function sumsByAccount(
  match: Record<string, unknown>,
  codes?: CodeMatch,
  session?: ClientSession,
): Promise<Map<string, Sums>> {
  const pipeline: PipelineStage[] = [
    { $match: codes ? { ...match, "lines.accountCode": codes } : match },
    { $unwind: "$lines" },
  ];
  if (codes) pipeline.push({ $match: { "lines.accountCode": codes } });
  pipeline.push({
    $group: { _id: "$lines.accountCode", debit: { $sum: "$lines.debit" }, credit: { $sum: "$lines.credit" } },
  });
  const rows = await JournalEntry.aggregate(pipeline).session(session ?? null);
  return new Map(rows.map((r) => [r._id as string, { debit: r.debit, credit: r.credit }]));
}

/** Suma cada cuenta en todos sus ancestros (1.1.01.02.01.004 → 1, 1.1, 1.1.01, …). */
export function rollup(own: Map<string, Sums>): Map<string, Sums> {
  const out = new Map<string, Sums>();
  for (const [code, s] of own) {
    const parts = code.split(".");
    for (let i = 1; i <= parts.length; i++) {
      const key = parts.slice(0, i).join(".");
      const t = out.get(key) ?? { debit: 0, credit: 0 };
      t.debit += s.debit;
      t.credit += s.credit;
      out.set(key, t);
    }
  }
  return out;
}

export function accountsFor(filter: Record<string, unknown> = {}) {
  return Account.find(filter).sort({ code: 1 }).select("code name kind level parentCode").lean<any[]>();
}

const balanceOf = (s?: Sums) => (s ? s.debit - s.credit : 0);

/** Libro diario: asientos completos del rango, en orden. */
export async function journalBook(q: Query) {
  const match = entryMatch(dayRange(q.from, q.to), isTrue(q.excludeVoided));
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(1000, Math.max(1, Number(q.limit) || 200));
  const [items, total, totals] = await Promise.all([
    JournalEntry.find(match).sort({ date: 1, number: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    JournalEntry.countDocuments(match),
    JournalEntry.aggregate([
      { $match: match },
      { $group: { _id: null, debit: { $sum: "$totalDebit" }, credit: { $sum: "$totalCredit" } } },
    ]),
  ]);
  return {
    items,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    totalDebit: totals[0]?.debit ?? 0,
    totalCredit: totals[0]?.credit ?? 0,
  };
}

/** Libro mayor de una cuenta (si es de mayor, con todas sus hijas) con saldo anterior y saldo corrido. */
export async function ledger(q: Query) {
  const code = String(q.account ?? "").trim();
  const account = await Account.findOne({ code }).lean<any>();
  if (!account) throw new CustomError(`La cuenta ${code || "(vacía)"} no existe`, 404);
  const codes: CodeMatch = account.kind === "mayor" ? subtreeOf(code) : code;
  const range = dayRange(q.from, q.to);
  const excludeVoided = isTrue(q.excludeVoided);

  const prevSums = range?.$gte
    ? await sumsByAccount(entryMatch({ $lt: range.$gte }, excludeVoided), codes)
    : new Map<string, Sums>();
  const previousBalance = sum([...prevSums.values()].map(balanceOf));

  const rows = await JournalEntry.aggregate([
    { $match: { ...entryMatch(range, excludeVoided), "lines.accountCode": codes } },
    { $unwind: { path: "$lines", includeArrayIndex: "lineNo" } },
    { $match: { "lines.accountCode": codes } },
    { $sort: { date: 1, number: 1, lineNo: 1 } },
    { $lookup: { from: Party.collection.name, localField: "lines.partyId", foreignField: "_id", as: "party" } },
    {
      $project: {
        _id: 0,
        entryId: "$_id",
        type: 1,
        number: 1,
        date: 1,
        status: 1,
        accountCode: "$lines.accountCode",
        accountName: "$lines.accountName",
        party: { $ifNull: [{ $first: "$party.name" }, ""] },
        debit: "$lines.debit",
        credit: "$lines.credit",
        costCenter: "$lines.costCenter",
        description: { $cond: [{ $ne: ["$lines.description", ""] }, "$lines.description", "$description"] },
      },
    },
  ]);

  let running = previousBalance;
  const movements = rows.map((r) => ({ ...r, balance: (running += r.debit - r.credit) }));
  return {
    account: { code: account.code, name: account.name, kind: account.kind },
    from: q.from ?? null,
    to: q.to ?? null,
    signConvention: DEBIT_MINUS_CREDIT,
    previousBalance,
    movements,
    totalDebit: sum(movements.map((m) => m.debit)),
    totalCredit: sum(movements.map((m) => m.credit)),
    balance: running,
  };
}

/**
 * Balance de comprobación ("Reporte de saldos") de un período AAAA-MM.
 * mensual: saldo anterior = todo lo previo al mes; movimientos del mes.
 * acumulado: saldo anterior = todo lo previo al 1-ene; movimientos del 1-ene al fin del mes.
 */
export async function trialBalance(q: Query) {
  const period = String(q.period ?? todayStr().slice(0, 7));
  const mode = q.mode === "mensual" ? "mensual" : "acumulado";
  const { start, end } = periodBounds(period);
  const from = mode === "mensual" ? start : new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
  const excludeVoided = isTrue(q.excludeVoided);

  const [prevOwn, movOwn, accounts] = await Promise.all([
    sumsByAccount(entryMatch({ $lt: from }, excludeVoided)),
    sumsByAccount(entryMatch({ $gte: from, $lte: end }, excludeVoided)),
    accountsFor(q.filter === "mayor" ? { kind: "mayor" } : {}),
  ]);
  const prev = rollup(prevOwn);
  const mov = rollup(movOwn);

  const rows = accounts
    .map((a) => {
      const previous = balanceOf(prev.get(a.code));
      const debit = mov.get(a.code)?.debit ?? 0;
      const credit = mov.get(a.code)?.credit ?? 0;
      return { code: a.code, name: a.name, kind: a.kind, level: a.level, previous, debit, credit, balance: previous + debit - credit };
    })
    .filter((r) => r.previous || r.debit || r.credit || r.balance);

  // Totales desde las cuentas de movimiento: cada línea cuenta una sola vez.
  const totalDebit = sum([...movOwn.values()].map((s) => s.debit));
  const totalCredit = sum([...movOwn.values()].map((s) => s.credit));
  const totalPrevious = sum([...prevOwn.values()].map(balanceOf));
  return {
    period,
    mode,
    from: from.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    signConvention: DEBIT_MINUS_CREDIT,
    rows,
    totals: { previous: totalPrevious, debit: totalDebit, credit: totalCredit, balance: totalPrevious + totalDebit - totalCredit },
    cuadra: totalDebit === totalCredit && totalPrevious === 0,
  };
}

/** Comparativo de saldos acumulados al cierre de dos períodos AAAA-MM. */
export async function comparative(q: Query) {
  const periodA = String(q.periodA ?? "");
  const periodB = String(q.periodB ?? "");
  const a = periodBounds(periodA);
  const b = periodBounds(periodB);
  const excludeVoided = isTrue(q.excludeVoided);
  const [sa, sb, accounts] = await Promise.all([
    sumsByAccount(entryMatch({ $lte: a.end }, excludeVoided)).then(rollup),
    sumsByAccount(entryMatch({ $lte: b.end }, excludeVoided)).then(rollup),
    accountsFor(q.filter === "mayor" ? { kind: "mayor" } : {}),
  ]);
  const rows = accounts
    .map((acc) => {
      const balanceA = balanceOf(sa.get(acc.code));
      const balanceB = balanceOf(sb.get(acc.code));
      return { code: acc.code, name: acc.name, kind: acc.kind, level: acc.level, balanceA, balanceB, difference: balanceB - balanceA };
    })
    .filter((r) => r.balanceA || r.balanceB);
  return { periodA, periodB, signConvention: DEBIT_MINUS_CREDIT, rows };
}
