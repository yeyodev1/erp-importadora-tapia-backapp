import { ClientSession, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Account } from "../models/account.model";
import { JournalEntry, EntryType, IJournalEntry } from "../models/journalEntry.model";
import { Settings, ISettings, AccountMapKey } from "../models/settings.model";
import { formatCents, sum } from "../utils/money";
import * as sequenceService from "./sequence.service";

/** Quién hace la operación: va al asiento y a la trazabilidad. */
export interface Actor {
  userId: string | null;
  name: string;
}

export interface EntryLineInput {
  accountCode: string;
  debit?: number;
  credit?: number;
  costCenter?: string;
  partyId?: string | Types.ObjectId | null;
  description?: string;
}

export interface EntryInput {
  date: Date;
  type: EntryType;
  description: string;
  source?: { module: string; docType: string; docId?: Types.ObjectId | string | null; docNumber?: string };
  lines: EntryLineInput[];
}

export function periodOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export async function getSettings(session?: ClientSession): Promise<ISettings> {
  const settings = await Settings.findById("main").session(session ?? null).lean<ISettings>();
  if (!settings) throw new CustomError("Falta la configuración de la empresa", 500);
  return settings;
}

/** Cuenta del mapa contable; si no está configurada, el error dice cuál falta. */
export async function mappedAccount(key: AccountMapKey, session?: ClientSession): Promise<string> {
  const code = (await getSettings(session)).accounts?.[key];
  if (!code) throw new CustomError(`Configura la cuenta contable "${key}" en Configuración`, 400);
  return code;
}

export async function assertPeriodOpen(date: Date, session?: ClientSession): Promise<void> {
  const { lockedThrough } = await getSettings(session);
  if (lockedThrough && periodOf(date) <= lockedThrough) {
    throw new CustomError(`El período ${periodOf(date)} está cerrado. Pide a contabilidad reabrirlo.`, 409);
  }
}

/**
 * Graba un asiento. Valida que cuadre, que cada cuenta exista y sea de
 * movimiento, y que el mes esté abierto. Las líneas en cero se descartan
 * (una factura sin descuento no deja una línea de descuento vacía).
 */
export async function postEntry(
  input: EntryInput,
  actor: Actor,
  session: ClientSession,
): Promise<IJournalEntry & { _id: Types.ObjectId }> {
  const lines = input.lines
    .map((l) => ({ ...l, debit: l.debit ?? 0, credit: l.credit ?? 0 }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);

  if (lines.length < 2) throw new CustomError("El asiento necesita al menos dos líneas", 400);
  for (const l of lines) {
    if (!Number.isInteger(l.debit) || !Number.isInteger(l.credit) || l.debit < 0 || l.credit < 0) {
      throw new CustomError(`Línea inválida en ${l.accountCode}: montos en centavos positivos`, 400);
    }
    if (l.debit > 0 && l.credit > 0) {
      throw new CustomError(`La cuenta ${l.accountCode} no puede ir al debe y al haber a la vez`, 400);
    }
  }

  const totalDebit = sum(lines.map((l) => l.debit));
  const totalCredit = sum(lines.map((l) => l.credit));
  if (totalDebit !== totalCredit) {
    throw new CustomError(
      `El asiento no cuadra: debe ${formatCents(totalDebit)} y haber ${formatCents(totalCredit)}`,
      400,
    );
  }

  await assertPeriodOpen(input.date, session);

  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const accounts = await Account.find({ code: { $in: codes } }).session(session).lean<any[]>();
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  for (const code of codes) {
    const acc = byCode.get(code);
    if (!acc) throw new CustomError(`La cuenta ${code} no existe en el plan de cuentas`, 400);
    if (acc.kind !== "movimiento") throw new CustomError(`La cuenta ${code} es de mayor, no recibe movimientos`, 400);
    if (!acc.isActive) throw new CustomError(`La cuenta ${code} está inactiva`, 400);
  }

  const year = input.date.getUTCFullYear();
  const n = await sequenceService.next(`asiento-${year}`, session);

  const [entry] = await JournalEntry.create(
    [
      {
        number: `${year}-${String(n).padStart(6, "0")}`,
        date: input.date,
        period: periodOf(input.date),
        type: input.type,
        description: input.description,
        source: {
          module: input.source?.module ?? "contabilidad",
          docType: input.source?.docType ?? "",
          docId: input.source?.docId ?? null,
          docNumber: input.source?.docNumber ?? "",
        },
        lines: lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: byCode.get(l.accountCode).name,
          debit: l.debit,
          credit: l.credit,
          costCenter: l.costCenter ?? "",
          partyId: l.partyId ?? null,
          description: l.description ?? "",
        })),
        totalDebit,
        totalCredit,
        createdBy: { userId: actor.userId, name: actor.name },
      },
    ],
    { session },
  );
  return entry.toObject();
}

/**
 * Anula un asiento con su reverso (debe y haber invertidos) en la fecha
 * indicada. El original queda visible y marcado: los auditores ven ambos.
 */
export async function reverseEntry(
  entryId: string | Types.ObjectId,
  reason: string,
  date: Date,
  actor: Actor,
  session: ClientSession,
) {
  const original = await JournalEntry.findById(entryId).session(session);
  if (!original) throw new CustomError("Asiento no encontrado", 404);
  if (original.status === "anulado") throw new CustomError("Ese asiento ya está anulado", 409);

  const reversal = await postEntry(
    {
      date,
      type: "REVERSO",
      description: `Anula ${original.number}: ${reason}`,
      source: { ...original.source, docId: original.source.docId },
      lines: original.lines.map((l: any) => ({
        accountCode: l.accountCode,
        debit: l.credit,
        credit: l.debit,
        costCenter: l.costCenter,
        partyId: l.partyId,
        description: l.description,
      })),
    },
    actor,
    session,
  );

  original.status = "anulado";
  original.reversedBy = reversal._id;
  await original.save({ session });
  await JournalEntry.updateOne({ _id: reversal._id }, { reversalOf: original._id }, { session });
  return reversal;
}

/** Anula todos los asientos vivos de un documento (al anular una factura, etc.). */
export async function reverseBySource(
  docId: Types.ObjectId | string,
  reason: string,
  date: Date,
  actor: Actor,
  session: ClientSession,
) {
  const entries = await JournalEntry.find({
    "source.docId": docId,
    status: "contabilizado",
    type: { $ne: "REVERSO" },
  }).session(session);
  for (const e of entries) await reverseEntry(e._id, reason, date, actor, session);
}
