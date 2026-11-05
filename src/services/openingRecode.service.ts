import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { Account } from "../models/account.model";
import { ImportBatch } from "../models/importBatch.model";
import { JournalEntry } from "../models/journalEntry.model";
import { assertPeriodOpen, type Actor } from "./accounting.service";
import { requireText } from "./salesCommon.service";

/**
 * Al cambiar el plan de ejemplo por el real: pasa los saldos iniciales
 * migrados de una cuenta a otra. Solo asientos de migración (su documento no
 * guarda la cuenta); lo de otros módulos se corrige con un comprobante de
 * reclasificación. Queda anotado en el lote de importación.
 */
export async function recodeOpening(body: any, actor: Actor) {
  const from = String(body?.from ?? "").trim();
  const to = String(body?.to ?? "").trim();
  const reason = requireText(body?.reason, "el motivo");
  if (!from || !to || from === to) throw new CustomError("Indica la cuenta de origen y una de destino distinta", 400);

  return runInTransaction(async (session) => {
    const target = await Account.findOne({ code: to }).session(session).lean<any>();
    if (!target || target.kind !== "movimiento") throw new CustomError(`La cuenta ${to} no existe o no es de movimiento`, 400);
    const entries = await JournalEntry.find({ "lines.accountCode": from }).session(session).select("number date source").lean<any[]>();
    if (!entries.length) throw new CustomError(`La cuenta ${from} no tiene asientos`, 404);
    const other = entries.find((e) => e.source?.module !== "migracion");
    if (other) throw new CustomError(`La cuenta ${from} tiene el asiento ${other.number} de otro módulo: corrígelo con un comprobante de reclasificación`, 409);
    for (const e of entries) await assertPeriodOpen(e.date, session);

    await JournalEntry.updateMany(
      { _id: { $in: entries.map((e) => e._id) } },
      { $set: { "lines.$[l].accountCode": to, "lines.$[l].accountName": target.name } },
      { arrayFilters: [{ "l.accountCode": from }], session },
    );
    const note = `Saldos iniciales de la cuenta ${from} pasados a ${to} ${target.name} (${entries.map((e) => e.number).join(", ")}) por ${actor.name}: ${reason}`;
    await ImportBatch.updateMany({ _id: { $in: entries.map((e) => e.source?.docId) } }, { $push: { warnings: note } }, { session });
    return { from, to, entries: entries.map((e) => e.number), note };
  });
}
