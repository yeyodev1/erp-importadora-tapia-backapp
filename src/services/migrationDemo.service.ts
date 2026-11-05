import { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import { StockBalance } from "../models/stockBalance.model";
import { findUsages, partyChecks, productChecks } from "./migrationUsage.service";

/**
 * Quitar los datos de EJEMPLO que sembró el arranque (seed.ts): terceros con
 * "EJEMPLO" en el nombre y los 6 productos demo con su stock. Solo se borra
 * lo que ningún documento usa; lo usado se lista y se queda.
 */
export const DEMO_PRODUCTS: [string, string][] = [
  ["000002", "ACHIOTE LIBRA"],
  ["000010", "CANELA SUPERIOR"],
  ["000020", "LAUREL"],
  ["000005", "ALMENDRAS 25/27"],
  ["000030", "LENTEJA SACO 100LBS"],
  ["000031", "LINAZA"],
];

async function buildPlan(session?: ClientSession) {
  const s = session ?? null;
  const products = await Product.find({ $or: DEMO_PRODUCTS.map(([code, name]) => ({ code, name })) }).session(s).lean<any[]>();
  const parties = await Party.find({ name: /EJEMPLO/i }).session(s).lean<any[]>();
  const productRows = [];
  for (const p of products) productRows.push({ doc: p, usedBy: await findUsages(productChecks([p._id]), session) });
  const removable = productRows.filter((r) => !r.usedBy.length).map((r) => r.doc._id as Types.ObjectId);
  const partyRows = [];
  // Los productos demo que se van no cuentan como uso de su proveedor de ejemplo.
  for (const p of parties) partyRows.push({ doc: p, usedBy: await findUsages(partyChecks([p._id], { ignoreProducts: removable }), session) });
  return { productRows, partyRows };
}

const row = (r: { doc: any; usedBy: string[] }, kind: "producto" | "tercero") => ({
  id: r.doc._id, kind, code: kind === "producto" ? r.doc.code : r.doc.identification, name: r.doc.name,
  status: r.usedBy.length ? "en_uso" : "se_quita", usedBy: r.usedBy,
});

function present(plan: Awaited<ReturnType<typeof buildPlan>>) {
  const items = [...plan.productRows.map((r) => row(r, "producto")), ...plan.partyRows.map((r) => row(r, "tercero"))];
  return {
    items,
    counts: { remove: items.filter((i) => i.status === "se_quita").length, inUse: items.filter((i) => i.status === "en_uso").length },
    empty: items.length === 0,
  };
}

export async function previewDemo() {
  return present(await buildPlan());
}

export async function applyDemo() {
  return runInTransaction(async (session) => {
    const plan = await buildPlan(session);
    const products = plan.productRows.filter((r) => !r.usedBy.length).map((r) => r.doc._id);
    const parties = plan.partyRows.filter((r) => !r.usedBy.length).map((r) => r.doc._id);
    // Sin movimientos el saldo de stock solo puede estar en cero: se va con el producto.
    await StockBalance.deleteMany({ productId: { $in: products } }, { session });
    await Product.deleteMany({ _id: { $in: products } }, { session });
    await Party.deleteMany({ _id: { $in: parties } }, { session });
    return { ...present(plan), removed: { products: products.length, parties: parties.length } };
  });
}
