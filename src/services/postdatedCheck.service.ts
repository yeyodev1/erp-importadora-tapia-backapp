import { ClientSession } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { runInTransaction } from "../config/transaction";
import { CustomerReceipt, CheckStatus } from "../models/customerReceipt.model";
import { dayRange, parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import * as bankCore from "./bankCore.service";
import { reverseAr } from "./arLedger.service";
import { oid, requireText, todayEc } from "./salesCommon.service";

/**
 * Cheques posfechados recibidos (viven en el cobro). Recorrido:
 * en_cartera (Cheques posfechados) → depositar (Debe Depósitos en tránsito /
 * Haber Cheques posfechados) → acreditar (Debe Banco / Haber Depósitos en
 * tránsito + movimiento bancario). Devuelto: Debe Clientes contra la cuenta
 * donde esté el cheque y reabre el saldo de las facturas.
 */
export function listChecks(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = { method: "CHEQUE_POSFECHADO", status: "vigente" };
  filter["check.status"] = query.status ? String(query.status) : { $in: ["en_cartera", "depositado"] };
  const range = dayRange(query.from, query.to);
  if (range) filter["check.dueDate"] = range;
  if (query.partyId) filter.partyId = oid(query.partyId, "cliente");
  return CustomerReceipt.find(filter).populate("partyId", "name identification").sort({ "check.dueDate": 1 }).lean();
}

async function step(id: string, from: CheckStatus[], body: { date?: string }, fn: (r: any, date: Date, s: ClientSession) => Promise<void>) {
  const date = parseDay(body.date ?? todayEc());
  return runInTransaction(async (session) => {
    const receipt = await CustomerReceipt.findById(oid(id, "cheque")).session(session);
    if (!receipt || receipt.method !== "CHEQUE_POSFECHADO") throw new CustomError("Cheque posfechado no encontrado", 404);
    if (receipt.status === "anulado") throw new CustomError("El cobro del cheque está anulado", 409);
    if (!from.includes(receipt.check.status)) throw new CustomError(`El cheque está ${receipt.check.status}`, 409);
    if (date < receipt.date) throw new CustomError("La fecha no puede ser anterior al cobro", 400);
    await fn(receipt, date, session);
    await receipt.save({ session });
    return receipt.toObject();
  });
}

const sourceOf = (r: any) => ({ module: "cartera", docType: "CHEQUE_POSFECHADO", docId: r._id, docNumber: r.number });

export function depositCheck(id: string, body: { date?: string; bankAccountId?: string }, actor: Actor) {
  return step(id, ["en_cartera"], body, async (r, date, session) => {
    const bank = await bankCore.getBankAccount(oid(body.bankAccountId, "banco del depósito"), session);
    if (bank.kind !== "banco") throw new CustomError("El cheque se deposita en una cuenta bancaria", 400);
    await accounting.postEntry(
      {
        date, type: "CHEQUE_POSFECHADO", description: `Depósito cheque ${r.check.number} ${r.check.bank} (${r.number}) en ${bank.name}`, source: sourceOf(r),
        lines: [
          { accountCode: await accounting.mappedAccount("depositsInTransit", session), debit: r.amount, partyId: r.partyId },
          { accountCode: await accounting.mappedAccount("postdatedChecks", session), credit: r.amount, partyId: r.partyId },
        ],
      },
      actor,
      session,
    );
    r.bankAccountId = bank._id;
    r.check.status = "depositado";
    r.check.depositedAt = date;
  });
}

export function confirmCheck(id: string, body: { date?: string }, actor: Actor) {
  return step(id, ["depositado"], body, async (r, date, session) => {
    const bank = await bankCore.getBankAccount(r.bankAccountId, session);
    const description = `Acreditación cheque ${r.check.number} ${r.check.bank} (${r.number})`;
    const entry = await accounting.postEntry(
      {
        date, type: "CHEQUE_POSFECHADO", description, source: sourceOf(r),
        lines: [
          { accountCode: bank.accountCode, debit: r.amount, partyId: r.partyId },
          { accountCode: await accounting.mappedAccount("depositsInTransit", session), credit: r.amount, partyId: r.partyId },
        ],
      },
      actor,
      session,
    );
    await bankCore.recordMovement(
      { bankAccountId: bank._id, date, type: "DEPOSITO", direction: "in", amount: r.amount, checkNumber: r.check.number, partyId: r.partyId, description, source: sourceOf(r), journalEntryId: entry._id },
      actor,
      session,
    );
    r.check.status = "acreditado";
    r.check.creditedAt = date;
  });
}

/** Cheque protestado o devuelto al cliente: la deuda vuelve a Clientes y las facturas recuperan su saldo. */
export function returnCheck(id: string, body: { date?: string; reason?: string }, actor: Actor) {
  const reason = requireText(body.reason, "el motivo de la devolución");
  return step(id, ["en_cartera", "depositado", "acreditado"], body, async (r, date, session) => {
    const where = r.check.status as CheckStatus;
    const bank = where === "acreditado" ? await bankCore.getBankAccount(r.bankAccountId, session) : null;
    const creditAccount = bank
      ? bank.accountCode
      : await accounting.mappedAccount(where === "depositado" ? "depositsInTransit" : "postdatedChecks", session);
    const description = `Cheque devuelto ${r.check.number} ${r.check.bank} (${r.number}): ${reason}`;
    const entry = await accounting.postEntry(
      {
        date, type: "CHEQUE_POSFECHADO", description, source: sourceOf(r),
        lines: [
          { accountCode: await accounting.mappedAccount("customers", session), debit: r.amount, partyId: r.partyId },
          { accountCode: creditAccount, credit: r.amount, partyId: r.partyId },
        ],
      },
      actor,
      session,
    );
    if (bank) {
      await bankCore.recordMovement(
        { bankAccountId: bank._id, date, type: "NOTA_DEBITO", direction: "out", amount: r.amount, checkNumber: r.check.number, partyId: r.partyId, description, source: sourceOf(r), journalEntryId: entry._id },
        actor,
        session,
      );
    }
    await reverseAr(r._id, date, description, session, "CHEQUE_DEVUELTO");
    r.check.status = "devuelto";
    r.check.returnedAt = date;
    r.check.returnReason = reason;
  });
}
