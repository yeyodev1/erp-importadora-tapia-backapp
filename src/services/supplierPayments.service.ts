import { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { Party } from "../models/party.model";
import { PaymentApproval } from "../models/paymentApproval.model";
import { PayableTransaction, PayableTxKind } from "../models/payableTransaction.model";
import { cents, formatCents, sum } from "../utils/money";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import * as bankCore from "./bankCore.service";
import * as sequenceService from "./sequence.service";
import { applyToInvoices, docDate, parseLines, unapply } from "./payables.service";

/**
 * Lo que sale o vuelve al banco desde Cuentas por pagar: ejecución de pagos
 * aprobados, anticipos (a proveedor o a empleado), cruces y devoluciones.
 */
const METHODS = ["CHEQUE", "TRANSFERENCIA"] as const;

async function nextNumber(kind: PayableTxKind, session: ClientSession) {
  return `${kind.toUpperCase()}-${String(await sequenceService.next(`cxp-${kind}`, session)).padStart(6, "0")}`;
}

/** Sale dinero del banco: toma número de cheque si aplica. */
async function bankOut(body: any, session: ClientSession) {
  const method = String(body?.method ?? "").toUpperCase();
  if (!METHODS.includes(method as any)) throw new CustomError("Medio de pago: CHEQUE o TRANSFERENCIA", 400);
  const bank = await bankCore.getBankAccount(body?.bankAccountId, session);
  const checkNumber = method === "CHEQUE" ? await bankCore.takeCheckNumber(bank._id, session) : "";
  return { bank, method: method as (typeof METHODS)[number], checkNumber };
}

async function getParty(id: unknown, session: ClientSession) {
  const party = await Party.findById(id).session(session).lean<any>();
  if (!party) throw new CustomError("Beneficiario no encontrado", 404);
  return party;
}

/** Ejecuta una o más aprobaciones pendientes del mismo beneficiario. Asiento PAGO: Proveedores / Banco. */
export async function executePayment(body: any, actor: Actor) {
  const ids: string[] = Array.isArray(body?.approvalIds) ? body.approvalIds.map(String) : [];
  if (!ids.length) throw new CustomError("Elige las aprobaciones a pagar", 400);
  const date = docDate(body?.date);
  return runInTransaction(async (session) => {
    const approvals = await PaymentApproval.find({ _id: { $in: ids } }).session(session);
    if (approvals.length !== new Set(ids).size) throw new CustomError("Aprobación no encontrada", 404);
    if (approvals.some((a) => a.status !== "pendiente")) throw new CustomError("Hay aprobaciones ya pagadas o anuladas", 409);
    const beneficiaryId = String(approvals[0].beneficiaryId);
    if (approvals.some((a) => String(a.beneficiaryId) !== beneficiaryId)) {
      throw new CustomError("Las aprobaciones de un pago deben ser del mismo beneficiario", 400);
    }
    const party = await getParty(beneficiaryId, session);
    const { bank, method, checkNumber } = await bankOut(body, session);
    const _id = new Types.ObjectId();
    const number = await nextNumber("pago", session);

    // Varias aprobaciones pueden tocar la misma factura: se suman antes de abonar.
    const byInvoice = new Map<string, number>();
    for (const a of approvals) for (const l of a.lines) byInvoice.set(String(l.invoiceId), (byInvoice.get(String(l.invoiceId)) ?? 0) + l.amount);
    const lines = await applyToInvoices(
      [...byInvoice].map(([invoiceId, amount]) => ({ invoiceId, amount })),
      "pago", _id, date, session, true,
    );
    const amount = sum(lines.map((l) => l.amount));
    const source = { module: "cxp", docType: "PAGO_PROVEEDOR", docId: _id, docNumber: number };
    const suppliers = await accounting.mappedAccount("suppliers", session);
    const description = `${method === "CHEQUE" ? `Cheque # ${checkNumber}` : "Transferencia"} ${bank.name} a ${party.name}`;
    const entry = await accounting.postEntry(
      {
        date, type: "PAGO", description, source,
        lines: [
          ...lines.map((l) => ({ accountCode: suppliers, debit: l.amount, partyId: l.supplierId })),
          { accountCode: bank.accountCode, credit: amount, partyId: party._id },
        ],
      },
      actor, session,
    );
    await bankCore.recordMovement(
      { bankAccountId: bank._id, date, type: method, direction: "out", amount, checkNumber, partyId: party._id, beneficiary: party.name, description, source, journalEntryId: entry._id },
      actor, session,
    );
    await PaymentApproval.updateMany({ _id: { $in: ids } }, { status: "pagada", paymentId: _id }, { session });
    const [doc] = await PayableTransaction.create(
      [{ _id, kind: "pago", number, date, partyId: party._id, bankAccountId: bank._id, method, checkNumber, amount, lines, approvalIds: ids, description, journalEntryId: entry._id, createdBy: actor }],
      { session },
    );
    return doc.toObject();
  });
}

/** Anticipo sin factura (a proveedor o al empleado que compra a varios). Asiento: Anticipos / Banco. */
export async function createAdvance(body: any, actor: Actor) {
  const amount = cents(body?.amount, "valor del anticipo");
  if (amount <= 0) throw new CustomError("El anticipo debe ser mayor que cero", 400);
  const date = docDate(body?.date);
  return runInTransaction(async (session) => {
    const party = await getParty(body?.partyId, session);
    if (!party.isSupplier && !party.isEmployee) throw new CustomError("El anticipo es para un proveedor o un empleado", 400);
    const { bank, method, checkNumber } = await bankOut(body, session);
    const _id = new Types.ObjectId();
    const number = await nextNumber("anticipo", session);
    const source = { module: "cxp", docType: "ANTICIPO_PROVEEDOR", docId: _id, docNumber: number };
    const description = String(body?.description || `Anticipo a ${party.name} (${method === "CHEQUE" ? `cheque # ${checkNumber}` : "transferencia"})`);
    const entry = await accounting.postEntry(
      {
        date, type: "ANTICIPO", description, source,
        lines: [
          { accountCode: await accounting.mappedAccount("supplierAdvances", session), debit: amount, partyId: party._id },
          { accountCode: bank.accountCode, credit: amount, partyId: party._id },
        ],
      },
      actor, session,
    );
    await bankCore.recordMovement(
      { bankAccountId: bank._id, date, type: method, direction: "out", amount, checkNumber, partyId: party._id, beneficiary: party.name, description, source, journalEntryId: entry._id },
      actor, session,
    );
    const [doc] = await PayableTransaction.create(
      [{ _id, kind: "anticipo", number, date, partyId: party._id, bankAccountId: bank._id, method, checkNumber, amount, description, journalEntryId: entry._id, createdBy: actor }],
      { session },
    );
    return doc.toObject();
  });
}

/** Reserva `amount` del saldo del anticipo; nunca lo deja negativo. */
async function takeFromAdvance(advanceId: string, amount: number, session: ClientSession) {
  const advance = await PayableTransaction.findById(advanceId).session(session);
  if (!advance || advance.kind !== "anticipo" || advance.status !== "vigente") throw new CustomError("Anticipo no encontrado o anulado", 404);
  const open = advance.amount - advance.applied;
  if (amount > open) throw new CustomError(`El anticipo ${advance.number} solo tiene ${formatCents(open)} por aplicar`, 409);
  advance.applied += amount;
  await advance.save({ session });
  return advance;
}

/** Cruza un anticipo contra facturas de uno o varios proveedores. Asiento: Proveedores / Anticipos. */
export async function crossAdvance(advanceId: string, body: any, actor: Actor) {
  const lines = parseLines(body?.lines);
  const date = docDate(body?.date);
  return runInTransaction(async (session) => {
    const amount = sum(lines.map((l) => l.amount));
    const advance = await takeFromAdvance(advanceId, amount, session);
    if (date < advance.date) throw new CustomError("El cruce no puede ser anterior al anticipo", 400);
    const _id = new Types.ObjectId();
    const number = await nextNumber("cruce", session);
    const applied = await applyToInvoices(lines, "anticipo", _id, date, session);
    const source = { module: "cxp", docType: "CRUCE_ANTICIPO", docId: _id, docNumber: number };
    const suppliers = await accounting.mappedAccount("suppliers", session);
    const entry = await accounting.postEntry(
      {
        date, type: "ANTICIPO", description: `Cruce del anticipo ${advance.number}`, source,
        lines: [
          ...applied.map((l) => ({ accountCode: suppliers, debit: l.amount, partyId: l.supplierId })),
          { accountCode: await accounting.mappedAccount("supplierAdvances", session), credit: amount, partyId: advance.partyId },
        ],
      },
      actor, session,
    );
    const [doc] = await PayableTransaction.create(
      [{ _id, kind: "cruce", number, date, partyId: advance.partyId, amount, lines: applied, advanceId: advance._id, description: String(body?.description ?? ""), journalEntryId: entry._id, createdBy: actor }],
      { session },
    );
    return doc.toObject();
  });
}

/** El sobrante del anticipo depositado en el banco. Asiento: Banco / Anticipos + movimiento "in". */
export async function refundAdvance(advanceId: string, body: any, actor: Actor) {
  const amount = cents(body?.amount, "valor devuelto");
  if (amount <= 0) throw new CustomError("La devolución debe ser mayor que cero", 400);
  const date = docDate(body?.date);
  return runInTransaction(async (session) => {
    const advance = await takeFromAdvance(advanceId, amount, session);
    const party = await getParty(advance.partyId, session);
    const bank = await bankCore.getBankAccount(body?.bankAccountId, session);
    const _id = new Types.ObjectId();
    const number = await nextNumber("devolucion", session);
    const source = { module: "cxp", docType: "DEVOLUCION_ANTICIPO", docId: _id, docNumber: number };
    const description = `Devolución del anticipo ${advance.number} de ${party.name}`;
    const entry = await accounting.postEntry(
      {
        date, type: "ANTICIPO", description, source,
        lines: [
          { accountCode: bank.accountCode, debit: amount, partyId: party._id },
          { accountCode: await accounting.mappedAccount("supplierAdvances", session), credit: amount, partyId: party._id },
        ],
      },
      actor, session,
    );
    await bankCore.recordMovement(
      { bankAccountId: bank._id, date, type: "DEPOSITO", direction: "in", amount, partyId: party._id, beneficiary: party.name, description, source, journalEntryId: entry._id },
      actor, session,
    );
    const [doc] = await PayableTransaction.create(
      [{ _id, kind: "devolucion", number, date, partyId: party._id, bankAccountId: bank._id, method: "DEPOSITO", amount, advanceId: advance._id, description, journalEntryId: entry._id, createdBy: actor }],
      { session },
    );
    return doc.toObject();
  });
}

/**
 * Anula un pago (reabre el saldo de las facturas; sus aprobaciones quedan
 * anuladas), un anticipo sin aplicar, un cruce o una devolución.
 */
export async function voidTransaction(id: string, body: any, actor: Actor) {
  const reason = String(body?.reason ?? "").trim();
  if (!reason) throw new CustomError("Indica el motivo de la anulación", 400);
  const date = docDate(body?.date);
  return runInTransaction(async (session) => {
    const tx = await PayableTransaction.findById(id).session(session);
    if (!tx) throw new CustomError("Movimiento no encontrado", 404);
    if (tx.status === "anulado") throw new CustomError("Ya está anulado", 409);
    if (tx.kind === "anticipo" && tx.applied > 0) throw new CustomError("El anticipo tiene cruces o devoluciones; anúlalos primero", 409);
    await bankCore.voidBySource(tx._id, session);
    await accounting.reverseBySource(tx._id, reason, date, actor, session);
    await unapply(tx._id, session);
    if (tx.kind === "pago") await PaymentApproval.updateMany({ _id: { $in: tx.approvalIds } }, { status: "anulada" }, { session });
    if (tx.advanceId) await PayableTransaction.updateOne({ _id: tx.advanceId }, { $inc: { applied: -tx.amount } }, { session });
    tx.status = "anulado";
    tx.voidReason = reason;
    await tx.save({ session });
    return tx.toObject();
  });
}

export async function listTransactions(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  if (query.kind) filter.kind = query.kind;
  if (query.partyId) filter.partyId = query.partyId;
  if (query.advanceId) filter.advanceId = query.advanceId;
  filter.status = query.status ?? "vigente";
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const [items, total] = await Promise.all([
    PayableTransaction.find(filter).sort({ date: -1, number: -1 }).skip((page - 1) * limit).limit(limit).populate("partyId", "name identification").lean(),
    PayableTransaction.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}
