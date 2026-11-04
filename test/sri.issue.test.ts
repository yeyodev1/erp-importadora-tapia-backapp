import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown } from "./helpers";
import { isValidAccessKey } from "../src/services/sri/accessKey";
import { invoicePayload, testP12 } from "./sri.fixtures";

// env.ts exige DB_URI al cargarse: se importa después de levantar la base en memoria.
let sri: typeof import("../src/services/sri");
let mutableEnv: { SRI_P12_BASE64: string; SRI_P12_PASSWORD: string };
before(async () => {
  await setup();
  sri = await import("../src/services/sri");
  mutableEnv = (await import("../src/config/env")).env as typeof mutableEnv;
  // Un .env local con la firma real no debe colarse en las pruebas.
  mutableEnv.SRI_P12_BASE64 = "";
  mutableEnv.SRI_P12_PASSWORD = "";
});
after(teardown);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mutableEnv.SRI_P12_BASE64 = "";
  mutableEnv.SRI_P12_PASSWORD = "";
});

/** fetch falso: responde según el servicio y guarda lo que se envió. */
function mockSri(reception: string, authorizations: string[]) {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: String(init.body) });
    const xml = String(url).endsWith("RecepcionComprobantesOffline") ? reception : (authorizations.shift() ?? "");
    return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
  }) as typeof fetch;
  return calls;
}

const soap = (inner: string) => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
const recibida = soap(
  `<ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>RECIBIDA</estado><comprobantes/></RespuestaRecepcionComprobante></ns2:validarComprobanteResponse>`,
);
const devuelta = soap(
  `<ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion"><RespuestaRecepcionComprobante><estado>DEVUELTA</estado><comprobantes><comprobante><claveAcceso>x</claveAcceso><mensajes><mensaje><identificador>35</identificador><mensaje>ARCHIVO NO CUMPLE ESTRUCTURA XML</mensaje><informacionAdicional>detalle</informacionAdicional><tipo>ERROR</tipo></mensaje></mensajes></comprobante></comprobantes></RespuestaRecepcionComprobante></ns2:validarComprobanteResponse>`,
);
const autorizado = (key: string) =>
  soap(
    `<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante><claveAccesoConsultada>${key}</claveAccesoConsultada><numeroComprobantes>1</numeroComprobantes><autorizaciones><autorizacion><estado>AUTORIZADO</estado><numeroAutorizacion>${key}</numeroAutorizacion><fechaAutorizacion>2026-11-04T10:15:00-05:00</fechaAutorizacion><ambiente>PRUEBAS</ambiente><comprobante><![CDATA[<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante"></factura>]]></comprobante><mensajes/></autorizacion></autorizaciones></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse>`,
  );
const sinAutorizaciones = soap(
  `<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion"><RespuestaAutorizacionComprobante><claveAccesoConsultada>1</claveAccesoConsultada><numeroComprobantes>0</numeroComprobantes><autorizaciones/></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse>`,
);

test("issue sin .p12 devuelve sin_firma con XML y clave, sin tocar la red", async () => {
  globalThis.fetch = (async () => {
    throw new Error("no debe llamar al SRI");
  }) as typeof fetch;
  const res = await sri.issue(invoicePayload());
  assert.equal(res.status, "sin_firma");
  assert.ok(isValidAccessKey(res.accessKey));
  assert.ok(res.accessKey.startsWith("04112026010993014214001"), "fecha + factura + RUC de Settings + ambiente pruebas");
  assert.ok(res.xml.includes(`<claveAcceso>${res.accessKey}</claveAcceso>`));
  assert.ok(!res.xml.includes("ds:Signature"));
});

test("issue con payload inválido devuelve error, no lanza", async () => {
  const res = await sri.issue({ ...invoicePayload(), lines: [{ ...invoicePayload().lines[0], vatRate: 7 }] });
  assert.equal(res.status, "error");
  assert.match(res.messages[0], /Tarifa de IVA/);
});

test("issue firma, envía a pruebas y queda autorizado", async () => {
  const p12 = testP12("clave");
  mutableEnv.SRI_P12_BASE64 = p12.base64;
  mutableEnv.SRI_P12_PASSWORD = "clave";
  const { accessKey } = await sri.buildXml(invoicePayload());
  const calls = mockSri(recibida, [autorizado(accessKey)]);
  const res = await sri.issue(invoicePayload());
  assert.equal(res.status, "autorizado");
  assert.equal(res.accessKey, accessKey);
  assert.equal(res.authorizationNumber, accessKey);
  assert.equal(res.authorizationDate?.toISOString(), "2026-11-04T15:15:00.000Z");
  assert.ok(res.xml.includes("</ds:Signature></factura>"));
  assert.equal(calls[0].url, "https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline");
  const sent = /<xml>([^<]+)<\/xml>/.exec(calls[0].body)![1];
  assert.equal(Buffer.from(sent, "base64").toString("utf8"), res.xml);
  assert.ok(calls[1].body.includes(`<claveAccesoComprobante>${accessKey}</claveAccesoComprobante>`));
});

test("issue devuelto trae los mensajes del SRI", async () => {
  const p12 = testP12("clave");
  mutableEnv.SRI_P12_BASE64 = p12.base64;
  mutableEnv.SRI_P12_PASSWORD = "clave";
  mockSri(devuelta, []);
  const res = await sri.issue(invoicePayload());
  assert.equal(res.status, "devuelto");
  assert.deepEqual(res.messages, ["[35] ARCHIVO NO CUMPLE ESTRUCTURA XML detalle"]);
});

test("error de red en recepción → status error, sin lanzar", async () => {
  const p12 = testP12("clave");
  mutableEnv.SRI_P12_BASE64 = p12.base64;
  mutableEnv.SRI_P12_PASSWORD = "clave";
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const res = await sri.issue(invoicePayload());
  assert.equal(res.status, "error");
  assert.match(res.messages[0], /No se pudo conectar con el SRI/);
  assert.ok(res.xml.includes("ds:Signature"), "conserva el XML firmado para reintentar");
});

test("retry: sin_firma se firma y envía; recibido sin autorización sigue recibido", async () => {
  const pending = await sri.issue(invoicePayload());
  assert.equal(pending.status, "sin_firma");
  const p12 = testP12("clave");
  mutableEnv.SRI_P12_BASE64 = p12.base64;
  mutableEnv.SRI_P12_PASSWORD = "clave";
  // 1ª consulta: el SRI no lo tiene → firma y envía → 2 consultas sin respuesta → recibido.
  const calls = mockSri(recibida, [sinAutorizaciones, sinAutorizaciones, sinAutorizaciones]);
  const res = await sri.retry(pending.accessKey, pending.xml);
  assert.equal(res.status, "recibido");
  assert.ok(res.xml.includes("ds:Signature"));
  assert.equal(calls.filter((c) => c.url.endsWith("RecepcionComprobantesOffline")).length, 1);
});

test("consultAuthorization trae el XML del comprobante recibido", async () => {
  const key = "2110201101179214673900110020010000000011234567813";
  const calls = mockSri("", [autorizado(key)]);
  const res = await sri.consultAuthorization(key);
  assert.equal(res.status, "autorizado");
  assert.ok(res.xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?><factura`));
  assert.ok(calls[0].url.startsWith("https://celcer.sri.gob.ec/"), "ambiente 1 de la clave → pruebas");
  assert.equal((await sri.consultAuthorization("123")).status, "error");
});

test("RIDE A4 y ticket", async () => {
  const res = await sri.issue(invoicePayload());
  const a4 = sri.renderRide(invoicePayload(), res);
  assert.ok(a4.includes("IMPORTADORA TAPIA BERZOZA IMCATABE CIA. LTDA."));
  assert.ok(a4.includes(res.accessKey));
  assert.ok(a4.includes("<svg"));
  assert.ok(a4.includes("192.68"));
  assert.ok(a4.includes("Pérez &amp; Hijos &lt;SA&gt;"));
  assert.ok(a4.includes("size:A4"));
  const ticket = sri.renderRide(invoicePayload(), res, "ticket");
  assert.ok(ticket.includes("size:80mm"));
  assert.ok(ticket.includes("Firma del cliente"));
});
