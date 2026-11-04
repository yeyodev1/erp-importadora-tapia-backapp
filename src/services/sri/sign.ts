import { createHash, randomInt } from "node:crypto";
import forge from "node-forge";
import { escapeAttr, escapeText } from "./xml.common";

/**
 * Firma XAdES-BES enveloped como la exige el SRI: RSA-SHA1, digests SHA-1,
 * C14N inclusiva sin comentarios, tres referencias (SignedProperties, KeyInfo y
 * #comprobante con transform enveloped-signature).
 *
 * shortcut: la canonicalización está hecha a mano y solo vale para NUESTRO XML:
 * sin namespace por defecto, raíz sin namespaces, atributos ya en orden
 * alfabético, sin espacios entre tags, `<a></a>` en lugar de `<a/>` y escape de
 * C14N (todo eso lo garantiza xml.common.ts). Con eso el C14N de un nodo es su
 * mismo texto + los xmlns:ds/xmlns:etsi heredados de ds:Signature. No sirve para
 * firmar XML de terceros: para eso, usar una librería de C14N real.
 */

const NS_DS = "http://www.w3.org/2000/09/xmldsig#";
const NS_ETSI = "http://uri.etsi.org/01903/v1.3.2#";
const SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
/** Declaraciones heredadas que C14N inclusiva pone en el ápice de cada subárbol firmado (orden por prefijo). */
const NS_DECLS = ` xmlns:ds="${NS_DS}" xmlns:etsi="${NS_ETSI}"`;

export interface SigningCredentials {
  privateKey: forge.pki.rsa.PrivateKey;
  certificate: forge.pki.Certificate;
}

const cache = new Map<string, SigningCredentials>();

function hasSigningUsage(cert: forge.pki.Certificate): boolean {
  const ku = cert.getExtension("keyUsage") as { digitalSignature?: boolean; nonRepudiation?: boolean } | null;
  if (!ku) return true; // sin extensión no hay restricción
  return Boolean(ku.digitalSignature || ku.nonRepudiation);
}

/**
 * Lee el .p12 (base64) y toma la clave privada y el certificado que le
 * corresponde (mismo módulo RSA y uso de firma). Los .p12 del BCE/Security Data
 * traen la cadena de la CA: elegir mal el certificado da "FIRMA INVALIDA".
 * Nunca incluye la clave ni el certificado en mensajes de error.
 */
export function loadP12(base64: string, password: string): SigningCredentials {
  const cached = cache.get(base64);
  if (cached) return cached;
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(base64.replace(/\s+/g, ""))), password);
  } catch {
    throw new Error("No se pudo abrir la firma electrónica (.p12): revisa el archivo y la clave");
  }
  const bags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => Boolean(c));
  for (const bag of bags) {
    const key = bag.key as forge.pki.rsa.PrivateKey | undefined;
    if (!key?.n) continue;
    const cert = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n) && hasSigningUsage(c));
    if (cert) {
      const creds = { privateKey: key, certificate: cert };
      cache.set(base64, creds);
      return creds;
    }
  }
  throw new Error("La firma electrónica (.p12) no tiene un certificado de firma que corresponda a su clave privada");
}

function sha1Base64(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("base64");
}

/** Entero grande (forge) → base64 sin el byte 0x00 de signo. */
function bigIntBase64(n: forge.jsbn.BigInteger): string {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, "hex").toString("base64");
}

/** Nombre del emisor en formato RFC 2253 (orden inverso al DER), como lo leen los validadores Java. */
function issuerName(cert: forge.pki.Certificate): string {
  return [...cert.issuer.attributes]
    .reverse()
    .map((a) => {
      const value = String(a.value).replace(/([,+"\\<>;])/g, "\\$1").replace(/^([ #])/, "\\$1").replace(/ $/, "\\ ");
      return `${a.shortName || a.type}=${value}`;
    })
    .join(",");
}

/** Hora de Ecuador con offset explícito: 2026-11-04T10:15:00-05:00. */
function signingTime(now: Date): string {
  return `${new Date(now.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 19)}-05:00`;
}

const id = () => randomInt(100000, 999999);

/**
 * Firma el comprobante (XML sin declaración o con ella) y devuelve el XML con
 * ds:Signature como último hijo de la raíz.
 */
export function signXml(xml: string, creds: SigningCredentials, now = new Date()): string {
  const body = xml.replace(/^<\?xml[^>]*\?>/, "");
  const closeAt = body.lastIndexOf("</");
  if (closeAt < 0 || !/^<\w+ id="comprobante"/.test(body)) throw new Error("XML de comprobante inválido para firmar");

  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(creds.certificate)).getBytes();
  const certB64 = forge.util.encode64(certDer);
  const certDigest = createHash("sha1").update(Buffer.from(certDer, "binary")).digest("base64");
  const pub = creds.certificate.publicKey as forge.pki.rsa.PublicKey;

  const sigId = `Signature${id()}`;
  const signedPropsId = `${sigId}-SignedProperties${id()}`;
  const certId = `Certificate${id()}`;
  const refId = `Reference-ID-${id()}`;

  const signedProps =
    `<etsi:SignedProperties Id="${signedPropsId}">` +
    `<etsi:SignedSignatureProperties>` +
    `<etsi:SigningTime>${signingTime(now)}</etsi:SigningTime>` +
    `<etsi:SigningCertificate><etsi:Cert><etsi:CertDigest>` +
    `<ds:DigestMethod Algorithm="${SHA1}"></ds:DigestMethod><ds:DigestValue>${certDigest}</ds:DigestValue>` +
    `</etsi:CertDigest><etsi:IssuerSerial>` +
    `<ds:X509IssuerName>${escapeText(issuerName(creds.certificate))}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber>${BigInt(`0x${creds.certificate.serialNumber}`).toString()}</ds:X509SerialNumber>` +
    `</etsi:IssuerSerial></etsi:Cert></etsi:SigningCertificate>` +
    `</etsi:SignedSignatureProperties>` +
    `<etsi:SignedDataObjectProperties>` +
    `<etsi:DataObjectFormat ObjectReference="#${refId}">` +
    `<etsi:Description>contenido comprobante</etsi:Description><etsi:MimeType>text/xml</etsi:MimeType>` +
    `</etsi:DataObjectFormat></etsi:SignedDataObjectProperties>` +
    `</etsi:SignedProperties>`;

  const keyInfo =
    `<ds:KeyInfo Id="${certId}">` +
    `<ds:X509Data><ds:X509Certificate>${certB64}</ds:X509Certificate></ds:X509Data>` +
    `<ds:KeyValue><ds:RSAKeyValue><ds:Modulus>${bigIntBase64(pub.n)}</ds:Modulus>` +
    `<ds:Exponent>${bigIntBase64(pub.e)}</ds:Exponent></ds:RSAKeyValue></ds:KeyValue>` +
    `</ds:KeyInfo>`;

  const reference = (attrs: string, digest: string, transforms = "") =>
    `<ds:Reference ${attrs}>${transforms}<ds:DigestMethod Algorithm="${SHA1}"></ds:DigestMethod><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference>`;

  const signedInfo =
    `<ds:SignedInfo Id="Signature-SignedInfo${id()}">` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></ds:SignatureMethod>` +
    reference(`Id="SignedPropertiesID${id()}" Type="http://uri.etsi.org/01903#SignedProperties" URI="#${escapeAttr(signedPropsId)}"`, sha1Base64(withNs(signedProps))) +
    reference(`URI="#${certId}"`, sha1Base64(withNs(keyInfo))) +
    reference(
      `Id="${refId}" URI="#comprobante"`,
      // Enveloped: el digest es del comprobante sin la firma, que es justo `body`.
      sha1Base64(body),
      `<ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform></ds:Transforms>`,
    ) +
    `</ds:SignedInfo>`;

  const md = forge.md.sha1.create();
  md.update(withNs(signedInfo), "utf8");
  const signatureValue = forge.util.encode64(creds.privateKey.sign(md));

  const signature =
    `<ds:Signature${NS_DECLS} Id="${sigId}">` +
    signedInfo +
    `<ds:SignatureValue Id="SignatureValue${id()}">${signatureValue}</ds:SignatureValue>` +
    keyInfo +
    `<ds:Object Id="${sigId}-Object${id()}"><etsi:QualifyingProperties Target="#${sigId}">${signedProps}</etsi:QualifyingProperties></ds:Object>` +
    `</ds:Signature>`;

  return `<?xml version="1.0" encoding="UTF-8"?>${body.slice(0, closeAt)}${signature}${body.slice(closeAt)}`;
}

/** C14N del subárbol: agrega los namespaces heredados justo después del nombre del tag ápice. */
export function withNs(fragment: string): string {
  return fragment.replace(/^<([\w:]+)/, `<$1${NS_DECLS}`);
}

export function isSigned(xml: string): boolean {
  return xml.includes("<ds:Signature");
}
