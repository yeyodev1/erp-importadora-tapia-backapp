import type { SriPayload } from "./sri.types";
import {
  type Emitter,
  docNumberDashed,
  docNumberDigits,
  el,
  infoAdicional,
  infoTributaria,
  money,
  opt,
  qty,
  root,
  sriDate,
  vatCode,
  vatGroups,
  wrap,
  yesNo,
} from "./xml.common";

/** Guía de remisión v1.1.0 y comprobante de retención v2.0.0 (orden de tags = XSD). */

/** Tipo de identificación por longitud: 13 RUC, 10 cédula, otro pasaporte. */
function idTypeOf(id: string): string {
  const d = id.trim();
  if (/^\d{13}$/.test(d)) return "04";
  if (/^\d{10}$/.test(d)) return "05";
  return "06";
}

export function buildGuiaRemision(emitter: Emitter, payload: SriPayload, accessKey: string): string {
  const s = payload.shipment;
  if (!s) throw new Error("La guía de remisión necesita los datos del traslado (shipment)");
  const info = wrap("infoGuiaRemision", [
    el("dirEstablecimiento", emitter.address),
    el("dirPartida", s.origin),
    el("razonSocialTransportista", s.carrierName),
    el("tipoIdentificacionTransportista", idTypeOf(s.carrierId)),
    el("rucTransportista", s.carrierId),
    el("obligadoContabilidad", yesNo(emitter.keepsAccounting)),
    opt("contribuyenteEspecial", emitter.specialTaxpayer),
    el("fechaIniTransporte", sriDate(s.startDate)),
    el("fechaFinTransporte", sriDate(s.endDate)),
    el("placa", s.plate),
  ]);
  const sustento = s.invoiceNumber
    ? [el("codDocSustento", "01"), el("numDocSustento", docNumberDashed(s.invoiceNumber)), el("fechaEmisionDocSustento", sriDate(payload.issueDate))]
    : [];
  const destinatario = wrap("destinatario", [
    el("identificacionDestinatario", payload.buyer.identification),
    el("razonSocialDestinatario", payload.buyer.name),
    el("dirDestinatario", s.destination || payload.buyer.address),
    el("motivoTraslado", payload.modifies?.reason || "Venta"),
    ...sustento,
    wrap(
      "detalles",
      payload.lines.map((l) => wrap("detalle", [el("codigoInterno", l.code), el("descripcion", l.description), el("cantidad", qty(l.qty))])),
    ),
  ]);
  return root("guiaRemision", "1.1.0", [
    infoTributaria(emitter, payload, "06", accessKey),
    info,
    wrap("destinatarios", destinatario),
    infoAdicional(payload),
  ]);
}

/** Porcentaje con 2 decimales (1.75, 30.00) sin flotantes raros. */
function percent(rate: number): string {
  return (Math.round(rate * 100) / 100).toFixed(2);
}

/** Código de retención de IVA del comprobante electrónico por porcentaje (no es el del ATS 721…729). */
// Ficha técnica v2.34, tabla 20 (0 % = "retención en cero", código 7).
const VAT_WITHHOLDING_CODES: Record<number, string> = { 0: "7", 10: "9", 20: "10", 30: "1", 50: "11", 70: "2", 100: "3" };

/**
 * Renta va tal cual (303, 312, 343…). IVA se traduce por la tasa: Compras manda
 * el código del ATS (721, 723…) y el SRI rechaza la retención si llega así.
 */
export function withholdingCode(tax: "1" | "2", code: string, rate: number): string {
  if (tax !== "2") return code;
  const sriCode = VAT_WITHHOLDING_CODES[Math.round(rate * 100) / 100];
  if (!sriCode) throw new Error(`Porcentaje de retención de IVA no válido para el SRI: ${rate}%`);
  return sriCode;
}

/**
 * shortcut: un solo docSustento por retención (los totales del payload son los de
 * esa factura de compra); si Compras llega a retener varias facturas en un solo
 * comprobante, el payload necesita totales por documento.
 */
export function buildRetencion(emitter: Emitter, payload: SriPayload, accessKey: string): string {
  const w = payload.withholding;
  if (!w?.lines.length) throw new Error("La retención necesita al menos una línea (withholding.lines)");
  const numbers = new Set(w.lines.map((l) => docNumberDigits(l.supportDocNumber)));
  if (numbers.size > 1) throw new Error("Una retención solo puede sustentarse en un documento");
  const first = w.lines[0];
  const t = payload.totals;
  const info = wrap("infoCompRetencion", [
    el("fechaEmision", sriDate(payload.issueDate)),
    el("dirEstablecimiento", emitter.address),
    opt("contribuyenteEspecial", emitter.specialTaxpayer),
    el("obligadoContabilidad", yesNo(emitter.keepsAccounting)),
    el("tipoIdentificacionSujetoRetenido", payload.buyer.idType),
    el("parteRel", "NO"),
    el("razonSocialSujetoRetenido", payload.buyer.name),
    el("identificacionSujetoRetenido", payload.buyer.identification),
    el("periodoFiscal", w.fiscalPeriod),
  ]);
  const impuestos = wrap(
    "impuestosDocSustento",
    vatGroups(payload).map((g) =>
      wrap("impuestoDocSustento", [
        el("codImpuestoDocSustento", "2"),
        el("codigoPorcentaje", vatCode(g.rate)),
        el("baseImponible", money(g.base)),
        el("tarifa", String(g.rate)),
        el("valorImpuesto", money(g.value)),
      ]),
    ),
  );
  const retenciones = wrap(
    "retenciones",
    w.lines.map((l) =>
      wrap("retencion", [
        el("codigo", l.tax),
        el("codigoRetencion", withholdingCode(l.tax, l.code, l.rate)),
        el("baseImponible", money(l.base)),
        el("porcentajeRetener", percent(l.rate)),
        el("valorRetenido", money(l.amount)),
      ]),
    ),
  );
  const doc = wrap("docSustento", [
    el("codSustento", w.supportCode || "01"),
    el("codDocSustento", first.supportDocCode),
    el("numDocSustento", docNumberDigits(first.supportDocNumber).padStart(15, "0")),
    el("fechaEmisionDocSustento", sriDate(first.supportDocDate)),
    el("fechaRegistroContable", sriDate(payload.issueDate)),
    opt("numAutDocSustento", first.supportDocAuthorization),
    el("pagoLocExt", "01"),
    el("totalSinImpuestos", money(t.subtotal0 + t.subtotalVat)),
    el("importeTotal", money(t.total)),
    impuestos,
    retenciones,
    wrap("pagos", wrap("pago", [el("formaPago", payload.paymentMethod || "20"), el("total", money(t.total))])),
  ]);
  return root("comprobanteRetencion", "2.0.0", [
    infoTributaria(emitter, payload, "07", accessKey),
    info,
    wrap("docsSustento", doc),
    infoAdicional(payload),
  ]);
}
