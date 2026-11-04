import { percentOf } from "../../utils/money";
import { ecuadorParts } from "./accessKey";
import type { SriLine, SriPayload } from "./sri.types";

/**
 * Piezas comunes de los XML del SRI. Se serializa directamente en forma
 * canónica C14N (sin espacios entre tags, `<a></a>` en vez de `<a/>`, escape
 * de C14N, atributos en orden alfabético): así el digest del comprobante es el
 * SHA-1 del mismo texto que se envía. Ver sign.ts.
 */

/** Datos del emisor (de Settings) que entran al XML. */
export interface Emitter {
  ruc: string;
  legalName: string;
  tradeName: string;
  address: string;
  keepsAccounting: boolean;
  specialTaxpayer: string;
  environment: 1 | 2;
}

/** Quita caracteres inválidos en XML 1.0 y normaliza saltos de línea como lo haría un parser. */
function clean(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[^\t\n -퟿-�\u{10000}-\u{10FFFF}]/gu, "");
}

/** Escape de texto tal como lo emite C14N. */
export function escapeText(value: unknown): string {
  return clean(String(value ?? "")).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape de atributo tal como lo emite C14N. */
export function escapeAttr(value: unknown): string {
  return clean(String(value ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;");
}

/** Elemento con texto escapado. */
export function el(name: string, text: unknown): string {
  return `<${name}>${escapeText(text)}</${name}>`;
}

/** Elemento con hijos ya serializados. */
export function wrap(name: string, children: string | string[]): string {
  return `<${name}>${Array.isArray(children) ? children.join("") : children}</${name}>`;
}

/** Elemento opcional: se omite si el valor está vacío (el XSD rechaza tags vacíos). */
export function opt(name: string, text: unknown): string {
  return text === undefined || text === null || String(text).trim() === "" ? "" : el(name, text);
}

/** Centavos enteros → "1234.56" sin pasar por flotantes. */
export function money(centsValue: number): string {
  if (!Number.isInteger(centsValue)) throw new Error(`Monto en centavos no entero: ${centsValue}`);
  const sign = centsValue < 0 ? "-" : "";
  const abs = Math.abs(centsValue);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Entero escalado (valor × 10^6) → texto con 6 decimales. */
function scaled6(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  return `${sign}${Math.trunc(abs / 1e6)}.${String(abs % 1e6).padStart(6, "0")}`;
}

/** Cantidad con hasta 6 decimales. */
export function qty(value: number): string {
  return scaled6(Math.round(value * 1e6));
}

/** Precio unitario en centavos (puede traer fracción) → dólares con 6 decimales. */
export function unitPrice(centsValue: number): string {
  return scaled6(Math.round(centsValue * 1e4));
}

/** dd/mm/aaaa en hora de Ecuador. */
export function sriDate(date: Date): string {
  const { dd, mm, yyyy } = ecuadorParts(new Date(date));
  return `${dd}/${mm}/${yyyy}`;
}

/** Código de porcentaje de IVA del SRI (tabla 17). */
const VAT_CODES: Record<number, string> = { 0: "0", 12: "2", 14: "3", 15: "4", 5: "5", 13: "10" };

export function vatCode(rate: number): string {
  const code = VAT_CODES[rate];
  if (code === undefined) throw new Error(`Tarifa de IVA no soportada por el SRI: ${rate}%`);
  return code;
}

/** IVA de una base en centavos, mismo redondeo que el resto del ERP. */
export const vatOf = percentOf;

export interface VatGroup {
  rate: number;
  base: number;
  value: number;
}

/**
 * Agrupa las bases por tarifa. El IVA total del payload manda: si hay una sola
 * tarifa gravada se usa `totals.vat` tal cual para que el XML cuadre con el documento.
 */
export function vatGroups(payload: SriPayload): VatGroup[] {
  const map = new Map<number, number>();
  for (const line of payload.lines) map.set(line.vatRate, (map.get(line.vatRate) ?? 0) + line.subtotal);
  if (map.size === 0) {
    if (payload.totals.subtotal0) map.set(0, payload.totals.subtotal0);
    if (payload.totals.subtotalVat) map.set(15, payload.totals.subtotalVat);
  }
  const groups = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([rate, base]) => ({ rate, base, value: vatOf(base, rate) }));
  const taxed = groups.filter((g) => g.rate > 0);
  if (taxed.length === 1) taxed[0].value = payload.totals.vat;
  return groups;
}

/** <totalConImpuestos> de factura y nota de crédito. */
export function totalConImpuestos(payload: SriPayload): string {
  return wrap(
    "totalConImpuestos",
    vatGroups(payload).map((g) =>
      wrap("totalImpuesto", [el("codigo", "2"), el("codigoPorcentaje", vatCode(g.rate)), el("baseImponible", money(g.base)), el("valor", money(g.value))]),
    ),
  );
}

/** <impuestos> de una línea de detalle. */
export function lineTaxes(line: SriLine): string {
  return wrap(
    "impuestos",
    wrap("impuesto", [
      el("codigo", "2"),
      el("codigoPorcentaje", vatCode(line.vatRate)),
      el("tarifa", String(line.vatRate)),
      el("baseImponible", money(line.subtotal)),
      el("valor", money(vatOf(line.subtotal, line.vatRate))),
    ]),
  );
}

export function infoTributaria(emitter: Emitter, payload: SriPayload, docCode: string, accessKey: string): string {
  return wrap("infoTributaria", [
    el("ambiente", String(emitter.environment)),
    el("tipoEmision", "1"),
    el("razonSocial", emitter.legalName),
    opt("nombreComercial", emitter.tradeName),
    el("ruc", emitter.ruc),
    el("claveAcceso", accessKey),
    el("codDoc", docCode),
    el("estab", payload.establishment.padStart(3, "0")),
    el("ptoEmi", payload.emissionPoint.padStart(3, "0")),
    el("secuencial", payload.sequential.padStart(9, "0")),
    el("dirMatriz", emitter.address),
  ]);
}

/** <infoAdicional>: email del comprador + campos extra. El XSD exige al menos un campo si el nodo existe. */
export function infoAdicional(payload: SriPayload): string {
  const fields: [string, string][] = [];
  if (payload.buyer.email?.trim()) fields.push(["email", payload.buyer.email.trim()]);
  for (const [name, value] of Object.entries(payload.additionalInfo ?? {})) {
    if (String(value ?? "").trim()) fields.push([name, String(value).trim()]);
  }
  if (!fields.length) return "";
  return wrap(
    "infoAdicional",
    fields.slice(0, 15).map(([name, value]) => `<campoAdicional nombre="${escapeAttr(name)}">${escapeText(value)}</campoAdicional>`),
  );
}

/** "SI"/"NO" del obligado a llevar contabilidad. */
export function yesNo(value: boolean): string {
  return value ? "SI" : "NO";
}

/** Número de documento "001-001-000000123" → "001001000000123" (como lo pide el XSD). */
export function docNumberDigits(number: string): string {
  return number.replace(/\D/g, "");
}

/** Número de documento con guiones, como lo piden notas de crédito/débito y guías. */
export function docNumberDashed(number: string): string {
  const d = docNumberDigits(number).padStart(15, "0");
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Raíz del comprobante: id="comprobante" (lo referencia la firma) y version. */
export function root(tag: string, version: string, children: string[]): string {
  return `<${tag} id="comprobante" version="${version}">${children.join("")}</${tag}>`;
}
