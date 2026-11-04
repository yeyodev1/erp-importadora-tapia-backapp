import { ClientSession, Model, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import { ProductGroup } from "../models/productGroup.model";
import type { ICustomerSnapshot, ISaleLine, ITotals } from "../models/salesInvoice.model";
import { cents, percentOf, roundCents, roundQty, sum } from "../utils/money";
import { dayRange, TIMEZONE } from "../utils/dates";
import { escapeRegex } from "../utils/regex";
import * as accounting from "./accounting.service";
import type { EntryLineInput } from "./accounting.service";

/** Piezas comunes de facturación y cartera: líneas, totales, cliente, asiento de venta, filtros y paginado. */

export function oid(value: unknown, label: string): Types.ObjectId {
  if (!value || !Types.ObjectId.isValid(String(value))) throw new CustomError(`Falta o no es válido: ${label}`, 400);
  return new Types.ObjectId(String(value));
}

/** "AAAA-MM-DD" de hoy en Ecuador (en UTC ya puede ser mañana a las 19:00). */
export function todayEc(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export async function customerOf(partyId: unknown, session?: ClientSession) {
  const party = await Party.findById(oid(partyId, "cliente")).session(session ?? null).lean<any>();
  if (!party || !party.isActive) throw new CustomError("Cliente no encontrado", 404);
  if (!party.isCustomer) throw new CustomError(`${party.name} no está marcado como cliente`, 400);
  const snapshot: ICustomerSnapshot = {
    identification: party.identification,
    idType: party.idType,
    name: party.name,
    address: party.address,
    email: party.email,
    customerType: party.customer?.customerType ?? "",
    parish: party.customer?.parish ?? "",
  };
  return { party, snapshot };
}

/** Base, descuento e IVA de una línea. El IVA se calcula por línea y se suma (como el XML del SRI). */
export function priceLine(base: Omit<ISaleLine, "subtotal" | "vat" | "unitCost" | "costTotal"> & { unitCost?: number }): ISaleLine {
  const gross = roundCents(base.qty * base.unitPrice);
  if (base.discount > gross) throw new CustomError(`El descuento de ${base.name} supera el valor de la línea`, 400);
  const subtotal = gross - base.discount;
  return { ...base, subtotal, vat: percentOf(subtotal, base.vatRate), unitCost: base.unitCost ?? 0, costTotal: 0 };
}

export function computeTotals(lines: ISaleLine[]): ITotals {
  const subtotal0 = sum(lines.filter((l) => l.vatRate === 0).map((l) => l.subtotal));
  const subtotalVat = sum(lines.filter((l) => l.vatRate > 0).map((l) => l.subtotal));
  const vat = sum(lines.map((l) => l.vat));
  return { subtotal0, subtotalVat, discount: sum(lines.map((l) => l.discount)), vat, total: subtotal0 + subtotalVat + vat };
}

export function parseQty(value: unknown): number {
  const qty = roundQty(Number(value));
  if (!(qty > 0)) throw new CustomError("La cantidad debe ser mayor que cero", 400);
  return qty;
}

/** Arma las líneas de venta desde el catálogo: IVA del producto y precio de la lista si no viene. */
export async function buildLines(raw: unknown, priceList: string, session?: ClientSession) {
  if (!Array.isArray(raw) || raw.length === 0) throw new CustomError("El documento necesita al menos una línea", 400);
  const ids = raw.map((l: any) => oid(l?.productId, "producto"));
  const products = await Product.find({ _id: { $in: ids } }).session(session ?? null).lean<any[]>();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const lines = raw.map((l: any, i) => {
    const p = byId.get(String(ids[i]));
    if (!p || !p.isActive) throw new CustomError("Producto no encontrado o inactivo", 404);
    const listPrice = p.prices?.find((x: any) => x.list === priceList)?.price;
    if (l.unitPrice === undefined && listPrice === undefined) {
      throw new CustomError(`${p.name} no tiene precio en la lista ${priceList}`, 400);
    }
    return priceLine({
      productId: p._id,
      code: p.code,
      name: p.name,
      groupId: p.groupId,
      qty: parseQty(l.qty),
      unitPrice: l.unitPrice === undefined ? listPrice : cents(l.unitPrice, "precio"),
      discount: cents(l.discount ?? 0, "descuento"),
      vatRate: p.vatRate,
    });
  });
  return { lines, totals: computeTotals(lines), products: byId };
}

/** Copia los costos que devolvió applyMovement a las líneas (applyMovement salta los productos sin control de stock). */
export function assignCosts(lines: ISaleLine[], applied: { unitCost: number; totalCost: number }[], controlsStock: (l: ISaleLine) => boolean) {
  let k = 0;
  for (const l of lines) {
    if (!controlsStock(l)) continue;
    l.unitCost = applied[k].unitCost;
    l.costTotal = applied[k++].totalCost;
  }
}

/**
 * Líneas del asiento de venta: Clientes (total) / Ventas por grupo + IVA, y
 * Costo de venta / Inventario por grupo. `invert` da el de la nota de crédito.
 */
export async function salesEntryLines(
  lines: ISaleLine[],
  totals: ITotals,
  partyId: Types.ObjectId,
  invert: boolean,
  session: ClientSession,
): Promise<EntryLineInput[]> {
  const groups = await ProductGroup.find({ _id: { $in: lines.map((l) => l.groupId) } }).session(session).lean<any[]>();
  const accountsOf = new Map(groups.map((g) => [String(g._id), g.accounts]));
  const sales = new Map<string, number>();
  const costs = new Map<string, number>();
  for (const l of lines) {
    const g = String(l.groupId);
    sales.set(g, (sales.get(g) ?? 0) + l.subtotal);
    costs.set(g, (costs.get(g) ?? 0) + l.costTotal);
  }
  const side = (amount: number, debit: boolean) => (debit !== invert ? { debit: amount } : { credit: amount });
  const out: EntryLineInput[] = [
    { accountCode: await accounting.mappedAccount("customers", session), partyId, ...side(totals.total, true) },
    { accountCode: await accounting.mappedAccount("vatSales", session), ...side(totals.vat, false) },
  ];
  for (const [g, amount] of sales) {
    const acc = accountsOf.get(g);
    if (!acc) throw new CustomError("Grupo de producto sin cuentas contables", 400);
    out.push({ accountCode: acc.sales, ...side(amount, false) });
    out.push({ accountCode: acc.cost, ...side(costs.get(g) ?? 0, true) });
    out.push({ accountCode: acc.inventory, ...side(costs.get(g) ?? 0, false) });
  }
  return out;
}

/** Filtro de facturas para reportes de ventas y cartera (mismos filtros del sistema actual). */
export function invoiceFilter(query: Record<string, unknown>, dateField: "date" | null = "date") {
  const filter: Record<string, unknown> = {};
  if (dateField) {
    const range = dayRange(query.from, query.to);
    if (range) filter[dateField] = range;
  }
  if (query.includeVoided !== "true") filter.status = "vigente";
  if (query.warehouseId) filter.warehouseId = oid(query.warehouseId, "bodega");
  if (query.partyId) filter.partyId = oid(query.partyId, "cliente");
  if (query.groupId) filter["lines.groupId"] = oid(query.groupId, "grupo");
  if (query.sellerName) filter.sellerName = String(query.sellerName);
  if (query.parish) filter["customer.parish"] = String(query.parish);
  if (query.customerType) filter["customer.customerType"] = String(query.customerType);
  return filter;
}

/** Listado paginado `{ items, total, page, pages }` con búsqueda por número o cliente. */
export async function paginate(model: Model<any>, filter: Record<string, unknown>, query: Record<string, unknown>, searchFields: string[]) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  if (query.q) {
    const rx = new RegExp(escapeRegex(String(query.q)), "i");
    filter.$or = searchFields.map((f) => ({ [f]: rx }));
  }
  const [items, total] = await Promise.all([
    model.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).select("-xml").lean(),
    model.countDocuments(filter),
  ]);
  // Cobros y retenciones guardan solo partyId: se agrega el nombre con una sola consulta por página.
  const ids = [...new Set(items.filter((i: any) => i.partyId && !i.customer?.name).map((i: any) => String(i.partyId)))];
  if (ids.length) {
    const parties = await Party.find({ _id: { $in: ids } }).select("name").lean<any[]>();
    const names = new Map(parties.map((p) => [String(p._id), p.name]));
    for (const i of items as any[]) if (i.partyId) i.partyName = names.get(String(i.partyId)) ?? "";
  }
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export function requireText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new CustomError(`Falta ${label}`, 400);
  return text;
}
