import { CustomError } from "../errors/customError.error";
import { ID_TYPES } from "../models/party.model";
import { roundQty } from "../utils/money";
import { parseDay } from "../utils/dates";

/**
 * Reglas puras de la migración desde Macio: leer el JSON exportado de sus 4
 * vistas (clientes, vendedores, inventario, cartera), normalizar y clasificar.
 * No toca la base: la vista previa y la importación parten de aquí.
 */

/** Mayúsculas y espacios simples: así une Macio la cartera con el cliente (la cartera no trae RUC). */
export const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();
/** Además sin tildes: para comparar nombres de productos entre sistemas. */
export const normPlain = (s: unknown) => norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
const text = (s: unknown) => String(s ?? "").trim();

export const CONSUMER_FINAL = "9999999999999";

export function idTypeOf(id: string): string {
  if (id === CONSUMER_FINAL) return ID_TYPES.CONSUMIDOR_FINAL;
  if (/^\d{13}$/.test(id)) return ID_TYPES.RUC;
  if (/^\d{10}$/.test(id)) return ID_TYPES.CEDULA;
  return ID_TYPES.PASAPORTE;
}

/** Módulo 10 de la cédula (también vale para los 10 primeros dígitos del RUC de persona natural). */
function cedulaOk(id: string) {
  const province = Number(id.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  const total = [...id.slice(0, 9)].reduce((acc, ch, i) => {
    const n = Number(ch) * (i % 2 === 0 ? 2 : 1);
    return acc + (n > 9 ? n - 9 : n);
  }, 0);
  return (10 - (total % 10)) % 10 === Number(id[9]);
}

/** "" si la identificación es válida; si no, el motivo en palabras. Sociedades y públicos (3.er dígito 9 o 6) no se verifican: el SRI tiene excepciones. */
export function idProblem(id: string): string {
  if (!id) return "sin identificación";
  if (id === CONSUMER_FINAL) return "";
  if (!/^\d+$/.test(id)) return "tiene letras o símbolos: se importa como pasaporte";
  if (id.length === 10) return cedulaOk(id) ? "" : "cédula con dígito verificador incorrecto";
  if (id.length === 13) {
    if (id.endsWith("000")) return "RUC sin número de establecimiento";
    if (Number(id[2]) < 6) return cedulaOk(id.slice(0, 10)) ? "" : "RUC con dígito verificador incorrecto";
    return id[2] === "6" || id[2] === "9" ? "" : "RUC con tercer dígito inválido";
  }
  return `tiene ${id.length} dígitos (cédula 10, RUC 13): se importa como pasaporte`;
}

/** Decimal en texto ("1045.00") → centavos enteros. */
export function toCents(value: unknown): number {
  const n = Number(String(value ?? "").trim());
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

const FRUTOS = /\b(ALMENDRA|NUEZ|NUEC|PASA|CIRUELA|MANI|PISTACHO|MARANON)/;
const GRANOS = /\b(LENTEJA|ARVEJA|GARBANZO|LINAZA|CHIA|ALPISTE|CANGUIL|FREJOL|MAIZ|QUINUA|AVENA)/;

/** Grupo sugerido por palabras del nombre (el contador lo confirma en la ficha). */
export function groupOf(name: string): "ESPECIAS" | "FRUTOS SECOS" | "GRANOS Y SEMILLAS" {
  const n = normPlain(name);
  if (FRUTOS.test(n)) return "FRUTOS SECOS";
  if (GRANOS.test(n)) return "GRANOS Y SEMILLAS";
  return "ESPECIAS";
}

const UNITS: Record<string, string> = { LIBRA: "LIBRAS", LIBRAS: "LIBRAS", SACO: "SACOS", SACOS: "SACOS", CAJA: "CAJAS", CAJAS: "CAJAS" };
export const unitOf = (u: unknown) => UNITS[norm(u)] ?? norm(u);

/** Bodegas de Macio (bod_codigo) y series de factura (trc_serdoc) → bodega del ERP. */
export const WAREHOUSE_BY_BOD: Record<string, string> = { "12": "GYE", "13": "UIO" };
export const WAREHOUSE_BY_SERIES: Record<string, string> = { "102999": "GYE", "301999": "UIO" };

export interface MacioClient {
  macioCode: string;
  identification: string;
  idType: string;
  problem: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  sellerCode: string;
  sellerName: string;
}

export interface MacioProduct {
  code: string;
  macioCode: string;
  name: string;
  unit: string;
  group: string;
  stock: { warehouse: string; qty: number }[];
}

export interface MacioInvoice {
  trcCode: string;
  number: string;
  series: string;
  sequential: string;
  customerName: string;
  creditDays: number;
  date: Date;
  dueDate: Date;
  total: number;
  paid: number;
  balance: number;
  warehouse: string;
}

export interface MacioData {
  clients: MacioClient[];
  sellers: { code: string; name: string }[];
  products: MacioProduct[];
  invoices: MacioInvoice[];
  creditNotes: { count: number; total: number };
  otherDocs: number;
  warnings: string[];
}

const MAX_ROWS = 50_000;

function rows(data: any, key: string): any[] {
  const list = data?.[key];
  if (!Array.isArray(list)) throw new CustomError(`El archivo no trae la lista "${key}": ¿es el JSON exportado de Macio?`, 400);
  if (list.length > MAX_ROWS) throw new CustomError(`"${key}" trae demasiadas filas (${list.length})`, 400);
  return list;
}

/** Valida la forma del JSON y lo pasa a estructuras limpias (centavos, fechas, códigos). */
export function parseMacio(data: unknown): MacioData {
  if (!data || typeof data !== "object") throw new CustomError("Sube el archivo JSON exportado de Macio", 400);
  const warnings: string[] = [];

  const clients = rows(data, "clientes").map((c): MacioClient => {
    const identification = text(c?.per_identificacion).replace(/\s+/g, "");
    return {
      macioCode: text(c?.per_codigo),
      identification,
      idType: idTypeOf(identification),
      problem: idProblem(identification),
      name: norm(c?.per_nombre),
      address: text(c?.per_direccion),
      phone: text(c?.per_telefono),
      email: text(c?.per_email).toLowerCase(),
      sellerCode: text(c?.ven_codigo),
      sellerName: norm(c?.ven_nombre),
    };
  });

  const sellers = rows(data, "vendedores").map((v) => ({ code: text(v?.ven_codigo), name: norm(v?.ven_nombre) }));

  const products = new Map<string, MacioProduct>();
  for (const r of rows(data, "inventario")) {
    const macioCode = text(r?.pro_codigo);
    if (!macioCode || !norm(r?.pro_nombre)) {
      warnings.push(`Fila de inventario sin código o sin nombre: no se importa.`);
      continue;
    }
    const code = macioCode.padStart(6, "0");
    const p = products.get(code) ?? { code, macioCode, name: norm(r.pro_nombre), unit: unitOf(r.uni_nombre), group: groupOf(r.pro_nombre), stock: [] };
    products.set(code, p);
    const qty = roundQty(Number(r.stock_actual));
    const warehouse = WAREHOUSE_BY_BOD[text(r.bod_codigo)];
    if (!Number.isFinite(qty)) warnings.push(`Stock no numérico en ${p.name}: no se carga.`);
    else if (qty < 0) warnings.push(`Stock negativo en ${p.name} (${r.bod_nombre}): no se carga; revísalo en Macio.`);
    else if (qty > 0 && !warehouse) warnings.push(`Bodega ${text(r.bod_codigo)} desconocida para ${p.name}: no se carga su stock.`);
    else if (qty > 0) p.stock.push({ warehouse, qty });
  }

  const invoices: MacioInvoice[] = [];
  const creditNotes = { count: 0, total: 0 };
  let otherDocs = 0;
  for (const r of rows(data, "cartera")) {
    const tipdoc = text(r?.trc_tipdoc);
    if (tipdoc === "4") {
      creditNotes.count++;
      creditNotes.total += toCents(r.saldo_pendiente) || 0;
      continue;
    }
    if (tipdoc !== "1") {
      otherDocs++;
      continue;
    }
    const series = text(r.trc_serdoc);
    const sequential = text(r.trc_numdoc);
    const number = `${series}-${sequential}`;
    const total = toCents(r.trc_totfact);
    const balance = toCents(r.saldo_pendiente);
    if (!Number.isInteger(total) || !Number.isInteger(balance) || balance <= 0 || balance > total) {
      warnings.push(`Factura ${number}: total o saldo inválido (total ${r.trc_totfact}, saldo ${r.saldo_pendiente}); no se importa.`);
      continue;
    }
    let date: Date, dueDate: Date;
    try {
      date = parseDay(r.trc_fecha, `fecha de la factura ${number}`);
      dueDate = parseDay(r.fecha_vencimiento || r.trc_fecha, `vencimiento de la factura ${number}`);
    } catch (e) {
      warnings.push(`${(e as Error).message}; no se importa.`);
      continue;
    }
    const warehouse = WAREHOUSE_BY_SERIES[series] ?? "GYE";
    if (!WAREHOUSE_BY_SERIES[series]) warnings.push(`Factura ${number}: serie ${series} desconocida, se asigna a Guayaquil.`);
    invoices.push({
      trcCode: text(r.trc_codigo), number, series, sequential, customerName: norm(r.per_nombre),
      creditDays: Math.max(0, Math.round(Number(r.per_diascredito) || 0)),
      date, dueDate, total, paid: total - balance, balance, warehouse,
    });
  }
  return { clients, sellers, products: [...products.values()], invoices, creditNotes, otherDocs, warnings };
}
