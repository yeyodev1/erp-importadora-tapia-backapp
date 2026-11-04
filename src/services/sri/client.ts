import { XMLParser } from "fast-xml-parser";

/**
 * Cliente SOAP de los web services offline del SRI. Nunca lanza: los errores
 * de red o de formato vuelven como `ok: false` con mensaje.
 */

const HOSTS = { 1: "https://celcer.sri.gob.ec", 2: "https://cel.sri.gob.ec" } as const;
const BASE = "/comprobantes-electronicos-ws";
/** Vercel corta a los 60 s: 15 s por llamada deja margen a recepción + 2 autorizaciones. */
const TIMEOUT_MS = 15_000;

export interface SriMessage {
  identificador: string;
  mensaje: string;
  informacionAdicional: string;
  tipo: string;
}

export interface ReceptionResult {
  ok: boolean;
  /** RECIBIDA | DEVUELTA ("" si falló la red). */
  state: string;
  messages: SriMessage[];
  error?: string;
}

export interface AuthorizationResult {
  ok: boolean;
  /** AUTORIZADO | NO AUTORIZADO | EN PROCESO | "" (el SRI aún no la tiene). */
  state: string;
  authorizationNumber: string;
  authorizationDate: Date | null;
  /** XML del comprobante tal como lo guarda el SRI. */
  xml: string;
  messages: SriMessage[];
  error?: string;
}

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  // Sin esto la clave de acceso de 49 dígitos se vuelve un número en notación científica.
  parseTagValue: false,
  isArray: (name) => ["mensaje", "comprobante", "autorizacion"].includes(name),
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function toMessages(node: unknown): SriMessage[] {
  const list = asArray((node as { mensaje?: unknown[] } | undefined)?.mensaje) as Record<string, unknown>[];
  return list
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      identificador: String(m.identificador ?? ""),
      mensaje: String(Array.isArray(m.mensaje) ? m.mensaje[0] : (m.mensaje ?? "")),
      informacionAdicional: String(m.informacionAdicional ?? ""),
      tipo: String(m.tipo ?? ""),
    }));
}

function envelope(ns: string, body: string): string {
  return (
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="${ns}">` +
    `<soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`
  );
}

async function post(environment: 1 | 2, service: string, soap: string): Promise<Record<string, any>> {
  const res = await fetch(`${HOSTS[environment]}${BASE}/${service}`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
    body: soap,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  const parsed = parser.parse(text);
  const body = parsed?.Envelope?.Body;
  if (!body) throw new Error(`Respuesta inesperada del SRI (HTTP ${res.status})`);
  if (body.Fault) throw new Error(`SRI: ${String(body.Fault.faultstring ?? "error SOAP")}`);
  return body;
}

function networkError(err: unknown): string {
  const e = err as Error;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "El SRI no respondió a tiempo";
  return `No se pudo conectar con el SRI: ${e?.message ?? String(err)}`;
}

/** Recepción: envía el XML firmado en base64. */
export async function validarComprobante(environment: 1 | 2, signedXml: string): Promise<ReceptionResult> {
  try {
    const b64 = Buffer.from(signedXml, "utf8").toString("base64");
    const body = await post(
      environment,
      "RecepcionComprobantesOffline",
      envelope("http://ec.gob.sri.ws.recepcion", `<ec:validarComprobante><xml>${b64}</xml></ec:validarComprobante>`),
    );
    const resp = body.validarComprobanteResponse?.RespuestaRecepcionComprobante;
    if (!resp) throw new Error("Respuesta de recepción sin RespuestaRecepcionComprobante");
    const comprobantes = asArray(resp.comprobantes?.comprobante) as Record<string, unknown>[];
    return { ok: true, state: String(resp.estado ?? ""), messages: comprobantes.flatMap((c) => toMessages(c.mensajes)) };
  } catch (err) {
    return { ok: false, state: "", messages: [], error: networkError(err) };
  }
}

/** "2026-11-04T10:15:00-05:00" o "04/11/2026 10:15:00" → Date. */
function parseSriDate(value: string): Date | null {
  if (!value) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(value);
  const d = m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}-05:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Autorización: consulta por clave de acceso. */
export async function autorizacionComprobante(environment: 1 | 2, accessKey: string): Promise<AuthorizationResult> {
  const empty = { authorizationNumber: "", authorizationDate: null, xml: "", messages: [] as SriMessage[] };
  try {
    const body = await post(
      environment,
      "AutorizacionComprobantesOffline",
      envelope(
        "http://ec.gob.sri.ws.autorizacion",
        `<ec:autorizacionComprobante><claveAccesoComprobante>${accessKey.replace(/\D/g, "")}</claveAccesoComprobante></ec:autorizacionComprobante>`,
      ),
    );
    const resp = body.autorizacionComprobanteResponse?.RespuestaAutorizacionComprobante;
    if (!resp) throw new Error("Respuesta de autorización sin RespuestaAutorizacionComprobante");
    const list = asArray(resp.autorizaciones?.autorizacion) as Record<string, any>[];
    if (!list.length) return { ok: true, state: "", ...empty };
    // El SRI devuelve el historial: si alguna quedó AUTORIZADO, esa manda.
    const auth = list.find((a) => a.estado === "AUTORIZADO") ?? list[0];
    const comprobante = asArray(auth.comprobante)[0];
    return {
      ok: true,
      state: String(auth.estado ?? ""),
      authorizationNumber: String(auth.numeroAutorizacion ?? ""),
      authorizationDate: parseSriDate(String(auth.fechaAutorizacion ?? "")),
      xml: typeof comprobante === "string" ? comprobante : "",
      messages: toMessages(auth.mensajes),
    };
  } catch (err) {
    return { ok: false, state: "", ...empty, error: networkError(err) };
  }
}

export function formatMessages(messages: SriMessage[]): string[] {
  return messages.map((m) => [m.identificador && `[${m.identificador}]`, m.mensaje, m.informacionAdicional].filter(Boolean).join(" "));
}
