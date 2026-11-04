import { ClientSession, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { InventoryMovement, MovementType, INBOUND_TYPES } from "../models/inventoryMovement.model";
import { Product } from "../models/product.model";
import { StockBalance } from "../models/stockBalance.model";
import { costCents, roundQty, roundUnitCost } from "../utils/money";
import type { Actor } from "./accounting.service";

export interface MovementLineInput {
  productId: string | Types.ObjectId;
  /** Siempre positiva; el tipo decide si entra o sale. */
  qty: number;
  /** Solo para ingresos con costo propio (compra, importación, inicial). Dólares por unidad. */
  unitCost?: number;
  /**
   * Centavos exactos que entran o salen (manda sobre unitCost). Lo usan la transferencia
   * y la anulación: el valor que salió de un lado entra igual al otro, sin redondeo de por medio.
   */
  totalCost?: number;
  lot?: string;
}

export interface MovementInput {
  warehouseId: string | Types.ObjectId;
  date: Date;
  type: MovementType;
  partyId?: string | Types.ObjectId | null;
  source: { module: string; docType: string; docId: Types.ObjectId | null; docNumber: string };
  lines: MovementLineInput[];
  /** Ventas de Tapia: no se permite vender lo que no hay. Ajustes de toma sí pueden dejar negativo si se fuerza. */
  allowNegative?: boolean;
}

export interface AppliedLine {
  productId: Types.ObjectId;
  groupId: Types.ObjectId;
  qty: number;
  unitCost: number;
  /** Centavos, siempre positivo: el valor que entró o salió. */
  totalCost: number;
}

/** Ingresos que traen su propio costo; los demás ingresos entran al promedio vigente. */
const COSTED_INBOUND: MovementType[] = ["INVENTARIO_INICIAL", "INGRESO_COMPRA", "INGRESO_IMPORTACION"];

/**
 * Aplica un movimiento de inventario con costo promedio ponderado por bodega.
 * - Ingreso con costo: promedio = (valor actual + valor que entra) / (cantidad nueva).
 * - Ingreso sin costo propio (ajuste, devolución de cliente): entra al promedio vigente,
 *   o al unitCost indicado (la transferencia pasa el costo de la bodega de origen).
 * - Egreso: sale al promedio vigente; el promedio no cambia.
 * Devuelve el costo aplicado por línea para que el módulo arme su asiento.
 */
export async function applyMovement(
  input: MovementInput,
  actor: Actor,
  session: ClientSession,
): Promise<AppliedLine[]> {
  const inbound = INBOUND_TYPES.includes(input.type);
  const applied: AppliedLine[] = [];

  for (const line of input.lines) {
    const qty = roundQty(Number(line.qty));
    if (!(qty > 0)) throw new CustomError("La cantidad debe ser mayor que cero", 400);

    const product = await Product.findById(line.productId).session(session).lean<any>();
    if (!product) throw new CustomError("Producto no encontrado", 404);
    if (!product.controlsStock) continue;

    const balance =
      (await StockBalance.findOne({ productId: product._id, warehouseId: input.warehouseId }).session(session)) ??
      new StockBalance({ productId: product._id, warehouseId: input.warehouseId });

    let unitCost: number;
    let valueDelta: number;
    const fixed = line.totalCost === undefined ? undefined : Number(line.totalCost);
    if (fixed !== undefined && !(Number.isInteger(fixed) && fixed >= 0)) {
      throw new CustomError(`Valor inválido para ${product.name}: centavos enteros`, 400);
    }

    if (inbound) {
      const hasOwnCost = COSTED_INBOUND.includes(input.type) || line.unitCost !== undefined;
      unitCost =
        fixed !== undefined
          ? roundUnitCost(fixed / 100 / qty)
          : hasOwnCost
            ? roundUnitCost(Number(line.unitCost ?? 0))
            : balance.avgCost;
      if (hasOwnCost && !(unitCost >= 0)) throw new CustomError(`Costo inválido para ${product.name}`, 400);
      valueDelta = fixed ?? costCents(qty, unitCost);
      balance.qty = roundQty(balance.qty + qty);
      balance.totalValue += valueDelta;
      // Con saldo positivo el promedio sale del valor; si quedó en cero o negativo, manda el último costo.
      balance.avgCost = balance.qty > 0 ? roundUnitCost(balance.totalValue / 100 / balance.qty) : unitCost;
    } else {
      if (!input.allowNegative && balance.qty < qty) {
        throw new CustomError(
          `Stock insuficiente de ${product.name}: hay ${balance.qty} ${product.unit} y se piden ${qty}`,
          409,
        );
      }
      unitCost = fixed !== undefined ? roundUnitCost(fixed / 100 / qty) : balance.avgCost;
      // La última salida se lleva el valor exacto que queda: no quedan centavos huérfanos.
      valueDelta = fixed ?? (balance.qty === qty ? balance.totalValue : costCents(qty, unitCost));
      balance.qty = roundQty(balance.qty - qty);
      balance.totalValue -= valueDelta;
      // Salida a valor fijo (anular un ingreso): lo que queda se repromedia.
      if (fixed !== undefined && balance.qty > 0) {
        balance.avgCost = roundUnitCost(balance.totalValue / 100 / balance.qty);
      }
    }

    await balance.save({ session });

    await InventoryMovement.create(
      [
        {
          productId: product._id,
          warehouseId: input.warehouseId,
          date: input.date,
          type: input.type,
          qty: inbound ? qty : -qty,
          unitCost,
          totalCost: inbound ? valueDelta : -valueDelta,
          balanceQty: balance.qty,
          balanceAvgCost: balance.avgCost,
          balanceValue: balance.totalValue,
          lot: line.lot ?? "",
          partyId: input.partyId ?? null,
          source: input.source,
          createdBy: { userId: actor.userId, name: actor.name },
        },
      ],
      { session },
    );

    applied.push({ productId: product._id, groupId: product.groupId, qty, unitCost, totalCost: valueDelta });
  }

  return applied;
}

/** Suma costos por grupo de producto (cada grupo tiene su cuenta de inventario y de costo). */
export function totalsByGroup(lines: AppliedLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(String(l.groupId), (out.get(String(l.groupId)) ?? 0) + l.totalCost);
  return out;
}
