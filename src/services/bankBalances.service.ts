import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { BankAccount } from "../models/bankAccount.model";
import { BankMovement } from "../models/bankMovement.model";
import { JournalEntry } from "../models/journalEntry.model";
import { dayRange, parseDay, TIMEZONE } from "../utils/dates";
import * as bankCore from "./bankCore.service";

const DAY_MS = 86_400_000;

/** Hoy en Ecuador, AAAA-MM-DD (en-CA da ese formato). */
export const todayEc = () => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());

/** Fin del día indicado (o de hoy) para filtrar "hasta esa fecha" inclusive. */
export function endOf(date?: unknown): Date {
  return dayRange(undefined, date ? String(date) : todayEc())!.$lte!;
}

/**
 * Saldo contable (debe − haber) de varias cuentas a una fecha. Suma todas las
 * líneas, anuladas incluidas: el asiento de reverso ya las compensa.
 */
export async function accountingBalances(codes: string[], until: Date): Promise<Map<string, number>> {
  const rows = await JournalEntry.aggregate([
    { $match: { "lines.accountCode": { $in: codes }, date: { $lte: until } } },
    { $unwind: "$lines" },
    { $match: { "lines.accountCode": { $in: codes } } },
    { $group: { _id: "$lines.accountCode", balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } },
  ]);
  return new Map(rows.map((r) => [r._id as string, r.balance as number]));
}

/** Saldo según movimientos vigentes (entradas − salidas) por cuenta bancaria. */
export async function movementBalances(ids: Types.ObjectId[], dateFilter: Record<string, Date>) {
  const rows = await BankMovement.aggregate([
    { $match: { bankAccountId: { $in: ids }, status: "vigente", date: dateFilter } },
    {
      $group: {
        _id: "$bankAccountId",
        balance: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$amount", { $multiply: ["$amount", -1] }] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.balance as number]));
}

export async function accountingBalanceOf(accountCode: string, until: Date) {
  return (await accountingBalances([accountCode], until)).get(accountCode) ?? 0;
}

/** Saldo de una cuenta bancaria o caja: contable y según movimientos. */
export async function balanceOf(id: string, date?: unknown) {
  const bank = await bankCore.getBankAccount(id);
  const until = endOf(date);
  const [accountingBalance, movements] = await Promise.all([
    accountingBalanceOf(bank.accountCode, until),
    movementBalances([bank._id], { $lte: until }),
  ]);
  return { bankAccount: bank, date: until, accountingBalance, movementBalance: movements.get(String(bank._id)) ?? 0 };
}

/** Reporte "Saldos de Caja/Bancos" a una fecha. */
export async function cashAndBankBalances(date?: unknown) {
  const until = endOf(date);
  const banks = await BankAccount.find({ isActive: true }).sort({ kind: 1, name: 1 }).lean<any[]>();
  const [acc, mov] = await Promise.all([
    accountingBalances(banks.map((b) => b.accountCode), until),
    movementBalances(banks.map((b) => b._id), { $lte: until }),
  ]);
  const items = banks.map((b) => ({
    bankAccountId: b._id,
    kind: b.kind,
    name: b.name,
    number: b.number,
    accountCode: b.accountCode,
    accountingBalance: acc.get(b.accountCode) ?? 0,
    movementBalance: mov.get(String(b._id)) ?? 0,
  }));
  const total = items.reduce((a, i) => a + i.accountingBalance, 0);
  return { date: until, items, total };
}

/** Libro de bancos: movimientos vigentes del rango con saldo corrido desde el saldo anterior. */
export async function bankBook(id: string, query: Record<string, unknown>) {
  const bank = await bankCore.getBankAccount(id);
  if (!query.from || !query.to) throw new CustomError("Indica desde y hasta", 400);
  const from = parseDay(query.from, "fecha desde");
  const range = dayRange(query.from, query.to)!;
  const opening = (await movementBalances([bank._id], { $lt: range.$gte! })).get(String(bank._id)) ?? 0;
  const movements = await BankMovement.find({ bankAccountId: bank._id, status: "vigente", date: range })
    .sort({ date: 1, createdAt: 1 })
    .lean<any[]>();
  let balance = opening;
  const items = movements.map((m) => {
    balance += m.direction === "in" ? m.amount : -m.amount;
    return { ...m, balance };
  });
  return { bankAccount: bank, from, to: range.$lte, opening, items, closing: balance };
}

/** Cheques girados y no cobrados (sin conciliar) a una fecha, con su antigüedad. */
export async function pendingChecks(query: Record<string, unknown>) {
  const until = endOf(query.date);
  const filter: Record<string, unknown> = { type: "CHEQUE", status: "vigente", reconciledAt: null, date: { $lte: until } };
  if (query.bankAccountId) filter.bankAccountId = new Types.ObjectId(String(query.bankAccountId));
  const [checks, banks] = await Promise.all([
    BankMovement.find(filter).sort({ date: 1 }).lean<any[]>(),
    BankAccount.find().lean<any[]>(),
  ]);
  const names = new Map(banks.map((b) => [String(b._id), b.name]));
  const items = checks.map((c) => ({
    ...c,
    bankName: names.get(String(c.bankAccountId)) ?? "",
    ageDays: Math.floor((until.getTime() - c.date.getTime()) / DAY_MS),
  }));
  return { date: until, items, total: items.reduce((a, i) => a + i.amount, 0), count: items.length };
}
