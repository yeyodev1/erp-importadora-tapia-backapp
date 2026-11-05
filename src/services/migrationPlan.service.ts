import { ClientSession } from "mongoose";
import { ImportBatch } from "../models/importBatch.model";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import { ProductGroup } from "../models/productGroup.model";
import { SalesInvoice } from "../models/salesInvoice.model";
import { StockBalance } from "../models/stockBalance.model";
import { Warehouse } from "../models/warehouse.model";
import { MacioClient, MacioInvoice, MacioProduct, normPlain, parseMacio } from "./migrationRules.service";

/**
 * Plan de importación de Macio contra la base actual: qué clientes y
 * productos son nuevos o ya existen, a qué cliente va cada factura y qué
 * impide importar. La vista previa lo muestra; la importación lo ejecuta
 * (se recalcula dentro de la transacción).
 */
export interface PlannedInvoice extends MacioInvoice {
  client: MacioClient;
  /** Otros clientes con el mismo nombre (la cartera no trae RUC). */
  ambiguous: boolean;
}

export interface PlannedProduct extends MacioProduct {
  existing: any | null;
  conflict: boolean;
}

const GROUPS = ["ESPECIAS", "FRUTOS SECOS", "GRANOS Y SEMILLAS"];

/** Con nombres repetidos se elige el de RUC válido, luego cédula válida, luego el primer código de Macio. */
const rank = (c: MacioClient) => (c.problem ? 10 : 0) + (c.idType === "04" ? 0 : c.idType === "05" ? 1 : 2);
const best = (list: MacioClient[]) =>
  [...list].sort((a, b) => rank(a) - rank(b) || Number(a.macioCode) - Number(b.macioCode))[0];

/** Junta filas repetidas por identificación: la primera manda y las demás solo completan vacíos. */
function uniqueClients(list: MacioClient[]) {
  const byId = new Map<string, MacioClient>();
  const repeated: MacioClient[] = [];
  const withoutId: MacioClient[] = [];
  for (const c of list) {
    if (!c.identification || !c.name) {
      withoutId.push(c);
      continue;
    }
    const prev = byId.get(c.identification);
    if (!prev) {
      byId.set(c.identification, { ...c });
      continue;
    }
    repeated.push(c);
    for (const k of ["address", "phone", "email", "sellerCode", "sellerName"] as const) prev[k] ||= c[k];
  }
  return { byId, repeated, withoutId };
}

export async function buildPlan(data: unknown, session?: ClientSession) {
  const s = session ?? null;
  const parsed = parseMacio(data);
  const warnings = [...parsed.warnings];
  const blockers: string[] = [];
  const applied = await ImportBatch.findOne({ source: "macio", status: "aplicado" }).session(s).lean<any>();
  if (applied) blockers.push(`Ya hay una importación de Macio aplicada (${applied.number}): quítala en el historial antes de importar otra vez.`);

  const { byId, repeated, withoutId } = uniqueClients(parsed.clients);
  const clients = [...byId.values()];
  const existingParties = new Map(
    (await Party.find({ identification: { $in: [...byId.keys()] } }).session(s).lean<any[]>()).map((p) => [p.identification, p]),
  );

  const byName = new Map<string, MacioClient[]>();
  for (const c of clients) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);

  const invoices: PlannedInvoice[] = [];
  const unmatched: MacioInvoice[] = [];
  const seen = new Set<string>();
  for (const inv of parsed.invoices) {
    if (seen.has(inv.number)) {
      warnings.push(`La factura ${inv.number} viene repetida en el archivo: se importa una sola vez.`);
      continue;
    }
    seen.add(inv.number);
    const list = byName.get(inv.customerName);
    if (!list) unmatched.push(inv);
    else invoices.push({ ...inv, client: best(list), ambiguous: list.length > 1 });
  }
  const taken = await SalesInvoice.find({ number: { $in: invoices.map((i) => i.number) } }).session(s).select("number").lean<any[]>();
  if (taken.length) blockers.push(`Ya existen en el ERP ${taken.length} facturas con el mismo número (ej. ${taken[0].number}): esta cartera ya se importó.`);

  // Días de crédito: los trae la cartera, no la ficha del cliente.
  const creditDays = new Map<string, number>();
  for (const i of invoices) creditDays.set(i.client.identification, Math.max(creditDays.get(i.client.identification) ?? 0, i.creditDays));

  const existingProducts = new Map(
    (await Product.find({ code: { $in: parsed.products.map((p) => p.code) } }).session(s).lean<any[]>()).map((p) => [p.code, p]),
  );
  const products: PlannedProduct[] = parsed.products.map((p) => {
    const existing = existingProducts.get(p.code) ?? null;
    return { ...p, existing, conflict: !!existing && normPlain(existing.name) !== normPlain(p.name) };
  });
  const conflicts = products.filter((p) => p.conflict);
  if (conflicts.length) {
    blockers.push(
      `${conflicts.length} códigos de producto ya existen en el ERP con otro nombre (${conflicts.map((p) => `${p.code} es "${p.existing.name}", en Macio "${p.name}"`).join("; ")}). Si son datos de ejemplo, quítalos primero en "Datos de ejemplo"; si alguno está en uso, cámbiale el código en Configuración › Productos.`,
    );
  }
  const withStock = products.filter((p) => p.existing && !p.conflict && p.stock.length).map((p) => p.existing._id);
  const prior = await StockBalance.countDocuments({ productId: { $in: withStock }, qty: { $ne: 0 } }).session(s);
  if (prior) warnings.push(`${prior} saldos de stock ya existían en el ERP para productos de Macio: la cantidad de Macio se suma a la que ya hay.`);

  const groups = new Map((await ProductGroup.find({ name: { $in: GROUPS } }).session(s).lean<any[]>()).map((g) => [g.name, g]));
  for (const g of GROUPS) if (!groups.has(g)) blockers.push(`Falta el grupo de producto ${g} (Configuración › Grupos de producto).`);
  const warehouses = new Map((await Warehouse.find({ code: { $in: ["GYE", "UIO"] } }).session(s).lean<any[]>()).map((w) => [w.code, w]));
  for (const w of ["GYE", "UIO"]) if (!warehouses.has(w)) blockers.push(`Falta la bodega ${w} (Configuración › Bodegas).`);

  return {
    parsed, clients, repeated, withoutId, existingParties, creditDays, invoices, unmatched, products, groups, warehouses, warnings, blockers,
  };
}

export type MacioPlan = Awaited<ReturnType<typeof buildPlan>>;
