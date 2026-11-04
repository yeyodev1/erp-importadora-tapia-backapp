import { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { BankMovement, BankMovementType } from "../models/bankMovement.model";
import { BankTransaction, BANK_TRANSACTION_TYPES, BankTransactionType } from "../models/bankTransaction.model";
import { cents, sum } from "../utils/money";
import { dayRange, parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor, EntryLineInput } from "./accounting.service";
import * as bankCore from "./bankCore.service";
import * as sequenceService from "./sequence.service";

/** Lo que suma a la cuenta; el resto resta. */
const INFLOW: BankTransactionType[] = ["DEPOSITO", "NOTA_CREDITO", "INGRESO_CAJA"];
const BANK_ONLY: BankTransactionType[] = ["DEPOSITO", "NOTA_DEBITO", "NOTA_CREDITO", "CHEQUE"];
const CASH_ONLY: BankTransactionType[] = ["INGRESO_CAJA", "EGRESO_CAJA"];

const LABEL: Record<BankTransactionType, string> = {
  DEPOSITO: "DEPÓSITO",
  NOTA_DEBITO: "NOTA DE DÉBITO",
  NOTA_CREDITO: "NOTA DE CRÉDITO",
  CHEQUE: "CHEQUE",
  TRANSFERENCIA: "TRANSFERENCIA",
  INGRESO_CAJA: "INGRESO",
  EGRESO_CAJA: "EGRESO",
};

type Bank = Awaited<ReturnType<typeof bankCore.getBankAccount>>;
const ofBank = (b: Bank) => `${b.kind === "caja" ? "de" : "del"} ${b.name}`;

function parseLines(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length) throw new CustomError("Agrega al menos una línea de contrapartida", 400);
  return raw.map((l: any, i) => {
    const accountCode = String(l?.accountCode ?? "").trim();
    if (!accountCode) throw new CustomError(`Línea ${i + 1}: elige la cuenta`, 400);
    const amount = cents(l?.amount, `valor de la línea ${i + 1}`);
    if (amount <= 0) throw new CustomError(`Línea ${i + 1}: el valor debe ser mayor que cero`, 400);
    return { accountCode, amount, costCenter: String(l?.costCenter ?? ""), description: String(l?.description ?? "") };
  });
}

/** Graba la transacción, su asiento BANCO y sus movimientos bancarios en una sola transacción de Mongo. */
export async function createTransaction(body: Record<string, any>, actor: Actor, outer?: ClientSession) {
  const type = body?.type as BankTransactionType;
  if (!BANK_TRANSACTION_TYPES.includes(type)) throw new CustomError("Seleccione transacción", 400);
  const date = parseDay(body.date);
  const note = String(body.note ?? body.description ?? "").trim();
  const beneficiary = String(body.beneficiary ?? "").trim();
  if (body.partyId && !Types.ObjectId.isValid(String(body.partyId))) throw new CustomError("Persona inválida", 400);
  const partyId = body.partyId ? new Types.ObjectId(String(body.partyId)) : null;
  const isTransfer = type === "TRANSFERENCIA";
  const lines = isTransfer ? [] : parseLines(body.lines);
  const amount = isTransfer ? cents(body.amount, "valor") : sum(lines.map((l) => l.amount));
  if (amount <= 0) throw new CustomError("El valor debe ser mayor que cero", 400);
  if (type === "CHEQUE" && !beneficiary) throw new CustomError("El cheque necesita beneficiario", 400);

  const work = async (session: ClientSession) => {
    if (!body.bankAccountId) throw new CustomError("Seleccione banco", 400);
    const bank = await bankCore.getBankAccount(String(body.bankAccountId), session);
    if (BANK_ONLY.includes(type) && bank.kind !== "banco") throw new CustomError(`${LABEL[type]} solo en cuentas bancarias`, 400);
    if (CASH_ONLY.includes(type) && bank.kind !== "caja") throw new CustomError(`${LABEL[type]} solo en cajas`, 400);
    const target = isTransfer ? await bankCore.getBankAccount(String(body.targetBankAccountId ?? ""), session) : null;
    if (target && String(target._id) === String(bank._id)) throw new CustomError("La cuenta destino debe ser otra", 400);

    // Reposición de caja chica o pago a otra cuenta propia con cheque.
    const byCheck = type === "CHEQUE" || (isTransfer && body.byCheck === true);
    const checkNumber = byCheck ? await bankCore.takeCheckNumber(bank._id, session) : "";
    const head = byCheck ? `CHEQUE # ${checkNumber} ${ofBank(bank)}` : `${LABEL[type]} ${ofBank(bank)}`;
    const who = beneficiary || (target && byCheck ? target.name : "");
    const description = [target && !byCheck ? `${head} a ${target.name}` : head, who, note].filter(Boolean).join(" - ");

    const _id = new Types.ObjectId();
    const number = String(await sequenceService.next("bank-transaction", session)).padStart(6, "0");
    const source = { module: "bancos", docType: type, docId: _id, docNumber: number };
    const inflow = INFLOW.includes(type);
    const entryLines: EntryLineInput[] = target
      ? [
          { accountCode: target.accountCode, debit: amount, description },
          { accountCode: bank.accountCode, credit: amount, description },
        ]
      : [
          { accountCode: bank.accountCode, [inflow ? "debit" : "credit"]: amount, partyId, description },
          ...lines.map((l) => ({
            accountCode: l.accountCode,
            [inflow ? "credit" : "debit"]: l.amount,
            costCenter: l.costCenter,
            partyId,
            description: l.description || description,
          })),
        ];
    const entry = await accounting.postEntry({ date, type: "BANCO", description, source, lines: entryLines }, actor, session);

    const base = { date, amount, partyId, beneficiary: who, description, source, journalEntryId: entry._id };
    const outType: BankMovementType = byCheck ? "CHEQUE" : isTransfer ? "TRANSFERENCIA" : type;
    await bankCore.recordMovement(
      { ...base, bankAccountId: bank._id, type: outType, direction: target || !inflow ? "out" : "in", checkNumber },
      actor,
      session,
    );
    if (target) {
      // Efectivo de caja depositado en el banco: en el estado de cuenta sale como depósito.
      const inType: BankMovementType = bank.kind === "caja" && target.kind === "banco" ? "DEPOSITO" : "TRANSFERENCIA";
      await bankCore.recordMovement({ ...base, bankAccountId: target._id, type: inType, direction: "in" }, actor, session);
    }

    const [tx] = await BankTransaction.create(
      [
        {
          _id, number, type, date, bankAccountId: bank._id, targetBankAccountId: target?._id ?? null,
          checkNumber, partyId, beneficiary: who, description, amount, lines, journalEntryId: entry._id,
          createdBy: { userId: actor.userId, name: actor.name },
        },
      ],
      { session },
    );
    return tx.toObject();
  };
  return outer ? work(outer) : runInTransaction(work);
}

/**
 * Anula: movimientos bancarios (falla si ya están conciliados) + reverso del
 * asiento. El reverso va, por defecto, en la fecha del documento para que el
 * libro de bancos y la contabilidad sigan diciendo lo mismo en ese mes.
 */
export async function voidTransaction(id: string, body: Record<string, any>, actor: Actor) {
  const reason = String(body?.reason ?? "").trim();
  if (!reason) throw new CustomError("Indica el motivo de la anulación", 400);
  return runInTransaction(async (session) => {
    const tx = await BankTransaction.findById(id).session(session);
    if (!tx) throw new CustomError("Transacción bancaria no encontrada", 404);
    if (tx.status === "anulado") throw new CustomError("La transacción ya está anulada", 409);
    const date = body?.date ? parseDay(body.date) : tx.date;
    await bankCore.voidBySource(tx._id, session);
    await accounting.reverseBySource(tx._id, reason, date, actor, session);
    tx.status = "anulado";
    tx.voidReason = reason;
    tx.voidedAt = new Date();
    await tx.save({ session });
    return tx.toObject();
  });
}

export async function listTransactions(query: Record<string, unknown>) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const filter: Record<string, unknown> = {};
  if (query.bankAccountId) filter.bankAccountId = String(query.bankAccountId);
  if (query.type) filter.type = String(query.type);
  if (query.status) filter.status = String(query.status);
  const range = dayRange(query.from, query.to);
  if (range) filter.date = range;
  const [items, total] = await Promise.all([
    BankTransaction.find(filter).sort({ date: -1, number: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    BankTransaction.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getTransaction(id: string) {
  const tx = await BankTransaction.findById(id).lean();
  if (!tx) throw new CustomError("Transacción bancaria no encontrada", 404);
  const movements = await BankMovement.find({ "source.docId": id }).lean();
  return { ...tx, movements };
}
