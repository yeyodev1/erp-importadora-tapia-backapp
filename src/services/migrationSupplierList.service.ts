import { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { ImportBatch, IRestore } from "../models/importBatch.model";
import { Party } from "../models/party.model";
import type { Actor } from "./accounting.service";
import { fillBlanks, nextBatchNumber } from "./migrationMacio.service";
import { idProblem, idTypeOf, norm } from "./migrationRules.service";
import { todayEc } from "./salesCommon.service";
import { parseDay } from "../utils/dates";

/**
 * "Listado de proveedores" de Macio en Excel (el front lo lee y manda las
 * filas): cada RUC pasa a tercero proveedor. Si ya existe (por ejemplo como
 * cliente) se marca proveedor y se completan sus datos vacíos; se puede
 * quitar con "Quitar datos importados" como cualquier importación.
 */
export interface SupplierRow {
  line: number;
  name: string;
  identification: string;
  address: string;
  phone: string;
  email: string;
}

const clean = (r: any): SupplierRow => ({
  line: Number(r?.line) || 0,
  name: norm(r?.name),
  identification: String(r?.identification ?? "").replace(/\s+/g, ""),
  address: String(r?.address ?? "").trim(),
  // Macio pone 999999999 cuando no hay teléfono.
  phone: String(r?.phone ?? "").replace(/^[\s9-]*$/, "").replace(/[\s-]+$/, "").trim(),
  email: String(r?.email ?? "").split(/[;,\s]+/)[0].toLowerCase(),
});

async function buildPlan(rawRows: unknown, session?: ClientSession) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) throw new CustomError("Envía las filas del listado de proveedores", 400);
  const skipped: { line: number; name: string; identification: string; reason: string }[] = [];
  const byId = new Map<string, SupplierRow>();
  for (const r of rawRows.map(clean)) {
    if (!r.name || !r.identification) skipped.push({ ...r, reason: !r.name ? "sin nombre" : "sin identificación" });
    else if (byId.has(r.identification)) skipped.push({ ...r, reason: `repetido (fila ${byId.get(r.identification)!.line})` });
    else byId.set(r.identification, r);
  }
  const existing = new Map(
    (await Party.find({ identification: { $in: [...byId.keys()] } }).session(session ?? null).lean<any[]>()).map((p) => [p.identification, p]),
  );
  const rows = [...byId.values()];
  return {
    toCreate: rows.filter((r) => !existing.has(r.identification)),
    toMark: rows.filter((r) => existing.has(r.identification) && !existing.get(r.identification).isSupplier).map((r) => ({ ...r, party: existing.get(r.identification) })),
    already: rows.filter((r) => existing.get(r.identification)?.isSupplier),
    problems: rows.map((r) => ({ ...r, reason: idProblem(r.identification) })).filter((r) => r.reason),
    skipped,
  };
}

const show = ({ line, name, identification }: SupplierRow, status: string) => ({ line, name, identification, status });

export async function previewSupplierList(rows: unknown) {
  const plan = await buildPlan(rows);
  return {
    suppliers: [...plan.toCreate.map((r) => show(r, "nuevo")), ...plan.toMark.map((r) => show(r, "existente"))],
    problems: plan.problems.map(({ line, name, identification, reason }) => ({ line, name, identification, reason })),
    skipped: plan.skipped,
    counts: { toCreate: plan.toCreate.length, toMark: plan.toMark.length, already: plan.already.length, problems: plan.problems.length, skipped: plan.skipped.length },
    canApply: plan.toCreate.length + plan.toMark.length > 0,
  };
}

export async function applySupplierList(rows: unknown, actor: Actor) {
  return runInTransaction(async (session) => {
    const plan = await buildPlan(rows, session);
    if (plan.toCreate.length + plan.toMark.length === 0) throw new CustomError("Todos los proveedores del archivo ya están en el sistema", 400);
    const _id = new Types.ObjectId();
    const number = await nextBatchNumber(session);
    await Party.insertMany(
      plan.toCreate.map((r) => ({
        identification: r.identification, idType: idTypeOf(r.identification), name: r.name, address: r.address, phone: r.phone, email: r.email,
        isSupplier: true, importBatchId: _id,
      })),
      { session },
    );
    const restores: IRestore[] = [];
    for (const r of plan.toMark) {
      const restore = fillBlanks(r.party, { isSupplier: true, address: r.address, phone: r.phone, email: r.email });
      if (!restore) continue;
      restores.push(restore);
      await Party.updateOne({ _id: r.party._id }, { $set: restore.applied }, { session });
    }
    const [doc] = await ImportBatch.create(
      [{
        _id, number, source: "proveedores-excel", cutoff: parseDay(todayEc()), restores, createdBy: actor,
        counts: { suppliersCreated: plan.toCreate.length, suppliersMarked: restores.length, alreadySuppliers: plan.already.length, idProblems: plan.problems.length, skipped: plan.skipped.length },
        warnings: [
          ...(plan.problems.length ? [`${plan.problems.length} identificaciones con problemas, revisar: ${plan.problems.map((p) => `${p.name} (${p.identification}: ${p.reason})`).join("; ")}.`] : []),
          ...(plan.skipped.length ? [`${plan.skipped.length} filas no se importaron: ${plan.skipped.map((p) => `fila ${p.line} ${p.reason}`).join("; ")}.`] : []),
        ],
      }],
      { session },
    );
    const { restores: _r, ...out } = doc.toObject();
    return { batch: out };
  });
}
