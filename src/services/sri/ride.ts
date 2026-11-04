import { XMLParser } from "fast-xml-parser";
import { code128Svg } from "./code128";
import type { SriPayload, SriResult } from "./sri.types";
import { money, sriDate } from "./xml.common";

/**
 * RIDE (representación impresa) en HTML listo para imprimir. Dos formatos:
 * "a4" (la factura grande) y "ticket" (80 mm, la pequeña que firma el cliente).
 * Los datos del emisor salen del propio XML (infoTributaria), así el RIDE
 * muestra exactamente lo que se firmó.
 */

export type RideFormat = "a4" | "ticket";

const TITLES: Record<SriPayload["kind"], string> = {
  factura: "FACTURA",
  notaCredito: "NOTA DE CRÉDITO",
  notaDebito: "NOTA DE DÉBITO",
  guiaRemision: "GUÍA DE REMISIÓN",
  retencion: "COMPROBANTE DE RETENCIÓN",
};

const STATUS_LABEL: Record<SriResult["status"], string> = {
  sin_firma: "PENDIENTE DE FIRMA",
  firmado: "FIRMADO, NO ENVIADO",
  recibido: "RECIBIDO, EN PROCESO DE AUTORIZACIÓN",
  autorizado: "AUTORIZADO",
  devuelto: "DEVUELTO POR EL SRI",
  no_autorizado: "NO AUTORIZADO",
  error: "PENDIENTE DE ENVÍO",
};

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });

function h(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function issuerFromXml(xml: string): Record<string, string> {
  if (!xml) return {};
  try {
    const doc = parser.parse(xml) as Record<string, any>;
    const rootNode = Object.values(doc).find((v) => v && typeof v === "object" && v.infoTributaria) as Record<string, any> | undefined;
    if (!rootNode) return {};
    const info = Object.entries(rootNode).find(([k]) => k.startsWith("info") && k !== "infoTributaria" && k !== "infoAdicional")?.[1] ?? {};
    return { ...rootNode.infoTributaria, obligadoContabilidad: info.obligadoContabilidad ?? "", contribuyenteEspecial: info.contribuyenteEspecial ?? "" };
  } catch {
    return {};
  }
}

function row(label: string, value: unknown): string {
  return value === undefined || value === null || value === "" ? "" : `<div class="kv"><span>${h(label)}</span><b>${h(value)}</b></div>`;
}

function dateTime(d: Date | null): string {
  if (!d) return "";
  const local = new Date(new Date(d).getTime() - 5 * 3600 * 1000).toISOString();
  return `${sriDate(d)} ${local.slice(11, 19)}`;
}

function detailTable(payload: SriPayload, format: RideFormat): string {
  if (payload.kind === "retencion") {
    const rows = (payload.withholding?.lines ?? [])
      .map(
        (l) =>
          `<tr><td>${h(l.supportDocNumber)}</td><td>${l.tax === "1" ? "RENTA" : "IVA"}</td><td>${h(l.code)}</td>` +
          `<td class="n">${money(l.base)}</td><td class="n">${h(l.rate)}%</td><td class="n">${money(l.amount)}</td></tr>`,
      )
      .join("");
    return `<table><thead><tr><th>Comprobante</th><th>Impuesto</th><th>Código</th><th class="n">Base</th><th class="n">%</th><th class="n">Retenido</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  if (format === "ticket") {
    const rows = payload.lines
      .map((l) => `<tr><td colspan="3">${h(l.description)}</td></tr><tr><td>${h(l.qty)} x ${money(Math.round(l.unitPrice))}</td><td></td><td class="n">${money(l.subtotal)}</td></tr>`)
      .join("");
    return `<table><tbody>${rows}</tbody></table>`;
  }
  const rows = payload.lines
    .map(
      (l) =>
        `<tr><td>${h(l.code)}</td><td class="n">${h(l.qty)}</td><td>${h(l.description)}</td>` +
        `<td class="n">${(l.unitPrice / 100).toFixed(4)}</td><td class="n">${money(l.discount)}</td><td class="n">${money(l.subtotal)}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Código</th><th class="n">Cant.</th><th>Descripción</th><th class="n">P. unitario</th><th class="n">Desc.</th><th class="n">Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function totalsBlock(payload: SriPayload): string {
  if (payload.kind === "retencion") {
    const total = (payload.withholding?.lines ?? []).reduce((a, l) => a + l.amount, 0);
    return `<div class="totals">${row("TOTAL RETENIDO", money(total))}</div>`;
  }
  if (payload.kind === "guiaRemision") return "";
  const t = payload.totals;
  const vatRate = payload.lines.find((l) => l.vatRate > 0)?.vatRate ?? 15;
  return (
    `<div class="totals">` +
    row(`SUBTOTAL ${vatRate}%`, money(t.subtotalVat)) +
    row("SUBTOTAL 0%", money(t.subtotal0)) +
    row("DESCUENTO", money(t.discount)) +
    row(`IVA ${vatRate}%`, money(t.vat)) +
    `<div class="kv grand"><span>VALOR TOTAL</span><b>${money(t.total)}</b></div></div>`
  );
}

const CSS = {
  a4: `@page{size:A4;margin:12mm}body{font:11px/1.35 Arial,sans-serif;color:#000;margin:0}
.head{display:flex;gap:12px}.box{border:1px solid #000;border-radius:6px;padding:8px;flex:1}
.bar{height:48px;width:100%}.bar svg{width:100%;height:100%}`,
  ticket: `@page{size:80mm auto;margin:3mm}body{font:10px/1.3 Arial,sans-serif;color:#000;margin:0;width:74mm}
.head{display:flex;flex-direction:column;gap:4px}.box{padding:4px 0;border-bottom:1px dashed #000}
.bar{height:36px;width:100%}.bar svg{width:100%;height:100%}`,
};

const COMMON_CSS = `h1{font-size:1.3em;margin:0 0 4px}h2{font-size:1.1em;margin:0 0 4px}
.kv{display:flex;justify-content:space-between;gap:8px}.kv span{color:#333}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{padding:3px 4px;border-bottom:1px solid #ccc;text-align:left;vertical-align:top}
.n{text-align:right;white-space:nowrap}.totals{margin-left:auto;max-width:260px;margin-top:8px}.grand{font-size:1.15em;border-top:1px solid #000;padding-top:2px}
.key{font-family:monospace;font-size:.85em;word-break:break-all;text-align:center}.status{font-weight:bold}
.sign{margin-top:36px;border-top:1px solid #000;text-align:center;padding-top:2px}`;

/** HTML imprimible del comprobante. */
export function renderRide(payload: SriPayload, result: SriResult, format: RideFormat = "a4"): string {
  const it = issuerFromXml(result.xml);
  const number = `${payload.establishment.padStart(3, "0")}-${payload.emissionPoint.padStart(3, "0")}-${payload.sequential.padStart(9, "0")}`;
  const key = result.accessKey;
  const environment = (it.ambiente ?? key[23]) === "2" ? "PRODUCCIÓN" : "PRUEBAS";
  const barcode = /^\d{49}$/.test(key) ? `<div class="bar">${code128Svg(key)}</div>` : "";
  const extra = Object.entries({ Email: payload.buyer.email, ...(payload.additionalInfo ?? {}) })
    .map(([k, v]) => row(k, v))
    .join("");
  const modifies = payload.modifies
    ? row("Comprobante que modifica", `${payload.modifies.number} (${sriDate(payload.modifies.date)})`) + row("Motivo", payload.modifies.reason)
    : "";
  const shipment = payload.shipment
    ? row("Transportista", `${payload.shipment.carrierName} (${payload.shipment.carrierId})`) +
      row("Placa", payload.shipment.plate) +
      row("Partida", payload.shipment.origin) +
      row("Destino", payload.shipment.destination) +
      row("Traslado", `${sriDate(payload.shipment.startDate)} al ${sriDate(payload.shipment.endDate)}`)
    : "";

  const issuer =
    `<div class="box"><h1>${h(it.nombreComercial || it.razonSocial || "")}</h1>` +
    row("Razón social", it.razonSocial) +
    row("Dirección matriz", it.dirMatriz) +
    row("Contribuyente especial Nro.", it.contribuyenteEspecial) +
    row("Obligado a llevar contabilidad", it.obligadoContabilidad) +
    `</div>`;
  const doc =
    `<div class="box">` +
    row("R.U.C.", it.ruc) +
    `<h2>${TITLES[payload.kind]}</h2>` +
    row("No.", number) +
    row("Número de autorización", result.authorizationNumber || "—") +
    row("Fecha y hora de autorización", dateTime(result.authorizationDate)) +
    row("Ambiente", environment) +
    row("Emisión", "NORMAL") +
    `<div class="status">${STATUS_LABEL[result.status]}</div>` +
    `<div>CLAVE DE ACCESO</div>${barcode}<div class="key">${h(key)}</div>` +
    `</div>`;
  const buyer =
    `<div class="box">` +
    row(payload.kind === "retencion" ? "Sujeto retenido" : payload.kind === "guiaRemision" ? "Destinatario" : "Cliente", payload.buyer.name) +
    row("Identificación", payload.buyer.identification) +
    row("Fecha de emisión", sriDate(payload.issueDate)) +
    row("Dirección", payload.buyer.address) +
    row("Período fiscal", payload.withholding?.fiscalPeriod) +
    modifies +
    shipment +
    `</div>`;

  return (
    `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${TITLES[payload.kind]} ${number}</title>` +
    `<style>${CSS[format]}${COMMON_CSS}</style></head><body>` +
    `<div class="head">${issuer}${doc}</div>${buyer}` +
    detailTable(payload, format) +
    totalsBlock(payload) +
    (extra ? `<div class="box">${extra}</div>` : "") +
    (format === "ticket" && payload.kind === "factura" ? `<div class="sign">Recibí conforme · Firma del cliente</div>` : "") +
    `</body></html>`
  );
}
