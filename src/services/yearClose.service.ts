import { ClientSession } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { JournalEntry } from "../models/journalEntry.model";
import { Actor, EntryLineInput, getSettings, mappedAccount, postEntry, reverseEntry } from "./accounting.service";
import { entryMatch, sumsByAccount } from "./ledgerReports.service";
import { Settings } from "../models/settings.model";

/**
 * Cierre anual (Tapia solo cierra el año): un asiento CIERRE al 31-dic que
 * lleva a cero las cuentas 4 y 5 contra "Utilidad o pérdida del ejercicio".
 * Activo, pasivo y patrimonio no se "pasan": su saldo ya es la suma de los
 * asientos, así que el año siguiente arranca solo con ellos.
 */
const DOC_TYPE = "CIERRE_ANUAL";

function parseYear(value: unknown): number {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new CustomError("Año inválido", 400);
  return year;
}

function activeClose(year: number, session?: ClientSession) {
  return JournalEntry.findOne({
    type: "CIERRE",
    status: "contabilizado",
    "source.docType": DOC_TYPE,
    "source.docNumber": String(year),
  }).session(session ?? null).lean<any>();
}

/**
 * Mismo efecto que settingsService.lockThrough, pero dentro de la transacción:
 * el asiento y el bloqueo quedan juntos (y settings.service arrastra env/JWT).
 */
function setLock(period: string, session: ClientSession) {
  return Settings.updateOne({ _id: "main" }, { lockedThrough: period }, { session });
}

export function listCloses() {
  return JournalEntry.find({ type: "CIERRE", "source.docType": DOC_TYPE })
    .select("number date status source createdBy createdAt reversedBy totalDebit")
    .sort({ date: -1 })
    .lean();
}

export async function closeYear(body: any, actor: Actor) {
  const year = parseYear(body?.year);
  const transfer = body?.transferToRetained === true || body?.transferToRetained === "true";

  const { entry, net } = await runInTransaction(async (session) => {
    const existing = await activeClose(year, session);
    if (existing) throw new CustomError(`El año ${year} ya está cerrado (asiento ${existing.number})`, 409);
    const yearResult = await mappedAccount("yearResult", session);
    const retained = transfer ? await mappedAccount("retainedEarnings", session) : "";

    // Todo lo del año (incluye anulados y reversos: se compensan) en cuentas 4 y 5.
    const range = { $gte: new Date(Date.UTC(year, 0, 1)), $lte: new Date(Date.UTC(year + 1, 0, 1) - 1) };
    const sums = await sumsByAccount(entryMatch(range), /^[45]\./, session);
    const lines: EntryLineInput[] = [];
    let net = 0; // debe − haber de resultados: > 0 es pérdida
    for (const [code, s] of [...sums].sort(([a], [b]) => a.localeCompare(b))) {
      const balance = s.debit - s.credit;
      if (!balance) continue;
      net += balance;
      lines.push(balance > 0 ? { accountCode: code, credit: balance } : { accountCode: code, debit: -balance });
    }
    if (!lines.length) throw new CustomError(`No hay saldos en cuentas de resultados (4 y 5) en ${year}`, 400);
    const description = `Cierre del ejercicio ${year}`;
    if (net) {
      lines.push(net > 0 ? { accountCode: yearResult, debit: net } : { accountCode: yearResult, credit: -net });
      if (transfer) {
        const d = `Traslado del resultado ${year} a resultados acumulados`;
        lines.push(net > 0 ? { accountCode: yearResult, credit: net, description: d } : { accountCode: yearResult, debit: -net, description: d });
        lines.push(net > 0 ? { accountCode: retained, debit: net, description: d } : { accountCode: retained, credit: -net, description: d });
      }
    }
    for (const l of lines) l.description ||= description;

    const posted = await postEntry(
      {
        date: new Date(Date.UTC(year, 11, 31, 12)),
        type: "CIERRE",
        description,
        source: { module: "contabilidad", docType: DOC_TYPE, docNumber: String(year) },
        lines,
      },
      actor,
      session,
    );
    // Después del cierre nadie mueve el año; no se reabren meses que ya estaban bloqueados más adelante.
    const { lockedThrough } = await getSettings(session);
    if (!lockedThrough || lockedThrough < `${year}-12`) await setLock(`${year}-12`, session);
    return { entry: posted, net };
  });
  return { entry, result: -net, lockedThrough: (await getSettings()).lockedThrough };
}

/**
 * Reabre el año: reverso del asiento de cierre en la misma fecha (31-dic),
 * para que el año vuelva a sumar sus resultados. Para poder grabarlo se
 * desbloquea desde diciembre (el bloqueo es "hasta AAAA-MM", no por mes suelto).
 */
export async function reopenYear(yearParam: unknown, body: any, actor: Actor) {
  const year = parseYear(yearParam);
  const reason = String(body?.reason ?? "").trim();
  if (!reason) throw new CustomError("Indica el motivo para reabrir el año", 400);
  const close = await activeClose(year);
  if (!close) throw new CustomError(`El año ${year} no tiene un cierre vigente`, 404);

  const reversal = await runInTransaction(async (session) => {
    const { lockedThrough } = await getSettings(session);
    if (lockedThrough && lockedThrough >= `${year}-12`) await setLock(`${year}-11`, session);
    return reverseEntry(close._id, `Reapertura del año ${year}: ${reason}`, close.date, actor, session);
  });
  return { reversal, lockedThrough: (await getSettings()).lockedThrough };
}
