import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, verify } from "node:crypto";
import forge from "node-forge";
import { day } from "./helpers";
import { buildAccessKey, isValidAccessKey, mod11 } from "../src/services/sri/accessKey";
import { money, qty, unitPrice } from "../src/services/sri/xml.common";
import { buildFactura } from "../src/services/sri/xml.invoice";
import { buildRetencion, withholdingCode } from "../src/services/sri/xml.other";
import { loadP12, signXml, withNs } from "../src/services/sri/sign";
import { PATTERNS, code128Digits } from "../src/services/sri/code128";
import type { SriPayload } from "../src/services/sri/sri.types";
import { EMITTER, invoicePayload, testP12 } from "./sri.fixtures";

test("módulo 11: casos 11 → 0, 10 → 1 y claves de ejemplo del SRI", () => {
  // Calculados aparte (suma % 11 = 0 y = 1).
  assert.equal(mod11("041120260109930142140011001001000000123123450031"), 0);
  assert.equal(mod11("041120260109930142140011001001000000123123450071"), 1);
  assert.equal(mod11("041120260109930142140011001001000000123123450011"), 6);
  // Ejemplos de la ficha técnica de comprobantes electrónicos.
  assert.ok(isValidAccessKey("2110201101179214673900110020010000000011234567813"));
  assert.ok(isValidAccessKey("0503201201176001321000110010030009900641234567814"));
  assert.ok(!isValidAccessKey("0503201201176001321000110010030009900641234567815"));
});

test("clave de acceso: 49 dígitos, campos en su posición y DV correcto", () => {
  const key = buildAccessKey({
    date: day("2026-11-04"), docCode: "01", ruc: EMITTER.ruc, environment: 1,
    establishment: "1", emissionPoint: "2", sequential: "123", numericCode: "12345678",
  });
  assert.equal(key.length, 49);
  assert.equal(key.slice(0, 48), ["04112026", "01", EMITTER.ruc, "1", "001", "002", "000000123", "12345678", "1"].join(""));
  assert.equal(Number(key[48]), mod11(key.slice(0, 48)));
  assert.ok(isValidAccessKey(key));
  // Sin código numérico: determinístico (reemitir repite la clave).
  const a = buildAccessKey({ date: day("2026-11-04"), docCode: "07", ruc: EMITTER.ruc, environment: 2, establishment: "001", emissionPoint: "001", sequential: "9" });
  const b = buildAccessKey({ date: day("2026-11-04"), docCode: "07", ruc: EMITTER.ruc, environment: 2, establishment: "001", emissionPoint: "001", sequential: "9" });
  assert.equal(a, b);
  assert.ok(isValidAccessKey(a));
  // 23:30 en Ecuador del 4 es 04:30 UTC del 5: la fecha de la clave es la de Ecuador.
  const late = buildAccessKey({ date: new Date("2026-11-05T04:30:00Z"), docCode: "01", ruc: EMITTER.ruc, environment: 1, establishment: "1", emissionPoint: "1", sequential: "1" });
  assert.ok(late.startsWith("04112026"));
  assert.throws(() => buildAccessKey({ date: day("2026-11-04"), docCode: "01", ruc: "123", environment: 1, establishment: "1", emissionPoint: "1", sequential: "1" }));
});

test("montos: centavos a texto sin flotantes", () => {
  assert.equal(money(19268), "192.68");
  assert.equal(money(5), "0.05");
  assert.equal(money(100), "1.00");
  assert.equal(money(-150), "-1.50");
  assert.equal(money(0), "0.00");
  assert.throws(() => money(1.5));
  assert.equal(unitPrice(1234.5678), "12.345678");
  assert.equal(unitPrice(1009), "10.090000");
  assert.equal(qty(0.1 + 0.2), "0.300000");
});

test("XML de factura v1.1.0 con IVA 15% y 0%", () => {
  const xml = buildFactura(EMITTER, invoicePayload(), "0".repeat(49));
  assert.ok(xml.startsWith(`<factura id="comprobante" version="1.1.0"><infoTributaria><ambiente>1</ambiente><tipoEmision>1</tipoEmision>`));
  for (const piece of [
    "<fechaEmision>04/11/2026</fechaEmision>",
    "<obligadoContabilidad>SI</obligadoContabilidad>",
    "<razonSocialComprador>Pérez &amp; Hijos &lt;SA&gt;</razonSocialComprador>",
    "<totalSinImpuestos>170.18</totalSinImpuestos>",
    "<totalImpuesto><codigo>2</codigo><codigoPorcentaje>0</codigoPorcentaje><baseImponible>20.18</baseImponible><valor>0.00</valor></totalImpuesto>",
    "<totalImpuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><baseImponible>150.00</baseImponible><valor>22.50</valor></totalImpuesto>",
    "<propina>0.00</propina><importeTotal>192.68</importeTotal><moneda>DOLAR</moneda>",
    "<pago><formaPago>20</formaPago><total>192.68</total><plazo>30</plazo><unidadTiempo>dias</unidadTiempo></pago>",
    "<descripcion>Clavo 2\"</descripcion><cantidad>1.500000</cantidad><precioUnitario>100.000000</precioUnitario>",
    "<impuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><tarifa>15</tarifa><baseImponible>150.00</baseImponible><valor>22.50</valor></impuesto>",
    "<precioUnitario>10.090000</precioUnitario>",
    `<infoAdicional><campoAdicional nombre="email">compras@perez.ec</campoAdicional></infoAdicional></factura>`,
  ]) {
    assert.ok(xml.includes(piece), `falta ${piece}`);
  }
  assert.ok(!/>\s+</.test(xml), "sin espacios entre tags (lo exige la canonicalización)");
});

test("XML de retención v2.0.0 con renta e IVA", () => {
  const payload: SriPayload = {
    ...invoicePayload(),
    kind: "retencion",
    lines: [],
    totals: { subtotal0: 0, subtotalVat: 15000, vat: 2250, discount: 0, total: 17250 },
    withholding: {
      fiscalPeriod: "11/2026",
      lines: [
        { tax: "1", code: "312", rate: 1.75, base: 15000, amount: 263, supportDocCode: "01", supportDocNumber: "001-002-000004567", supportDocDate: day("2026-11-03") },
        { tax: "2", code: "725", rate: 30, base: 2250, amount: 675, supportDocCode: "01", supportDocNumber: "001-002-000004567", supportDocDate: day("2026-11-03") },
      ],
    },
  };
  const xml = buildRetencion(EMITTER, payload, "0".repeat(49));
  assert.ok(xml.startsWith(`<comprobanteRetencion id="comprobante" version="2.0.0">`));
  assert.ok(xml.includes("<periodoFiscal>11/2026</periodoFiscal>"));
  assert.ok(xml.includes("<codSustento>01</codSustento><codDocSustento>01</codDocSustento><numDocSustento>001002000004567</numDocSustento><fechaEmisionDocSustento>03/11/2026</fechaEmisionDocSustento>"));
  assert.ok(xml.includes("<totalSinImpuestos>150.00</totalSinImpuestos><importeTotal>172.50</importeTotal>"));
  assert.ok(xml.includes("<impuestoDocSustento><codImpuestoDocSustento>2</codImpuestoDocSustento><codigoPorcentaje>4</codigoPorcentaje><baseImponible>150.00</baseImponible><tarifa>15</tarifa><valorImpuesto>22.50</valorImpuesto></impuestoDocSustento>"));
  assert.equal(xml.match(/<retencion>/g)?.length, 2);
  assert.ok(xml.includes("<retencion><codigo>1</codigo><codigoRetencion>312</codigoRetencion><baseImponible>150.00</baseImponible><porcentajeRetener>1.75</porcentajeRetener><valorRetenido>2.63</valorRetenido></retencion>"));
  assert.ok(xml.includes("<retencion><codigo>2</codigo><codigoRetencion>1</codigoRetencion><baseImponible>22.50</baseImponible><porcentajeRetener>30.00</porcentajeRetener><valorRetenido>6.75</valorRetenido></retencion>"));
});

const P12 = testP12("clave-de-prueba");

const digestOf = (signed: string, uriPattern: string) =>
  new RegExp(`<ds:Reference [^>]*URI="${uriPattern}"[^>]*>.*?<ds:DigestValue>([^<]+)</ds:DigestValue>`).exec(signed)?.[1];
const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("base64");

test("firma XAdES-BES: digest del comprobante y firma RSA del SignedInfo verifican", () => {
  const creds = loadP12(P12.base64, "clave-de-prueba");
  assert.equal(creds.certificate.serialNumber, "0a1b2c3d", "toma el certificado de firma, no la CA");
  assert.throws(() => loadP12(P12.base64.slice(0, 200), "x"), /firma electrónica/);

  const unsigned = buildFactura(EMITTER, invoicePayload(), "0".repeat(49));
  const signed = signXml(`<?xml version="1.0" encoding="UTF-8"?>${unsigned}`, creds);
  assert.ok(signed.startsWith(`<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante"`));
  assert.ok(signed.endsWith("</ds:Signature></factura>"));

  // Enveloped: quitar ds:Signature devuelve el comprobante original.
  const withoutSig = signed.replace(/^<\?xml[^>]*\?>/, "").replace(/<ds:Signature .*<\/ds:Signature>/, "");
  assert.equal(withoutSig, unsigned);
  assert.equal(digestOf(signed, "#comprobante"), sha1(unsigned));

  const keyInfo = /<ds:KeyInfo .*?<\/ds:KeyInfo>/.exec(signed)![0];
  assert.equal(digestOf(signed, "#Certificate\\d+"), sha1(withNs(keyInfo)));
  const signedProps = /<etsi:SignedProperties .*?<\/etsi:SignedProperties>/.exec(signed)![0];
  assert.equal(digestOf(signed, "#Signature\\d+-SignedProperties\\d+"), sha1(withNs(signedProps)));

  // Digest del certificado en SigningCertificate.
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(P12.cert)).getBytes(), "binary");
  assert.ok(signedProps.includes(`<ds:DigestValue>${createHash("sha1").update(der).digest("base64")}</ds:DigestValue>`));
  assert.ok(signedProps.includes(`<ds:X509SerialNumber>${BigInt("0x0a1b2c3d")}</ds:X509SerialNumber>`));
  assert.ok(signedProps.includes("<ds:X509IssuerName>C=EC,O=BAKANO,CN=AC PRUEBAS\\, TAPIA</ds:X509IssuerName>"));
  assert.ok(signedProps.includes("<etsi:MimeType>text/xml</etsi:MimeType>"));

  const signedInfo = /<ds:SignedInfo .*?<\/ds:SignedInfo>/.exec(signed)![0];
  const signatureValue = /<ds:SignatureValue [^>]*>([^<]+)</.exec(signed)![1];
  const pem = forge.pki.publicKeyToPem(P12.cert.publicKey);
  assert.ok(verify("RSA-SHA1", Buffer.from(withNs(signedInfo), "utf8"), pem, Buffer.from(signatureValue, "base64")));
  assert.ok(!verify("RSA-SHA1", Buffer.from(withNs(signedInfo).replace("comprobante", "comprobantx"), "utf8"), pem, Buffer.from(signatureValue, "base64")));
});

test("retención de IVA: código ATS → código del SRI por porcentaje; renta tal cual", () => {
  const cases: [number, string][] = [[0, "7"], [10, "9"], [20, "10"], [30, "1"], [50, "11"], [70, "2"], [100, "3"]];
  for (const [rate, code] of cases) assert.equal(withholdingCode("2", "721", rate), code);
  assert.equal(withholdingCode("1", "312", 1.75), "312");
  assert.equal(withholdingCode("1", "343", 1), "343");
  assert.throws(() => withholdingCode("2", "721", 12), /retención de IVA/);
});

test("Code128: tabla de patrones consistente", () => {
  assert.equal(PATTERNS.length, 107);
  assert.equal(new Set(PATTERNS).size, 107);
  PATTERNS.slice(0, 106).forEach((p, i) => {
    const w = [...p].map(Number);
    assert.equal(w.reduce((a, b) => a + b, 0), 11, `símbolo ${i}`);
    assert.equal((w[0] + w[2] + w[4]) % 2, 0, `paridad de barras del símbolo ${i}`);
  });
  // 49 dígitos: start C + 24 pares + code B + dígito + checksum + stop.
  assert.equal(code128Digits("1".repeat(49)).length, 29);
  // Ejemplo conocido: "1234" en set C = 105, 12, 34, checksum (105+12+68)%103 = 82, stop.
  assert.deepEqual(code128Digits("1234"), [105, 12, 34, 82, 106]);
});
