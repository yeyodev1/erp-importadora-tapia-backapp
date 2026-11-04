import { XMLBuilder } from "fast-xml-parser";
import type { AtsData } from "./ats.service";
import { VAT_RET_FIELDS } from "./ats.service";

/**
 * XML del ATS desde los datos de ats.service. El orden de los elementos es el
 * de la ficha técnica (el XSD del SRI valida secuencia). Montos con 2
 * decimales armados desde centavos enteros, sin pasar por floats.
 */

/** 12345 → "123.45"; -5 → "-0.05". */
export function amount(c: number): string {
  const abs = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Porcentaje de retención (1.75, 2, 10) con 2 decimales; no es dinero. */
const percent = (rate: number) => (Math.round(rate * 100) / 100).toFixed(2);

/** Fecha de documento (mediodía UTC) → dd/mm/aaaa. */
export function atsDate(d: Date): string {
  const iso = new Date(d).toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function compra(c: AtsData["compras"][number]) {
  const out: Record<string, unknown> = {
    codSustento: c.codSustento,
    tpIdProv: c.tpIdProv,
    idProv: c.idProv,
    tipoComprobante: c.tipoComprobante,
    parteRel: c.parteRel,
    fechaRegistro: atsDate(c.fechaRegistro),
    establecimiento: c.establecimiento,
    puntoEmision: c.puntoEmision,
    secuencial: c.secuencial,
    fechaEmision: atsDate(c.fechaEmision),
    autorizacion: c.autorizacion,
    baseNoGraIva: amount(c.baseNoGraIva),
    baseImponible: amount(c.baseImponible),
    baseImpGrav: amount(c.baseImpGrav),
    baseImpExe: amount(c.baseImpExe),
    montoIce: amount(c.montoIce),
    montoIva: amount(c.montoIva),
    ...Object.fromEntries(Object.values(VAT_RET_FIELDS).map((f) => [f, amount((c as any)[f])])),
    totbasesImpReemb: amount(c.totbasesImpReemb),
    pagoExterior: { pagoLocExt: c.pagoLocExt, paisEfecPago: "NA", aplicConvDobTrib: "NA", pagExtSujRetNorLeg: "NA" },
  };
  if (c.formaPago) out.formasDePago = { formaPago: c.formaPago };
  if (c.air.length) {
    out.air = {
      detalleAir: c.air.map((a: any) => ({ codRetAir: a.codRetAir, baseImpAir: amount(a.baseImpAir), porcentajeAir: percent(a.porcentajeAir), valRetAir: amount(a.valRetAir) })),
    };
  }
  if (c.retencion) Object.assign(out, { ...c.retencion, fechaEmiRet1: atsDate(c.retencion.fechaEmiRet1) });
  if (c.modificado) Object.assign(out, c.modificado);
  return out;
}

function venta(v: AtsData["ventas"][number]) {
  return {
    tpIdCliente: v.tpIdCliente,
    idCliente: v.idCliente,
    ...(v.parteRelVtas ? { parteRelVtas: v.parteRelVtas } : {}),
    tipoComprobante: v.tipoComprobante,
    tipoEmision: v.tipoEmision,
    numeroComprobantes: String(v.numeroComprobantes),
    baseNoGraIva: amount(v.baseNoGraIva),
    baseImponible: amount(v.baseImponible),
    baseImpGrav: amount(v.baseImpGrav),
    montoIva: amount(v.montoIva),
    montoIce: amount(v.montoIce),
    valorRetIva: amount(v.valorRetIva),
    valorRetRenta: amount(v.valorRetRenta),
    ...(v.formasDePago.length ? { formasDePago: { formaPago: v.formasDePago } } : {}),
  };
}

export function atsXml(ats: AtsData): string {
  const i = ats.informante;
  const iva: Record<string, unknown> = {
    TipoIDInformante: i.TipoIDInformante,
    IdInformante: i.IdInformante,
    razonSocial: i.razonSocial,
    Anio: i.Anio,
    Mes: i.Mes,
    numEstabRuc: i.numEstabRuc,
    totalVentas: amount(i.totalVentas),
    codigoOperativo: i.codigoOperativo,
  };
  if (ats.compras.length) iva.compras = { detalleCompras: ats.compras.map(compra) };
  if (ats.ventas.length) iva.ventas = { detalleVentas: ats.ventas.map(venta) };
  iva.ventasEstablecimiento = {
    ventaEst: ats.ventasEstablecimiento.map((v) => ({ codEstab: v.codEstab, ventasEstab: amount(v.ventasEstab), ivaComp: amount(v.ivaComp) })),
  };
  if (ats.anulados.length) iva.anulados = { detalleAnulados: ats.anulados };
  const builder = new XMLBuilder({ ignoreAttributes: false, format: true });
  return builder.build({ "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" }, iva });
}
