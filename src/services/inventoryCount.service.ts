import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { StockBalance } from "../models/stockBalance.model";
import { parseDay } from "../utils/dates";
import { roundQty } from "../utils/money";
import type { Actor } from "./accounting.service";
import { createInSession, objectId, TransactionLineInput } from "./inventory.service";
import { stockRows, StockFilters } from "./inventoryReports.service";

/**
 * Toma física: saldo en unidad de control (libras) y en unidad de compra
 * (sacos = libras / factor), con la columna de conteo vacía para bodega.
 */
export async function physicalCount(query: StockFilters) {
  const { warehouse, rows } = await stockRows(query);
  const items = rows.map((r) => ({
    productId: r.productId,
    code: r.code,
    name: r.name,
    group: r.group,
    subgroup: r.subgroup,
    unit: r.unit,
    qty: r.qty,
    minQty: r.minQty,
    purchaseUnit: r.purchaseUnit?.name ?? "",
    purchaseQty: roundQty(r.qty / (r.purchaseUnit?.factor || 1)),
    count: null,
  }));
  return { warehouse, items };
}

/**
 * Ajuste desde la toma: recibe el conteo (unidad de control) por producto y
 * graba un INGRESO_AJUSTE con los sobrantes y un EGRESO_AJUSTE con los
 * faltantes, en una sola transacción. Ambos al costo promedio vigente.
 */
export async function adjustFromCount(body: any, actor: Actor) {
  const warehouseId = objectId(body?.warehouseId, "bodega");
  const date = parseDay(body?.date);
  if (!Array.isArray(body?.counts) || body.counts.length === 0) {
    throw new CustomError("Envía el conteo de al menos un producto", 400);
  }
  const counts = new Map<string, number>();
  for (const [i, c] of body.counts.entries()) {
    const productId = objectId(c?.productId, `productId (fila ${i + 1})`);
    const count = roundQty(Number(c?.count));
    if (!Number.isFinite(count) || count < 0) throw new CustomError(`Fila ${i + 1}: el conteo no puede ser negativo`, 400);
    if (counts.has(productId)) throw new CustomError(`Fila ${i + 1}: el producto está repetido`, 400);
    counts.set(productId, count);
  }
  const common = {
    warehouseId,
    date,
    responsible: String(body.responsible ?? "").trim(),
    costCenter: String(body.costCenter ?? "").trim(),
    description: String(body.description ?? "").trim() || "Ajuste por toma física",
  };

  return runInTransaction(async (session) => {
    const balances = await StockBalance.find({ warehouseId, productId: { $in: [...counts.keys()] } })
      .session(session)
      .lean<any[]>();
    const qtyOf = new Map(balances.map((b) => [String(b.productId), b.qty]));
    const ins: TransactionLineInput[] = [];
    const outs: TransactionLineInput[] = [];
    for (const [productId, count] of counts) {
      const diff = roundQty(count - (qtyOf.get(productId) ?? 0));
      if (diff > 0) ins.push({ productId, qty: diff });
      if (diff < 0) outs.push({ productId, qty: -diff });
    }
    if (ins.length === 0 && outs.length === 0) throw new CustomError("El conteo coincide con el sistema: no hay nada que ajustar", 400);

    const egreso = outs.length
      ? await createInSession({ ...common, type: "EGRESO_AJUSTE", lines: outs }, actor, session)
      : null;
    const ingreso = ins.length
      ? await createInSession({ ...common, type: "INGRESO_AJUSTE", lines: ins }, actor, session)
      : null;
    return { ingreso, egreso };
  });
}
