import { ClientSession, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { BankAccount, IBankAccount } from "../models/bankAccount.model";
import { BankMovement, BankMovementType } from "../models/bankMovement.model";
import type { Actor } from "./accounting.service";

export interface BankMovementInput {
  bankAccountId: string | Types.ObjectId;
  date: Date;
  type: BankMovementType;
  direction: "in" | "out";
  amount: number;
  checkNumber?: string;
  partyId?: string | Types.ObjectId | null;
  beneficiary?: string;
  description?: string;
  source: { module: string; docType: string; docId: Types.ObjectId | null; docNumber: string };
  journalEntryId?: Types.ObjectId | null;
}

/** La cuenta bancaria activa con su cuenta contable (para la línea de Bancos del asiento). */
export async function getBankAccount(id: string | Types.ObjectId, session?: ClientSession) {
  const bank = await BankAccount.findById(id).session(session ?? null).lean<IBankAccount & { _id: Types.ObjectId }>();
  if (!bank || !bank.isActive) throw new CustomError("Cuenta bancaria o caja no encontrada", 404);
  return bank;
}

/**
 * Siguiente número de cheque de la cuenta (y lo reserva). Un cheque anulado
 * no libera su número: el talonario físico ya lo usó.
 */
export async function takeCheckNumber(id: string | Types.ObjectId, session: ClientSession): Promise<string> {
  const bank = await BankAccount.findOneAndUpdate({ _id: id, kind: "banco" }, { $inc: { nextCheck: 1 } }, { session });
  if (!bank) throw new CustomError("Los cheques solo salen de una cuenta bancaria", 400);
  return String(bank.nextCheck);
}

export async function recordMovement(input: BankMovementInput, actor: Actor, session: ClientSession) {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new CustomError("El valor del movimiento bancario debe ser mayor que cero (centavos)", 400);
  }
  const [mov] = await BankMovement.create(
    [{ ...input, createdBy: { userId: actor.userId, name: actor.name } }],
    { session },
  );
  return mov.toObject();
}

/** Anula los movimientos de un documento. Si ya se conciliaron, no se puede: hay que reabrir la conciliación. */
export async function voidBySource(docId: Types.ObjectId | string, session: ClientSession) {
  const reconciled = await BankMovement.countDocuments({ "source.docId": docId, status: "vigente", reconciledAt: { $ne: null } }).session(session);
  if (reconciled) throw new CustomError("El movimiento bancario ya está conciliado; reabre la conciliación primero", 409);
  await BankMovement.updateMany({ "source.docId": docId, status: "vigente" }, { status: "anulado" }, { session });
}
