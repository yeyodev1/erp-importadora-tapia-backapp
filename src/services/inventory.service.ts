import { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { InventoryMovement, MovementType } from "../models/inventoryMovement.model";
import { InventoryTransaction, TRANSACTION_TYPES, TransactionType } from "../models/inventoryTransaction.model";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import { ProductGroup } from "../models/productGroup.model";
import { AccountMapKey } from "../models/settings.model";
import { Warehouse } from "../models/warehouse.model";
import { dayRange, parseDay, TIMEZONE } from "../utils/dates";
import { roundQty, roundUnitCost, sum } from "../utils/money";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import { AppliedLine, applyMovement, totalsByGroup } from "./inventoryCore.service";
import * as sequenceService from "./sequence.service";

export interface TransactionLineInput {
  productId: string;
  qty: number;
  unitCost?: number;
  lot?: string;
}

export interface TransactionInput {
  type: TransactionType;
  warehouseId: string;
  targetWarehouseId?: string | null;
  date: Date;
  partyId?: string | null;
  responsible?: string;
  costCenter?: string;
  containers?: number;
  lines: TransactionLineInput[];
  description?: string;
  imageUrl?: string;
}

/** Ingresos que traen su propio costo (el resto sale o entra al promedio). */
const COSTED: TransactionType[] = ["INVENTARIO_INICIAL", "INGRESO_COMPRA", "INGRESO_IMPORTACION"];

/** Contrapartida del inventario en el asiento de cada tipo. */
const COUNTER_ACCOUNT: Record<Exclude<TransactionType, "TRANSFERENCIA">, AccountMapKey> = {
  INVENTARIO_INICIAL: "openingBalance",
  INGRESO_COMPRA: "suppliers",
  INGRESO_IMPORTACION: "inventoryInTransit",
  INGRESO_AJUSTE: "inventoryAdjustment",
  EGRESO_AJUSTE: "inventoryAdjustment",
};

const OBJECT_ID = /^[a-f\d]{24}$/i;

export function objectId(value: unknown, field: string): string {
  const id = String(value ?? "");
  if (!OBJECT_ID.test(id)) throw new CustomError(`El campo ${field} no es un id válido`, 400);
  return id;
}

export function today(): Date {
  return parseDay(new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE }));
}

/** Valida el cuerpo que llega de la API antes de tocar la base. */
export function parseTransaction(body: any): TransactionInput {
  const type = String(body?.type ?? "") as TransactionType;
  if (!TRANSACTION_TYPES.includes(type)) {
    throw new CustomError(`Tipo de transacción inválido. Usa: ${TRANSACTION_TYPES.join(", ")}`, 400);
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    throw new CustomError("La transacción necesita al menos una línea", 400);
  }
  const lines = body.lines.map((l: any, i: number) => {
    const qty = roundQty(Number(l?.qty));
    if (!(qty > 0)) throw new CustomError(`Línea ${i + 1}: la cantidad debe ser mayor que cero`, 400);
    const line: TransactionLineInput = { productId: objectId(l.productId, `productId (línea ${i + 1})`), qty };
    if (l.lot) line.lot = String(l.lot).trim();
    const hasCost = l.unitCost !== undefined && l.unitCost !== null && l.unitCost !== "";
    if (COSTED.includes(type) || (type === "INGRESO_AJUSTE" && hasCost)) {
      const unitCost = roundUnitCost(Number(l.unitCost));
      const valid = COSTED.includes(type) ? unitCost > 0 : unitCost >= 0;
      if (!valid) throw new CustomError(`Línea ${i + 1}: el costo unitario debe ser mayor que cero`, 400);
      line.unitCost = unitCost;
    }
    return line;
  });
  const containers = Number(body.containers ?? 0);
  if (!Number.isInteger(containers) || containers < 0) {
    throw new CustomError("La cantidad de contenedores debe ser un entero positivo", 400);
  }
  return {
    type,
    warehouseId: objectId(body.warehouseId, "bodega"),
    targetWarehouseId: type === "TRANSFERENCIA" ? objectId(body.targetWarehouseId, "bodega de destino") : null,
    date: parseDay(body.date),
    partyId: body.partyId ? objectId(body.partyId, "proveedor") : null,
    responsible: String(body.responsible ?? "").trim(),
    costCenter: String(body.costCenter ?? "").trim(),
    containers: type === "INGRESO_IMPORTACION" ? containers : 0,
    lines,
    description: String(body.description ?? "").trim(),
    imageUrl: String(body.imageUrl ?? "").trim(),
  };
}

async function activeWarehouse(id: string, session: ClientSession) {
  const w = await Warehouse.findById(id).session(session).lean<any>();
  if (!w || !w.isActive) throw new CustomError("Bodega no encontrada o inactiva", 404);
  return w;
}

async function assertReferences(input: TransactionInput, session: ClientSession) {
  const warehouse = await activeWarehouse(input.warehouseId, session);
  if (input.type === "TRANSFERENCIA") {
    if (String(input.targetWarehouseId) === String(input.warehouseId)) {
      throw new CustomError("La bodega de destino debe ser distinta a la de origen", 400);
    }
    await activeWarehouse(String(input.targetWarehouseId), session);
  }
  if (input.type === "INGRESO_COMPRA" && !input.partyId) {
    throw new CustomError("El ingreso por compra necesita el proveedor", 400);
  }
  if (input.partyId && !(await Party.exists({ _id: input.partyId }).session(session))) {
    throw new CustomError("Proveedor no encontrado", 404);
  }
  const ids = input.lines.map((l) => l.productId);
  const products = await Product.find({ _id: { $in: ids } }).session(session).lean<any[]>();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) throw new CustomError("Producto no encontrado", 404);
    if (!p.controlsStock) throw new CustomError(`${p.name} no controla stock`, 400);
  }
  return warehouse;
}

/** Asiento del documento; null si no corresponde (transferencia, o valor en cero). */
async function postTransactionEntry(
  input: TransactionInput,
  source: { module: string; docType: string; docId: Types.ObjectId; docNumber: string },
  applied: AppliedLine[],
  actor: Actor,
  session: ClientSession,
) {
  // Mismo grupo y misma cuenta de inventario en las dos bodegas: el asiento sería neto cero.
  if (input.type === "TRANSFERENCIA") return null;
  const totals = totalsByGroup(applied);
  const total = sum([...totals.values()]);
  if (total === 0) return null;

  const groups = await ProductGroup.find({ _id: { $in: [...totals.keys()] } }).session(session).lean<any[]>();
  const counter = await accounting.mappedAccount(COUNTER_ACCOUNT[input.type], session);
  const outbound = input.type === "EGRESO_AJUSTE";
  const common = { costCenter: input.costCenter, partyId: input.partyId ?? null };
  const description = input.description || `${input.type} #${source.docNumber}`;

  const lines = groups.map((g) => {
    const amount = totals.get(String(g._id)) ?? 0;
    return { ...common, accountCode: g.accounts.inventory, ...(outbound ? { credit: amount } : { debit: amount }) };
  });
  lines.push({ ...common, accountCode: counter, ...(outbound ? { debit: total } : { credit: total }) });

  return accounting.postEntry({ date: input.date, type: "INVENTARIO", description, source, lines }, actor, session);
}

/** Graba la transacción dentro de una sesión ya abierta (la usa también el ajuste por toma física). */
export async function createInSession(input: TransactionInput, actor: Actor, session: ClientSession) {
  const warehouse = await assertReferences(input, session);
  const n = await sequenceService.next(`inventario-${input.type}-${warehouse.code}`, session);
  const doc = new InventoryTransaction({
    ...input,
    number: String(n).padStart(6, "0"),
    lines: [],
    createdBy: { userId: actor.userId, name: actor.name },
  });
  const source = { module: "inventario", docType: input.type, docId: doc._id, docNumber: doc.number };
  const base = { date: input.date, partyId: input.partyId ?? null, source };

  let applied: AppliedLine[];
  if (input.type === "TRANSFERENCIA") {
    const out = { ...base, warehouseId: input.warehouseId, type: "EGRESO_TRANSFERENCIA" as const, lines: input.lines };
    applied = await applyMovement(out, actor, session);
    // Entra a destino con los centavos exactos que salieron del origen.
    const inbound = applied.map((a, i) => ({ productId: a.productId, qty: a.qty, totalCost: a.totalCost, lot: input.lines[i].lot }));
    await applyMovement(
      { ...base, warehouseId: String(input.targetWarehouseId), type: "INGRESO_TRANSFERENCIA", lines: inbound },
      actor,
      session,
    );
  } else {
    applied = await applyMovement({ ...base, warehouseId: input.warehouseId, type: input.type, lines: input.lines }, actor, session);
  }

  doc.lines = applied.map((a, i) => ({
    productId: a.productId,
    qty: a.qty,
    unitCost: a.unitCost,
    totalCost: a.totalCost,
    lot: input.lines[i].lot ?? "",
  }));
  doc.totalCost = sum(applied.map((a) => a.totalCost));
  const entry = await postTransactionEntry(input, source, applied, actor, session);
  doc.journalEntryId = entry?._id ?? null;
  await doc.save({ session });
  return doc.toObject();
}

export async function create(body: unknown, actor: Actor) {
  const input = parseTransaction(body);
  return runInTransaction((session) => createInSession(input, actor, session));
}

/** Contrario de cada movimiento: la transferencia vuelve por donde vino; el resto, como ajuste. */
function reverseType(type: MovementType, qty: number): MovementType {
  if (type === "INGRESO_TRANSFERENCIA") return "EGRESO_TRANSFERENCIA";
  if (type === "EGRESO_TRANSFERENCIA") return "INGRESO_TRANSFERENCIA";
  return qty > 0 ? "EGRESO_AJUSTE" : "INGRESO_AJUSTE";
}

/**
 * Anula: cada movimiento se revierte con su mismo valor en centavos (no al
 * promedio de hoy), así el kardex y la contabilidad bajan lo mismo. Si deja
 * stock negativo, applyMovement lo rechaza y no se anula nada.
 */
export async function voidTransaction(id: string, body: any, actor: Actor) {
  objectId(id, "transacción");
  const reason = String(body?.reason ?? "").trim();
  if (!reason) throw new CustomError("Indica el motivo de la anulación", 400);
  const date = body?.date ? parseDay(body.date) : today();

  return runInTransaction(async (session) => {
    const doc = await InventoryTransaction.findById(id).session(session);
    if (!doc) throw new CustomError("Transacción no encontrada", 404);
    if (doc.status === "anulado") throw new CustomError("Esa transacción ya está anulada", 409);

    const movements = await InventoryMovement.find({ "source.docId": doc._id }).session(session).lean<any[]>();
    // Primero se saca lo que entró (valida stock), luego se devuelve lo que salió.
    movements.sort((a, b) => b.qty - a.qty);
    const source = { module: "inventario", docType: `ANULA_${doc.type}`, docId: doc._id, docNumber: doc.number };
    for (const m of movements) {
      await applyMovement(
        {
          warehouseId: m.warehouseId,
          date,
          type: reverseType(m.type, m.qty),
          partyId: m.partyId,
          source,
          lines: [{ productId: m.productId, qty: Math.abs(m.qty), totalCost: Math.abs(m.totalCost), lot: m.lot }],
        },
        actor,
        session,
      );
    }
    await accounting.reverseBySource(doc._id, reason, date, actor, session);
    doc.status = "anulado";
    doc.voidReason = reason;
    doc.voidedAt = date;
    await doc.save({ session });
    return doc.toObject();
  });
}

const POPULATE = [
  { path: "warehouseId", select: "code name" },
  { path: "targetWarehouseId", select: "code name" },
  { path: "partyId", select: "identification name" },
];

export async function list(query: Record<string, unknown>) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const filter: Record<string, unknown> = {};
  if (query.type) filter.type = String(query.type);
  if (query.status) filter.status = String(query.status);
  if (query.warehouseId) {
    const w = objectId(query.warehouseId, "bodega");
    filter.$or = [{ warehouseId: w }, { targetWarehouseId: w }];
  }
  const range = dayRange(query.from, query.to);
  if (range) filter.date = range;
  const [items, total] = await Promise.all([
    InventoryTransaction.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(POPULATE)
      .lean(),
    InventoryTransaction.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function get(id: string) {
  const doc = await InventoryTransaction.findById(objectId(id, "transacción"))
    .populate([...POPULATE, { path: "lines.productId", select: "code name unit" }])
    .lean();
  if (!doc) throw new CustomError("Transacción no encontrada", 404);
  return doc;
}
