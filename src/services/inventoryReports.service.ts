import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { InventoryMovement } from "../models/inventoryMovement.model";
import { InventoryTransaction } from "../models/inventoryTransaction.model";
import { Product } from "../models/product.model";
import { StockBalance } from "../models/stockBalance.model";
import { Warehouse } from "../models/warehouse.model";
import { dayRange } from "../utils/dates";
import { roundQty, roundUnitCost, sum } from "../utils/money";
import { objectId } from "./inventory.service";

/** Reportes de solo lectura de inventario. */

export interface StockFilters {
  warehouseId?: unknown;
  groupId?: unknown;
  subgroup?: unknown;
  supplierId?: unknown;
}

async function requireWarehouse(id: unknown) {
  const w = await Warehouse.findById(objectId(id, "bodega")).lean<any>();
  if (!w) throw new CustomError("Bodega no encontrada", 404);
  return w;
}

/**
 * Productos activos que controlan stock, con su saldo en la bodega (0 si
 * nunca tuvo movimiento). Base de saldos, toma física y bajo mínimo.
 */
export async function stockRows(filters: StockFilters) {
  const warehouse = await requireWarehouse(filters.warehouseId);
  const pf: Record<string, unknown> = { isActive: true, controlsStock: true };
  if (filters.groupId) pf.groupId = objectId(filters.groupId, "grupo");
  if (filters.subgroup) pf.subgroup = String(filters.subgroup);
  if (filters.supplierId) pf.supplierId = objectId(filters.supplierId, "proveedor");
  const products = await Product.find(pf).sort({ name: 1 }).populate("groupId", "name").lean<any[]>();
  const balances = await StockBalance.find({
    warehouseId: warehouse._id,
    productId: { $in: products.map((p) => p._id) },
  }).lean<any[]>();
  const byProduct = new Map(balances.map((b) => [String(b.productId), b]));
  const rows = products.map((p) => {
    const b = byProduct.get(String(p._id));
    return {
      productId: p._id,
      code: p.code,
      name: p.name,
      group: p.groupId?.name ?? "",
      subgroup: p.subgroup,
      unit: p.unit,
      purchaseUnit: p.purchaseUnit,
      minQty: p.minQty,
      qty: b?.qty ?? 0,
      avgCost: b?.avgCost ?? 0,
      totalValue: b?.totalValue ?? 0,
    };
  });
  return { warehouse: { _id: warehouse._id, code: warehouse.code, name: warehouse.name }, rows };
}

/** Saldos por bodega. Sin `valued` no expone costos (bodega no necesita verlos). */
export async function balances(query: StockFilters & { valued?: unknown; includeZero?: unknown }) {
  const { warehouse, rows } = await stockRows(query);
  const valued = query.valued === "true" || query.valued === true;
  const items = rows
    .filter((r) => query.includeZero === "true" || r.qty !== 0 || r.totalValue !== 0)
    .map(({ avgCost, totalValue, ...r }) => (valued ? { ...r, avgCost, totalValue } : r));
  const total = valued ? sum(items.map((r: any) => r.totalValue)) : undefined;
  return { warehouse, items, total };
}

/** Productos con mínimo configurado cuyo saldo está por debajo. */
export async function belowMinimum(query: StockFilters) {
  const { warehouse, rows } = await stockRows(query);
  const items = rows
    .filter((r) => r.minQty > 0 && r.qty < r.minQty)
    .map(({ avgCost, totalValue, ...r }) => ({ ...r, missing: roundQty(r.minQty - r.qty) }));
  return { warehouse, items };
}

/** Momentos en que el kardex quedó con saldo negativo (ajustes forzados, datos migrados). */
export async function negatives(query: { warehouseId?: unknown; from?: unknown; to?: unknown }) {
  const filter: Record<string, unknown> = { balanceQty: { $lt: 0 } };
  if (query.warehouseId) filter.warehouseId = objectId(query.warehouseId, "bodega");
  const range = dayRange(query.from, query.to);
  if (range) filter.date = range;
  const items = await InventoryMovement.find(filter)
    .sort({ date: 1, createdAt: 1 })
    .populate("productId", "code name unit")
    .populate("warehouseId", "code name")
    .lean();
  return { items };
}

const LABELS: Record<string, string> = {
  INVENTARIO_INICIAL: "Ingreso por inventario inicial",
  INGRESO_COMPRA: "Ingreso por compra",
  INGRESO_IMPORTACION: "Ingreso por importación",
  INGRESO_AJUSTE: "Ingreso por ajuste",
  EGRESO_AJUSTE: "Egreso por ajuste",
  INGRESO_TRANSFERENCIA: "Ingreso por transferencia",
  EGRESO_TRANSFERENCIA: "Egreso por transferencia",
  EGRESO_VENTA: "Egreso por venta",
  NOTA_CREDITO_VENTA: "Nota de crédito",
  NOTA_CREDITO_COMPRA: "Nota de crédito de compra",
};

/**
 * Kardex de un producto en una bodega. El saldo se recalcula en orden de
 * fecha (no se usa el saldo guardado en cada movimiento, que sigue el orden
 * de grabación): un documento con fecha atrasada queda en su lugar.
 */
export async function kardex(query: { productId?: unknown; warehouseId?: unknown; from?: unknown; to?: unknown }) {
  const productId = new Types.ObjectId(objectId(query.productId, "producto"));
  const warehouse = await requireWarehouse(query.warehouseId);
  const product = await Product.findById(productId).lean<any>();
  if (!product) throw new CustomError("Producto no encontrado", 404);
  const range = dayRange(query.from, query.to) ?? {};
  const base = { productId, warehouseId: warehouse._id };

  let qty = 0;
  let value = 0;
  if (range.$gte) {
    const [prev] = await InventoryMovement.aggregate([
      { $match: { ...base, date: { $lt: range.$gte } } },
      { $group: { _id: null, qty: { $sum: "$qty" }, value: { $sum: "$totalCost" } } },
    ]);
    qty = roundQty(prev?.qty ?? 0);
    value = prev?.value ?? 0;
  }
  const avg = () => (qty !== 0 ? roundUnitCost(value / 100 / qty) : 0);
  const opening = { qty, unitCost: avg(), total: value };

  const dateFilter: Record<string, Date> = {};
  if (range.$gte) dateFilter.$gte = range.$gte;
  if (range.$lte) dateFilter.$lte = range.$lte;
  const movements = await InventoryMovement.find({ ...base, ...(range.$gte || range.$lte ? { date: dateFilter } : {}) })
    .sort({ date: 1, createdAt: 1 })
    .populate("partyId", "name")
    .lean<any[]>();

  // Responsable de las transacciones manuales sin tercero (transferencias, ajustes).
  const docIds = movements.filter((m) => !m.partyId && m.source?.docId).map((m) => m.source.docId);
  const docs = await InventoryTransaction.find({ _id: { $in: docIds } }, { responsible: 1 }).lean<any[]>();
  const responsibleOf = new Map(docs.map((d) => [String(d._id), d.responsible]));

  const items = movements.map((m) => {
    qty = roundQty(qty + m.qty);
    value += m.totalCost;
    const line = { qty: Math.abs(m.qty), unitCost: m.unitCost, total: Math.abs(m.totalCost) };
    const label = m.source?.docType?.startsWith("ANULA_") ? `Anulación (${LABELS[m.type] ?? m.type})` : (LABELS[m.type] ?? m.type);
    return {
      _id: m._id,
      voucher: `${label}#${m.source?.docNumber ?? ""}`,
      type: m.type,
      source: m.source,
      date: m.date,
      lot: m.lot,
      inbound: m.qty > 0 ? line : null,
      outbound: m.qty < 0 ? line : null,
      balance: { qty, unitCost: avg(), total: value },
      party: m.partyId?.name ?? responsibleOf.get(String(m.source?.docId)) ?? "",
    };
  });

  return {
    product: { _id: product._id, code: product.code, name: product.name, unit: product.unit },
    warehouse: { _id: warehouse._id, code: warehouse.code, name: warehouse.name },
    from: range.$gte ?? null,
    to: range.$lte ?? null,
    opening,
    items,
    closing: { qty, unitCost: avg(), total: value },
    count: items.length,
  };
}
