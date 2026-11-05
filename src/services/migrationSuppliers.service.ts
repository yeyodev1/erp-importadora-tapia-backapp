import mongoose, { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { ImportBatch, IRestore } from "../models/importBatch.model";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import type { Actor } from "./accounting.service";
import { nextBatchNumber } from "./migrationMacio.service";
import { idTypeOf, norm, normPlain } from "./migrationRules.service";
import { todayEc } from "./salesCommon.service";
import { parseDay } from "../utils/dates";

/**
 * App de Proveedores (misma base de Atlas, otra base de datos): sus
 * proveedores pasan a terceros isSupplier y sus fotos a la ficha del producto
 * del ERP con el mismo nombre. Esa app no guarda RUC: solo se importa el
 * proveedor si sus notas traen un RUC de 13 dígitos; los demás se listan.
 */
export const SUPPLIERS_DB = "proveedores-importadoratapia";

async function source(): Promise<{ suppliers: any[]; products: any[]; error: string }> {
  const db = mongoose.connection.useDb(SUPPLIERS_DB, { useCache: true });
  try {
    const [suppliers, products] = await Promise.all([
      db.collection("suppliers").find({ isActive: { $ne: false } }).toArray(),
      db.collection("products").find({ isActive: { $ne: false } }).toArray(),
    ]);
    return { suppliers, products, error: "" };
  } catch (e) {
    // Sin permiso de lectura sobre esa base: la vista previa lo dice en vez de fallar.
    return { suppliers: [], products: [], error: (e as Error).message };
  }
}

const rucIn = (s: any) => String(s?.notes ?? "").match(/\b\d{13}\b/)?.[0] ?? "";

async function buildPlan(session?: ClientSession) {
  const s = session ?? null;
  const { suppliers, products, error } = await source();
  const withRuc = suppliers.map((x) => ({ name: norm(x.name), ruc: rucIn(x), phone: String(x.phone ?? ""), email: String(x.email ?? "").toLowerCase() }));
  const existing = new Map(
    (await Party.find({ identification: { $in: withRuc.filter((x) => x.ruc).map((x) => x.ruc) } }).session(s).lean<any[]>()).map((p) => [p.identification, p]),
  );
  const erpProducts = await Product.find({ isActive: true }).session(s).select("code name imageUrl").lean<any[]>();
  const byName = new Map(erpProducts.map((p) => [normPlain(p.name), p]));
  const photos = products
    .map((p) => ({ name: norm(p.name), url: String(p.photos?.[0]?.url ?? ""), erp: byName.get(normPlain(p.name)) }))
    .filter((p) => p.url);
  return {
    empty: suppliers.length === 0 && products.length === 0,
    error,
    toCreate: withRuc.filter((x) => x.ruc && !existing.has(x.ruc)),
    toMark: withRuc.filter((x) => x.ruc && existing.has(x.ruc)).map((x) => ({ ...x, party: existing.get(x.ruc) })),
    withoutRuc: withRuc.filter((x) => !x.ruc),
    photos: photos.filter((p) => p.erp && !p.erp.imageUrl),
    photosSkipped: photos.filter((p) => !p.erp || p.erp.imageUrl).map((p) => ({ name: p.name, reason: p.erp ? `ya tiene foto (${p.erp.code})` : "no hay un producto del ERP con ese nombre" })),
  };
}

export async function previewSuppliers() {
  const plan = await buildPlan();
  return {
    empty: plan.empty,
    message: plan.error
      ? `No se pudo leer la app de Proveedores: ${plan.error}`
      : plan.empty ? "No hay datos en la app de Proveedores." : "",
    suppliers: plan.toCreate.map(({ name, ruc }) => ({ name, ruc, status: "nuevo" })).concat(plan.toMark.map(({ name, ruc }) => ({ name, ruc, status: "existente" }))),
    withoutRuc: plan.withoutRuc.map((x) => ({ name: x.name, reason: "sin RUC, no importado" })),
    photos: plan.photos.map((p) => ({ name: p.name, code: p.erp.code, url: p.url })),
    photosSkipped: plan.photosSkipped,
    counts: { suppliers: plan.toCreate.length, marked: plan.toMark.length, withoutRuc: plan.withoutRuc.length, photos: plan.photos.length, photosSkipped: plan.photosSkipped.length },
    canApply: plan.toCreate.length + plan.toMark.length + plan.photos.length > 0,
  };
}

export async function applySuppliers(actor: Actor) {
  return runInTransaction(async (session) => {
    const plan = await buildPlan(session);
    if (plan.toCreate.length + plan.toMark.length + plan.photos.length === 0) throw new CustomError("No hay nada que importar de la app de Proveedores", 400);
    const _id = new Types.ObjectId();
    const number = await nextBatchNumber(session);
    const restores: IRestore[] = [];
    if (plan.toCreate.length) {
      await Party.insertMany(
        plan.toCreate.map((x) => ({ identification: x.ruc, idType: idTypeOf(x.ruc), name: x.name, phone: x.phone, email: x.email, isSupplier: true, importBatchId: _id })),
        { session },
      );
    }
    for (const x of plan.toMark.filter((m) => !m.party.isSupplier)) {
      restores.push({ model: "Party", id: x.party._id, previous: { isSupplier: false }, applied: { isSupplier: true } });
      await Party.updateOne({ _id: x.party._id }, { isSupplier: true }, { session });
    }
    for (const p of plan.photos) {
      restores.push({ model: "Product", id: p.erp._id, previous: { imageUrl: "" }, applied: { imageUrl: p.url } });
      await Product.updateOne({ _id: p.erp._id }, { imageUrl: p.url }, { session });
    }
    const [doc] = await ImportBatch.create(
      [{
        _id, number, source: "proveedores", cutoff: parseDay(todayEc()), restores, createdBy: actor,
        counts: { suppliersCreated: plan.toCreate.length, suppliersMarked: restores.filter((r) => r.model === "Party").length, withoutRuc: plan.withoutRuc.length, photos: plan.photos.length },
        warnings: plan.withoutRuc.length ? [`${plan.withoutRuc.length} proveedores sin RUC no se importaron: ${plan.withoutRuc.map((x) => x.name).join(", ")}.`] : [],
      }],
      { session },
    );
    const { restores: _r, ...out } = doc.toObject();
    return { batch: out };
  });
}
