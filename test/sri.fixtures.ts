import forge from "node-forge";
import { day } from "./helpers";
import type { Emitter } from "../src/services/sri/xml.common";
import type { SriPayload } from "../src/services/sri/sri.types";

/** Datos compartidos por las pruebas del emisor SRI (no es un *.test.ts: no corre solo). */

export const EMITTER: Emitter = {
  ruc: "0993014214001",
  legalName: "IMPORTADORA TAPIA BERZOZA IMCATABE CIA. LTDA.",
  tradeName: "IMPORTADORA TAPIA",
  address: "Pichincha 821 y Sucre, Guayaquil",
  keepsAccounting: true,
  specialTaxpayer: "",
  environment: 1,
};

export function invoicePayload(): SriPayload {
  return {
    kind: "factura",
    establishment: "001",
    emissionPoint: "001",
    sequential: "123",
    issueDate: day("2026-11-04"),
    buyer: { idType: "04", identification: "0912345678001", name: "Pérez & Hijos <SA>", address: "Av. 9 de Octubre", email: "compras@perez.ec" },
    lines: [
      { code: "A1", description: "Clavo 2\"", qty: 1.5, unitPrice: 10000, discount: 0, subtotal: 15000, vatRate: 15 },
      { code: "B2", description: "Arroz", qty: 2, unitPrice: 1009, discount: 0, subtotal: 2018, vatRate: 0 },
    ],
    totals: { subtotal0: 2018, subtotalVat: 15000, vat: 2250, discount: 0, total: 19268 },
    paymentMethod: "20",
    creditDays: 30,
  };
}

/** .p12 de prueba: CA + certificado de firma emitido por ella (la CA va primero para probar la selección). */
export function testP12(password: string) {
  const caKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = "01";
  ca.validity.notBefore = new Date("2026-01-01");
  ca.validity.notAfter = new Date("2028-01-01");
  const caName = [{ shortName: "CN", value: "AC PRUEBAS, TAPIA" }, { shortName: "O", value: "BAKANO" }, { shortName: "C", value: "EC" }];
  ca.setSubject(caName);
  ca.setIssuer(caName);
  ca.setExtensions([{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true, cRLSign: true }]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "0a1b2c3d";
  cert.validity.notBefore = new Date("2026-01-01");
  cert.validity.notAfter = new Date("2028-01-01");
  cert.setSubject([{ shortName: "CN", value: "IMPORTADORA TAPIA" }, { shortName: "C", value: "EC" }]);
  cert.setIssuer(caName);
  cert.setExtensions([{ name: "keyUsage", digitalSignature: true, nonRepudiation: true }]);
  cert.sign(caKeys.privateKey, forge.md.sha256.create());

  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [ca, cert], password, { algorithm: "3des" });
  return { base64: forge.util.encode64(forge.asn1.toDer(asn1).getBytes()), cert };
}

