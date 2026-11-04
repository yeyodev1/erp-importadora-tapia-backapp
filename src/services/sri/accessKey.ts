import { createHash } from "node:crypto";

/**
 * Clave de acceso SRI (49 dígitos): fecha ddmmaaaa + tipo comprobante (2) +
 * RUC (13) + ambiente (1) + serie estab+pto (6) + secuencial (9) +
 * código numérico (8) + tipo emisión "1" + dígito verificador módulo 11.
 */

/** Dígito verificador módulo 11: pesos 2..7 de derecha a izquierda; 11 → 0, 10 → 1. */
export function mod11(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const dv = 11 - (sum % 11);
  if (dv === 11) return 0;
  if (dv === 10) return 1;
  return dv;
}

/** Fecha en hora de Ecuador (UTC-5, sin horario de verano). */
export function ecuadorParts(date: Date): { dd: string; mm: string; yyyy: string } {
  const d = new Date(date.getTime() - 5 * 3600 * 1000);
  return {
    dd: String(d.getUTCDate()).padStart(2, "0"),
    mm: String(d.getUTCMonth() + 1).padStart(2, "0"),
    yyyy: String(d.getUTCFullYear()),
  };
}

export interface AccessKeyInput {
  date: Date;
  docCode: string;
  ruc: string;
  environment: 1 | 2;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  /** 8 dígitos; si no viene se deriva de los datos del comprobante. */
  numericCode?: string;
}

function digits(value: string, length: number, field: string): string {
  const v = String(value ?? "").trim();
  if (!/^\d+$/.test(v) || v.length > length) throw new Error(`${field} inválido para la clave de acceso: "${v}"`);
  return v.padStart(length, "0");
}

export function buildAccessKey(input: AccessKeyInput): string {
  const { dd, mm, yyyy } = ecuadorParts(input.date);
  const ruc = digits(input.ruc, 13, "RUC");
  if (ruc.length !== 13 || String(input.ruc).trim().length !== 13) throw new Error("El RUC del emisor debe tener 13 dígitos");
  const docCode = digits(input.docCode, 2, "Tipo de comprobante");
  const estab = digits(input.establishment, 3, "Establecimiento");
  const pto = digits(input.emissionPoint, 3, "Punto de emisión");
  const seq = digits(input.sequential, 9, "Secuencial");
  // Determinístico: reemitir el mismo documento repite la clave y el SRI responde
  // "clave registrada" en vez de duplicar el secuencial con otra clave.
  const numeric =
    input.numericCode !== undefined
      ? digits(input.numericCode, 8, "Código numérico")
      : String(parseInt(createHash("sha1").update(`${ruc}${docCode}${estab}${pto}${seq}`).digest("hex").slice(0, 12), 16) % 1e8).padStart(8, "0");
  const base = `${dd}${mm}${yyyy}${docCode}${ruc}${input.environment}${estab}${pto}${seq}${numeric}1`;
  return base + mod11(base);
}

/** Ambiente codificado en la clave (posición 24): 1 pruebas, 2 producción. */
export function environmentOf(accessKey: string): 1 | 2 {
  return accessKey[23] === "2" ? 2 : 1;
}

export function isValidAccessKey(accessKey: string): boolean {
  return /^\d{49}$/.test(accessKey) && mod11(accessKey.slice(0, 48)) === Number(accessKey[48]);
}
