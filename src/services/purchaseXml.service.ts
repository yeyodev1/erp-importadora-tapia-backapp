import { XMLParser } from "fast-xml-parser";
import { CustomError } from "../errors/customError.error";
import { Party, ID_TYPES } from "../models/party.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { roundCents } from "../utils/money";
import { getSettings } from "./accounting.service";

/**
 * Lee el XML de una factura electrónica de proveedor tal como llega al correo
 * de contabilidad o como lo entrega el SRI (envuelto en <autorizacion> con el
 * comprobante en CDATA). Solo extrae datos: grabar es createInvoice.
 */

// parseTagValue false: el RUC, el secuencial y la clave de acceso son texto con ceros a la izquierda.
const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["detalle", "totalImpuesto", "impuesto", "pago"].includes(name),
});

/** codigoPorcentaje de IVA (código 2) que son tarifa 0: 0 %, no objeto, exento. */
const VAT_ZERO = ["0", "6", "7"];

const toCents = (value: unknown) => roundCents(Number(value ?? 0) * 100);

export interface ParsedInvoice {
  supplier: { ruc: string; name: string; tradeName: string; address: string; existingId: string | null };
  invoice: {
    docType: string;
    docNumber: string;
    date: string;
    accessKey: string;
    authorization: string;
    base0: number;
    baseVat: number;
    vat: number;
    total: number;
    paymentMethod: string;
    creditDays: number;
    lines: { code: string; description: string; qty: number; unitPrice: number; discount: number; subtotal: number; vatRate: number }[];
  };
  buyerRuc: string;
  warnings: string[];
}

function findKey(node: any, key: string): any {
  if (!node || typeof node !== "object") return null;
  if (key in node) return Array.isArray(node[key]) ? node[key][0] : node[key];
  for (const child of Object.values(node)) {
    const found = findKey(child, key);
    if (found) return found;
  }
  return null;
}

/** dd/mm/aaaa → aaaa-mm-dd */
function isoDay(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? ""));
  if (!m) throw new CustomError(`Fecha de emisión inválida en el XML: ${value}`, 400);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function parseInvoiceXml(xml: string): Omit<ParsedInvoice, "supplier" | "warnings"> & {
  supplier: Omit<ParsedInvoice["supplier"], "existingId">;
} {
  if (!xml || typeof xml !== "string") throw new CustomError("Envía el XML de la factura", 400);
  let root: any;
  let authorization = "";
  try {
    root = parser.parse(xml);
    const auth = findKey(root, "autorizacion");
    if (auth?.comprobante) {
      authorization = String(auth.numeroAutorizacion ?? "");
      root = parser.parse(String(auth.comprobante));
    }
  } catch (error) {
    if (error instanceof CustomError) throw error;
    throw new CustomError("El XML no se pudo leer", 400);
  }
  const fac = root.factura;
  if (!fac?.infoTributaria || !fac?.infoFactura) throw new CustomError("El XML no es una factura electrónica", 400);
  const it = fac.infoTributaria;
  const inf = fac.infoFactura;

  let base0 = 0;
  let baseVat = 0;
  let vat = 0;
  for (const t of inf.totalConImpuestos?.totalImpuesto ?? []) {
    if (String(t.codigo) !== "2") continue;
    if (VAT_ZERO.includes(String(t.codigoPorcentaje))) base0 += toCents(t.baseImponible);
    else {
      baseVat += toCents(t.baseImponible);
      vat += toCents(t.valor);
    }
  }

  const lines = (fac.detalles?.detalle ?? []).map((d: any) => {
    const tax = (d.impuestos?.impuesto ?? []).find((i: any) => String(i.codigo) === "2");
    return {
      code: String(d.codigoPrincipal ?? ""),
      description: String(d.descripcion ?? ""),
      qty: Number(d.cantidad ?? 0),
      unitPrice: Number(d.precioUnitario ?? 0) * 100,
      discount: toCents(d.descuento),
      subtotal: toCents(d.precioTotalSinImpuesto),
      vatRate: Number(tax?.tarifa ?? 0),
    };
  });
  const pago = inf.pagos?.pago?.[0];
  const accessKey = String(it.claveAcceso ?? "");

  return {
    supplier: {
      ruc: String(it.ruc ?? ""),
      name: String(it.razonSocial ?? ""),
      tradeName: String(it.nombreComercial ?? ""),
      address: String(inf.dirEstablecimiento || it.dirMatriz || ""),
    },
    invoice: {
      docType: String(it.codDoc ?? "01"),
      docNumber: `${it.estab}-${it.ptoEmi}-${it.secuencial}`,
      date: isoDay(inf.fechaEmision),
      accessKey,
      // La factura electrónica se autoriza con su misma clave de acceso.
      authorization: authorization || accessKey,
      base0,
      baseVat,
      vat,
      total: toCents(inf.importeTotal),
      paymentMethod: String(pago?.formaPago ?? "20"),
      creditDays: pago?.unidadTiempo === "dias" ? Number(pago.plazo ?? 0) : 0,
      lines,
    },
    buyerRuc: String(inf.identificacionComprador ?? ""),
  };
}

/** Factura vigente ya ingresada con esa clave de acceso o con ese RUC + número. */
export async function findDuplicate(q: { accessKey?: string; supplierRuc: string; docType: string; docNumber: string }, session?: any) {
  const or: Record<string, unknown>[] = [{ supplierRuc: q.supplierRuc, docType: q.docType, docNumber: q.docNumber }];
  if (q.accessKey) or.push({ accessKey: q.accessKey });
  return PurchaseInvoice.findOne({ status: "vigente", $or: or }).session(session ?? null).select("_id").lean<any>();
}

/**
 * Importa un XML: si ya está ingresado responde { duplicate, existingId }; si
 * no, devuelve los datos para el formulario. Con createSupplier crea el
 * proveedor que no exista (o marca como proveedor al tercero que ya existe).
 */
export async function importXml(xml: string, opts: { createSupplier?: boolean } = {}) {
  const parsed = parseInvoiceXml(xml);
  const dup = await findDuplicate({ ...parsed.invoice, supplierRuc: parsed.supplier.ruc });
  if (dup) return { duplicate: true, existingId: String(dup._id), accessKey: parsed.invoice.accessKey, docNumber: parsed.invoice.docNumber };

  const warnings: string[] = [];
  const { company } = await getSettings();
  if (company.ruc && parsed.buyerRuc && parsed.buyerRuc !== company.ruc) {
    warnings.push(`La factura está emitida a ${parsed.buyerRuc}, no al RUC de la empresa (${company.ruc})`);
  }
  if (parsed.invoice.base0 + parsed.invoice.baseVat + parsed.invoice.vat !== parsed.invoice.total) {
    warnings.push("El total del XML no es base 0 + base IVA + IVA (puede traer ICE, propina u otros cargos)");
  }

  let party = await Party.findOne({ identification: parsed.supplier.ruc }).lean<any>();
  if (opts.createSupplier) {
    party = party
      ? await Party.findByIdAndUpdate(party._id, { isSupplier: true }, { new: true }).lean<any>()
      : (
          await Party.create({
            identification: parsed.supplier.ruc,
            idType: parsed.supplier.ruc.length === 13 ? ID_TYPES.RUC : ID_TYPES.CEDULA,
            name: parsed.supplier.name,
            address: parsed.supplier.address,
            isSupplier: true,
          })
        ).toObject();
  }
  return {
    duplicate: false,
    ...parsed,
    supplier: { ...parsed.supplier, existingId: party ? String(party._id) : null },
    warnings,
  };
}

/** Lote de XML (los descargados del SRI): separa los pendientes por ingresar de los ya ingresados. */
export async function importBatch(xmls: unknown) {
  if (!Array.isArray(xmls) || !xmls.length) throw new CustomError("Envía la lista de XML en 'xmls'", 400);
  const pending: unknown[] = [];
  const registered: unknown[] = [];
  const errors: { index: number; message: string }[] = [];
  for (const [index, xml] of xmls.entries()) {
    try {
      const result: any = await importXml(String(xml));
      (result.duplicate ? registered : pending).push({ index, ...result });
    } catch (error: any) {
      errors.push({ index, message: error?.message ?? "Error al leer el XML" });
    }
  }
  return { pending, registered, errors, total: xmls.length };
}
