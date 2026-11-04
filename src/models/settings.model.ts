import mongoose, { Schema } from "mongoose";

/**
 * Configuración única de la empresa (un solo documento, _id "main").
 * `accounts` es el mapa contable: a qué cuenta va cada concepto que generan
 * los módulos. Se valida con el plan de cuentas que entregue contabilidad.
 */
export const ACCOUNT_MAP_KEYS = [
  "customers",
  "suppliers",
  "vatSales",
  "vatPurchases",
  "withheldIncomeReceivable",
  "withheldVatReceivable",
  "incomeWithholdingPayable",
  "vatWithholdingPayable",
  "supplierAdvances",
  "customerAdvances",
  "postdatedChecks",
  "depositsInTransit",
  "inventoryAdjustment",
  "inventoryInTransit",
  "openingBalance",
  "salesDiscounts",
  "yearResult",
  "retainedEarnings",
] as const;
export type AccountMapKey = (typeof ACCOUNT_MAP_KEYS)[number];

export interface ISettings {
  _id: string;
  company: {
    ruc: string;
    legalName: string;
    tradeName: string;
    address: string;
    keepsAccounting: boolean;
    specialTaxpayer: string;
  };
  /** 1 = pruebas, 2 = producción. */
  sriEnvironment: 1 | 2;
  accounts: Record<AccountMapKey, string>;
  /** Último mes cerrado "2026-09": nada se graba con fecha en o antes de él. */
  lockedThrough: string | null;
}

const accountsShape = Object.fromEntries(
  ACCOUNT_MAP_KEYS.map((k) => [k, { type: String, default: "" }]),
);

const settingsSchema = new Schema<ISettings>(
  {
    _id: { type: String, default: "main" },
    company: {
      ruc: { type: String, default: "" },
      legalName: { type: String, default: "" },
      tradeName: { type: String, default: "" },
      address: { type: String, default: "" },
      keepsAccounting: { type: Boolean, default: true },
      specialTaxpayer: { type: String, default: "" },
    },
    sriEnvironment: { type: Number, enum: [1, 2], default: 1 },
    accounts: accountsShape,
    lockedThrough: { type: String, default: null },
  },
  { timestamps: true },
);

export const Settings =
  mongoose.models.Settings || mongoose.model<ISettings>("Settings", settingsSchema);
