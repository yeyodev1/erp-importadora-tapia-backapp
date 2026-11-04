/**
 * Contrato entre los módulos (Facturación, Compras) y el emisor SRI.
 * Los módulos traducen su documento a SriPayload; el emisor arma el XML,
 * la clave de acceso, firma, envía y autoriza. Montos en CENTAVOS.
 */

/** Código de comprobante SRI. */
export const SRI_DOC_CODES = {
  factura: "01",
  notaCredito: "04",
  notaDebito: "05",
  guiaRemision: "06",
  retencion: "07",
} as const;
export type SriDocKind = keyof typeof SRI_DOC_CODES;

export type SriStatus =
  | "sin_firma" // falta la firma electrónica (.p12) en el entorno
  | "firmado"
  | "recibido"
  | "autorizado"
  | "devuelto"
  | "no_autorizado"
  | "error";

export interface SriBuyer {
  /** 04 RUC, 05 cédula, 06 pasaporte, 07 consumidor final. */
  idType: string;
  identification: string;
  name: string;
  address: string;
  email: string;
}

export interface SriLine {
  code: string;
  description: string;
  qty: number;
  /** Centavos por unidad (puede tener decimales de centavo: se redondea a 6 decimales en dólares). */
  unitPrice: number;
  discount: number;
  /** Base de la línea (qty × unitPrice − discount), centavos. */
  subtotal: number;
  /** 0, 5 o 15. */
  vatRate: number;
}

export interface SriWithholdingLine {
  /** "1" renta, "2" IVA. */
  tax: "1" | "2";
  /** Código de retención SRI (312, 307, 721...). */
  code: string;
  rate: number;
  base: number;
  amount: number;
  /** Documento sustento: tipo, número 001-001-000000123, fecha. */
  supportDocCode: string;
  supportDocNumber: string;
  supportDocDate: Date;
  /** Autorización (clave de acceso de 49 dígitos) del documento sustento, si es electrónico. */
  supportDocAuthorization?: string;
}

export interface SriPayload {
  kind: SriDocKind;
  establishment: string;
  emissionPoint: string;
  sequential: string;
  issueDate: Date;
  buyer: SriBuyer;
  lines: SriLine[];
  /** Totales en centavos. */
  totals: { subtotal0: number; subtotalVat: number; vat: number; discount: number; total: number };
  /** Forma de pago SRI (20 = otros con utilización del sistema financiero). */
  paymentMethod?: string;
  creditDays?: number;
  /** Nota de crédito/débito: factura que modifica y motivo. */
  modifies?: { docCode: string; number: string; date: Date; reason: string };
  /** Retención: período fiscal "MM/AAAA" y líneas. */
  withholding?: {
    fiscalPeriod: string;
    lines: SriWithholdingLine[];
    /** Código de sustento tributario (tabla 5 del ATS). Por defecto "01" crédito tributario. */
    supportCode?: string;
  };
  /** Guía de remisión. */
  shipment?: { carrierId: string; carrierName: string; plate: string; startDate: Date; endDate: Date; origin: string; destination: string; invoiceNumber: string };
  additionalInfo?: Record<string, string>;
}

export interface SriResult {
  accessKey: string;
  status: SriStatus;
  authorizationNumber: string;
  authorizationDate: Date | null;
  messages: string[];
  /** XML firmado (o sin firmar si status = "sin_firma"). */
  xml: string;
}
