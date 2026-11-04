import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { runInTransaction } from "../config/transaction";
import { SalesInvoice } from "../models/salesInvoice.model";
import { CustomerReceipt, RECEIPT_METHODS, ReceiptMethod } from "../models/customerReceipt.model";
import { cents, formatCents, sum } from "../utils/money";
import { dayRange, parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import * as bankCore from "./bankCore.service";
import * as sequence from "./sequence.service";
import { addAr, reverseAr } from "./arLedger.service";
import { customerOf, oid, paginate, requireText, todayEc } from "./salesCommon.service";

/**
 * Cobro de un cliente aplicado a una o varias de sus facturas.
 * Depósito/transferencia → banco; efectivo → caja; cheque posfechado →
 * cuenta Cheques posfechados hasta que se deposite (postdatedCheck.service).
 * Asiento COBRO: Debe banco/caja/posfechados, Haber Clientes.
 */
export interface ReceiptBody {
  partyId: unknown;
  date: unknown;
  method: ReceiptMethod;
  bankAccountId?: unknown;
  reference?: string;
  amount: unknown;
  applications: { invoiceId: unknown; amount: unknown }[];
  check?: { number?: string; bank?: string; dueDate?: unknown };
  notes?: string;
}

export async function createReceipt(body: ReceiptBody, actor: Actor) {
  if (!RECEIPT_METHODS.includes(body.method)) throw new CustomError(`Medio de cobro: ${RECEIPT_METHODS.join(", ")}`, 400);
  const date = parseDay(body.date);
  const amount = cents(body.amount, "valor del cobro");
  if (amount <= 0) throw new CustomError("El cobro debe ser mayor que cero", 400);
  if (!Array.isArray(body.applications) || body.applications.length === 0) {
    throw new CustomError("Indica a qué facturas se aplica el cobro", 400);
  }
  const apps = body.applications.map((a) => ({ invoiceId: oid(a.invoiceId, "factura"), amount: cents(a.amount, "abono") }));
  if (apps.some((a) => a.amount <= 0)) throw new CustomError("Cada abono debe ser mayor que cero", 400);
  if (new Set(apps.map((a) => String(a.invoiceId))).size !== apps.length) throw new CustomError("Una factura aparece dos veces en el cobro", 400);
  // shortcut: sin anticipos; un cobro mayor a lo aplicado se registra como anticipo cuando exista ese flujo.
  if (sum(apps.map((a) => a.amount)) !== amount) throw new CustomError("La suma de los abonos debe ser igual al valor del cobro", 400);

  const isCheck = body.method === "CHEQUE_POSFECHADO";
  const check = isCheck
    ? {
        number: requireText(body.check?.number, "el número del cheque"),
        bank: requireText(body.check?.bank, "el banco del cheque"),
        dueDate: parseDay(body.check?.dueDate, "fecha de cobro del cheque"),
        status: "en_cartera",
      }
    : undefined;

  return runInTransaction(async (session) => {
    const { party } = await customerOf(body.partyId, session);
    const applications = [];
    for (const a of apps) {
      const inv = await SalesInvoice.findById(a.invoiceId).session(session).lean<any>();
      if (!inv || inv.status !== "vigente") throw new CustomError("Factura no encontrada o anulada", 404);
      if (String(inv.partyId) !== String(party._id)) throw new CustomError(`La factura ${inv.number} es de otro cliente`, 400);
      if (inv.date > date) throw new CustomError(`El cobro no puede ser anterior a la factura ${inv.number}`, 400);
      if (a.amount > inv.balance) {
        throw new CustomError(`El abono a ${inv.number} (${formatCents(a.amount)}) supera su saldo (${formatCents(inv.balance)})`, 409);
      }
      applications.push({ invoiceId: inv._id, invoiceNumber: inv.number, amount: a.amount });
    }

    let bank: Awaited<ReturnType<typeof bankCore.getBankAccount>> | null = null;
    if (!isCheck) {
      bank = await bankCore.getBankAccount(oid(body.bankAccountId, "cuenta bancaria o caja"), session);
      const wants = body.method === "EFECTIVO" ? "caja" : "banco";
      if (bank.kind !== wants) throw new CustomError(`${body.method} va a una cuenta de tipo ${wants}`, 400);
    }
    const debitAccount = bank ? bank.accountCode : await accounting.mappedAccount("postdatedChecks", session);

    const number = `COB-${sequence.pad9(await sequence.next("cobro", session))}`;
    const _id = new Types.ObjectId();
    const source = { module: "cartera", docType: "COBRO", docId: _id, docNumber: number };
    const description = `Cobro ${number} ${party.name}: ${applications.map((a) => a.invoiceNumber).join(", ")}`;
    const entry = await accounting.postEntry(
      {
        date, type: "COBRO", description, source,
        lines: [
          { accountCode: debitAccount, debit: amount, partyId: party._id },
          { accountCode: await accounting.mappedAccount("customers", session), credit: amount, partyId: party._id },
        ],
      },
      actor,
      session,
    );
    if (bank) {
      await bankCore.recordMovement(
        {
          bankAccountId: bank._id, date, type: body.method === "EFECTIVO" ? "INGRESO_CAJA" : (body.method as "DEPOSITO" | "TRANSFERENCIA"),
          direction: "in", amount, partyId: party._id, beneficiary: party.name, description, source, journalEntryId: entry._id,
        },
        actor,
        session,
      );
    }
    const [receipt] = await CustomerReceipt.create(
      [{
        _id, number, date, partyId: party._id, method: body.method, bankAccountId: bank?._id ?? null,
        reference: body.reference ?? "", amount, applications, ...(check ? { check } : {}), notes: body.notes ?? "",
        journalEntryId: entry._id, createdBy: actor,
      }],
      { session },
    );
    for (const a of applications) {
      await addAr(
        { invoiceId: a.invoiceId, partyId: party._id, date, kind: "COBRO", amount: -a.amount, description: `${body.method} ${number}${check ? ` cheque ${check.number} ${check.bank}` : ""}`, source: { docType: "COBRO", docId: _id, docNumber: number } },
        session,
      );
    }
    return receipt.toObject();
  });
}

/** Anula el cobro: reverso de todos sus asientos (también los del cheque), del movimiento bancario y de la cartera. */
export async function voidReceipt(id: string, body: { reason?: string; date?: string }, actor: Actor) {
  const reason = requireText(body.reason, "el motivo de anulación");
  const date = parseDay(body.date ?? todayEc());
  return runInTransaction(async (session) => {
    const receipt = await CustomerReceipt.findById(oid(id, "cobro")).session(session);
    if (!receipt) throw new CustomError("Cobro no encontrado", 404);
    if (receipt.status === "anulado") throw new CustomError("El cobro ya está anulado", 409);
    if (receipt.check?.status === "devuelto") throw new CustomError("El cheque ya fue devuelto: su saldo ya se reabrió", 409);
    if (date < receipt.date) throw new CustomError("La anulación no puede ser anterior al cobro", 400);
    await accounting.reverseBySource(receipt._id, reason, date, actor, session);
    await bankCore.voidBySource(receipt._id, session);
    await reverseAr(receipt._id, date, `Anulación cobro ${receipt.number}`, session);
    receipt.status = "anulado";
    receipt.voidReason = reason;
    await receipt.save({ session });
    return receipt.toObject();
  });
}

export function listReceipts(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  const range = dayRange(query.from, query.to);
  if (range) filter.date = range;
  if (query.partyId) filter.partyId = oid(query.partyId, "cliente");
  if (query.method) filter.method = String(query.method);
  if (query.status) filter.status = String(query.status);
  if (query.invoiceId) filter["applications.invoiceId"] = oid(query.invoiceId, "factura");
  return paginate(CustomerReceipt, filter, query, ["number", "reference", "check.number", "applications.invoiceNumber"]);
}

export async function getReceipt(id: string) {
  const receipt = await CustomerReceipt.findById(oid(id, "cobro")).lean();
  if (!receipt) throw new CustomError("Cobro no encontrado", 404);
  return receipt;
}
