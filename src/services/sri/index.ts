import { env } from "../../config/env";
import { getSettings } from "../accounting.service";
import { buildAccessKey, environmentOf, isValidAccessKey } from "./accessKey";
import { autorizacionComprobante, formatMessages, validarComprobante, type AuthorizationResult } from "./client";
import { isSigned, loadP12, signXml } from "./sign";
import { SRI_DOC_CODES, type SriPayload, type SriResult, type SriStatus } from "./sri.types";
import type { Emitter } from "./xml.common";
import { buildFactura, buildNotaCredito, buildNotaDebito } from "./xml.invoice";
import { buildGuiaRemision, buildRetencion } from "./xml.other";

export * from "./sri.types";
export { renderRide } from "./ride";

const XML_DECL = `<?xml version="1.0" encoding="UTF-8"?>`;
/** Espera antes del único reintento de autorización (el SRI suele tardar 1-3 s). */
export const AUTH_RETRY_MS = 3000;

const BUILDERS = {
  factura: buildFactura,
  notaCredito: buildNotaCredito,
  notaDebito: buildNotaDebito,
  guiaRemision: buildGuiaRemision,
  retencion: buildRetencion,
} as const;

function result(accessKey: string, status: SriStatus, xml: string, messages: string[], auth?: AuthorizationResult): SriResult {
  return {
    accessKey,
    status,
    authorizationNumber: auth?.authorizationNumber ?? "",
    authorizationDate: auth?.authorizationDate ?? null,
    messages,
    xml,
  };
}

async function emitterFromSettings(): Promise<Emitter> {
  const { company, sriEnvironment } = await getSettings();
  return { ...company, environment: sriEnvironment === 2 ? 2 : 1 };
}

/** Clave de acceso + XML sin firmar (para previsualizar o para issue). */
export async function buildXml(payload: SriPayload, emitter?: Emitter): Promise<{ accessKey: string; xml: string }> {
  const em = emitter ?? (await emitterFromSettings());
  const docCode = SRI_DOC_CODES[payload.kind];
  if (!docCode) throw new Error(`Tipo de comprobante desconocido: ${payload.kind}`);
  const accessKey = buildAccessKey({
    date: payload.issueDate,
    docCode,
    ruc: em.ruc,
    environment: em.environment,
    establishment: payload.establishment,
    emissionPoint: payload.emissionPoint,
    sequential: payload.sequential,
  });
  return { accessKey, xml: XML_DECL + BUILDERS[payload.kind](em, payload, accessKey) };
}

function credentials() {
  if (!env.SRI_P12_BASE64 || !env.SRI_P12_PASSWORD) return null;
  return loadP12(env.SRI_P12_BASE64, env.SRI_P12_PASSWORD);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function statusOf(state: string): SriStatus {
  if (state === "AUTORIZADO") return "autorizado";
  if (state === "NO AUTORIZADO") return "no_autorizado";
  return "recibido";
}

/** Autoriza con un único reintento si el SRI aún no la procesa. */
async function authorize(environment: 1 | 2, accessKey: string, xml: string): Promise<SriResult> {
  let auth = await autorizacionComprobante(environment, accessKey);
  if (!auth.ok || auth.state === "" || auth.state === "EN PROCESO") {
    await new Promise((r) => setTimeout(r, AUTH_RETRY_MS));
    auth = await autorizacionComprobante(environment, accessKey);
  }
  if (!auth.ok) return result(accessKey, "recibido", xml, [`Recibido; autorización pendiente: ${auth.error}`]);
  const status = statusOf(auth.state);
  const messages = formatMessages(auth.messages);
  if (status === "recibido") messages.push("El SRI aún procesa el comprobante: reintentar más tarde");
  return result(accessKey, status, xml, messages, auth);
}

/** Recepción + autorización de un XML ya firmado. */
async function send(environment: 1 | 2, accessKey: string, signed: string): Promise<SriResult> {
  const rec = await validarComprobante(environment, signed);
  if (!rec.ok) return result(accessKey, "error", signed, [rec.error ?? "Error de red con el SRI"]);
  // 43 = clave de acceso registrada: ya lo tenía (reenvío), se pasa a autorizar.
  const alreadyThere = rec.messages.some((m) => m.identificador === "43");
  if (rec.state === "DEVUELTA" && !alreadyThere) return result(accessKey, "devuelto", signed, formatMessages(rec.messages));
  return authorize(environment, accessKey, signed);
}

/**
 * Emite un comprobante electrónico: clave → XML → firma → recepción →
 * autorización. Nunca lanza: devuelve el estado para que el documento se grabe
 * igual y se pueda reintentar con `retry`.
 */
export async function issue(payload: SriPayload): Promise<SriResult> {
  let emitter: Emitter;
  let built: { accessKey: string; xml: string };
  try {
    emitter = await emitterFromSettings();
    built = await buildXml(payload, emitter);
  } catch (err) {
    return result("", "error", "", [`No se pudo armar el comprobante: ${errorText(err)}`]);
  }
  let signed: string;
  try {
    const creds = credentials();
    if (!creds) return result(built.accessKey, "sin_firma", built.xml, ["Falta la firma electrónica (.p12) en el servidor"]);
    signed = signXml(built.xml, creds);
  } catch (err) {
    return result(built.accessKey, "error", built.xml, [errorText(err)]);
  }
  return send(emitter.environment, built.accessKey, signed);
}

/**
 * Reintenta un comprobante: si el SRI ya lo tiene, trae su autorización; si no,
 * lo firma (si estaba sin firma) y lo vuelve a enviar.
 */
export async function retry(accessKey: string, xml: string): Promise<SriResult> {
  if (!isValidAccessKey(accessKey)) return result(accessKey, "error", xml, ["Clave de acceso inválida"]);
  const environment = environmentOf(accessKey);
  const auth = await autorizacionComprobante(environment, accessKey);
  if (!auth.ok) return result(accessKey, "error", xml, [auth.error ?? "Error de red con el SRI"]);
  if (auth.state) {
    const status = statusOf(auth.state);
    return result(accessKey, status, xml || auth.xml, formatMessages(auth.messages), auth);
  }
  if (!xml) return result(accessKey, "error", xml, ["El SRI no tiene el comprobante y no hay XML para reenviarlo"]);
  let signed = xml;
  if (!isSigned(xml)) {
    try {
      const creds = credentials();
      if (!creds) return result(accessKey, "sin_firma", xml, ["Falta la firma electrónica (.p12) en el servidor"]);
      signed = signXml(xml, creds);
    } catch (err) {
      return result(accessKey, "error", xml, [errorText(err)]);
    }
  }
  return send(environment, accessKey, signed);
}

/**
 * Trae del SRI un comprobante por su clave de acceso (p. ej. facturas de
 * proveedores). `xml` es el comprobante autorizado tal como lo guarda el SRI.
 */
export async function consultAuthorization(accessKey: string): Promise<SriResult> {
  const key = accessKey.replace(/\D/g, "");
  if (!isValidAccessKey(key)) return result(key, "error", "", ["Clave de acceso inválida"]);
  const auth = await autorizacionComprobante(environmentOf(key), key);
  if (!auth.ok) return result(key, "error", "", [auth.error ?? "Error de red con el SRI"]);
  if (!auth.state) return result(key, "error", "", ["El SRI no tiene un comprobante con esa clave de acceso"]);
  return result(key, statusOf(auth.state), auth.xml, formatMessages(auth.messages), auth);
}
