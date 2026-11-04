import type { SriPayload } from "./sri.types";
import {
  type Emitter,
  docNumberDashed,
  el,
  infoAdicional,
  infoTributaria,
  lineTaxes,
  money,
  opt,
  qty,
  root,
  sriDate,
  totalConImpuestos,
  unitPrice,
  vatCode,
  vatGroups,
  wrap,
  yesNo,
} from "./xml.common";

/**
 * Factura v1.1.0, nota de crédito v1.1.0 y nota de débito v1.0.0.
 * El orden de los tags es el del XSD (xs:sequence): no reordenar.
 * shortcut: dirEstablecimiento = dirección matriz (Settings no guarda la de cada establecimiento); agregarla al catálogo de bodegas cuando UIO la exija en el RIDE.
 */

function buyerBlock(payload: SriPayload): string[] {
  return [
    el("tipoIdentificacionComprador", payload.buyer.idType),
    el("razonSocialComprador", payload.buyer.name),
    el("identificacionComprador", payload.buyer.identification),
  ];
}

function pagos(payload: SriPayload): string {
  const days = payload.creditDays ?? 0;
  return wrap(
    "pagos",
    wrap("pago", [
      el("formaPago", payload.paymentMethod || "20"),
      el("total", money(payload.totals.total)),
      ...(days > 0 ? [el("plazo", String(days)), el("unidadTiempo", "dias")] : []),
    ]),
  );
}

function modifies(payload: SriPayload) {
  if (!payload.modifies) throw new Error("La nota necesita el documento que modifica (modifies)");
  return payload.modifies;
}

export function buildFactura(emitter: Emitter, payload: SriPayload, accessKey: string): string {
  const t = payload.totals;
  const info = wrap("infoFactura", [
    el("fechaEmision", sriDate(payload.issueDate)),
    el("dirEstablecimiento", emitter.address),
    opt("contribuyenteEspecial", emitter.specialTaxpayer),
    el("obligadoContabilidad", yesNo(emitter.keepsAccounting)),
    ...buyerBlock(payload),
    opt("direccionComprador", payload.buyer.address),
    el("totalSinImpuestos", money(t.subtotal0 + t.subtotalVat)),
    el("totalDescuento", money(t.discount)),
    totalConImpuestos(payload),
    el("propina", "0.00"),
    el("importeTotal", money(t.total)),
    el("moneda", "DOLAR"),
    pagos(payload),
  ]);
  const detalles = wrap(
    "detalles",
    payload.lines.map((l) =>
      wrap("detalle", [
        el("codigoPrincipal", l.code),
        el("descripcion", l.description),
        el("cantidad", qty(l.qty)),
        el("precioUnitario", unitPrice(l.unitPrice)),
        el("descuento", money(l.discount)),
        el("precioTotalSinImpuesto", money(l.subtotal)),
        lineTaxes(l),
      ]),
    ),
  );
  return root("factura", "1.1.0", [infoTributaria(emitter, payload, "01", accessKey), info, detalles, infoAdicional(payload)]);
}

export function buildNotaCredito(emitter: Emitter, payload: SriPayload, accessKey: string): string {
  const t = payload.totals;
  const mod = modifies(payload);
  const info = wrap("infoNotaCredito", [
    el("fechaEmision", sriDate(payload.issueDate)),
    el("dirEstablecimiento", emitter.address),
    ...buyerBlock(payload),
    opt("contribuyenteEspecial", emitter.specialTaxpayer),
    el("obligadoContabilidad", yesNo(emitter.keepsAccounting)),
    el("codDocModificado", mod.docCode),
    el("numDocModificado", docNumberDashed(mod.number)),
    el("fechaEmisionDocSustento", sriDate(mod.date)),
    el("totalSinImpuestos", money(t.subtotal0 + t.subtotalVat)),
    el("valorModificacion", money(t.total)),
    el("moneda", "DOLAR"),
    totalConImpuestos(payload),
    el("motivo", mod.reason),
  ]);
  const detalles = wrap(
    "detalles",
    payload.lines.map((l) =>
      wrap("detalle", [
        el("codigoInterno", l.code),
        el("descripcion", l.description),
        el("cantidad", qty(l.qty)),
        el("precioUnitario", unitPrice(l.unitPrice)),
        el("descuento", money(l.discount)),
        el("precioTotalSinImpuesto", money(l.subtotal)),
        lineTaxes(l),
      ]),
    ),
  );
  return root("notaCredito", "1.1.0", [infoTributaria(emitter, payload, "04", accessKey), info, detalles, infoAdicional(payload)]);
}

export function buildNotaDebito(emitter: Emitter, payload: SriPayload, accessKey: string): string {
  const t = payload.totals;
  const mod = modifies(payload);
  const impuestos = wrap(
    "impuestos",
    vatGroups(payload).map((g) =>
      wrap("impuesto", [
        el("codigo", "2"),
        el("codigoPorcentaje", vatCode(g.rate)),
        el("tarifa", String(g.rate)),
        el("baseImponible", money(g.base)),
        el("valor", money(g.value)),
      ]),
    ),
  );
  const info = wrap("infoNotaDebito", [
    el("fechaEmision", sriDate(payload.issueDate)),
    el("dirEstablecimiento", emitter.address),
    ...buyerBlock(payload),
    opt("contribuyenteEspecial", emitter.specialTaxpayer),
    el("obligadoContabilidad", yesNo(emitter.keepsAccounting)),
    el("codDocModificado", mod.docCode),
    el("numDocModificado", docNumberDashed(mod.number)),
    el("fechaEmisionDocSustento", sriDate(mod.date)),
    el("totalSinImpuestos", money(t.subtotal0 + t.subtotalVat)),
    impuestos,
    el("valorTotal", money(t.total)),
    pagos(payload),
  ]);
  // Cada línea del payload es un motivo (razón + valor sin impuestos).
  const motivos = wrap(
    "motivos",
    payload.lines.map((l) => wrap("motivo", [el("razon", l.description || mod.reason), el("valor", money(l.subtotal))])),
  );
  return root("notaDebito", "1.0.0", [infoTributaria(emitter, payload, "05", accessKey), info, motivos, infoAdicional(payload)]);
}
