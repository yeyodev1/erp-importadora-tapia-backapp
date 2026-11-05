import mongoose, { Schema } from "mongoose";

/**
 * Configuración única de la empresa (un solo documento, _id "main").
 * `accounts` es el mapa contable: a qué cuenta va cada concepto que generan
 * los módulos. Se valida con el plan de cuentas que entregue contabilidad.
 */
const PAYROLL_ACCOUNT_KEYS = [
  "payrollSalesSalaries",
  "payrollSalesOvertime",
  "payrollSalesCommissions",
  "payrollSalesEmployerIess",
  "payrollSalesSecapIece",
  "payrollSalesReserveFund",
  "payrollSalesThirteenth",
  "payrollSalesFourteenth",
  "payrollSalesVacation",
  "payrollAdminSalaries",
  "payrollAdminOvertime",
  "payrollAdminCommissions",
  "payrollAdminEmployerIess",
  "payrollAdminSecapIece",
  "payrollAdminReserveFund",
  "payrollAdminThirteenth",
  "payrollAdminFourteenth",
  "payrollAdminVacation",
  "payrollIessPersonal",
  "payrollIessPayable",
  "payrollNetPayable",
  "payrollThirteenthProvision",
  "payrollFourteenthProvision",
  "payrollVacationProvision",
  "payrollReserveFundProvision",
  "employeeLoans",
  "payrollOtherDeductions",
] as const;

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
  ...PAYROLL_ACCOUNT_KEYS,
] as const;
export type AccountMapKey = (typeof ACCOUNT_MAP_KEYS)[number];

/** Departamentos de la nómina: cada uno lleva su gasto (5.2.01 ventas, 5.2.02 administración). */
export const DEPARTMENTS = ["administracion", "ventas"] as const;
export type Department = (typeof DEPARTMENTS)[number];

/**
 * Cuentas por defecto de las claves de nómina, tomadas del plan de Tapia.
 * Rigen mientras contabilidad no grabe otra en el mapa (Configuración › Mapa contable).
 */
export const ACCOUNT_DEFAULTS: Partial<Record<AccountMapKey, string>> = {
  payrollSalesSalaries: "5.2.01.01.01.001",
  payrollSalesOvertime: "5.2.01.01.01.002",
  payrollSalesCommissions: "5.2.01.04.02.001",
  payrollSalesEmployerIess: "5.2.01.02.01.001",
  payrollSalesSecapIece: "5.2.01.02.01.002",
  payrollSalesReserveFund: "5.2.01.02.01.003",
  payrollSalesThirteenth: "5.2.01.03.01.001",
  payrollSalesFourteenth: "5.2.01.03.01.002",
  payrollSalesVacation: "5.2.01.03.01.003",
  payrollAdminSalaries: "5.2.02.01.01.001",
  payrollAdminOvertime: "5.2.02.01.01.002",
  // No hay "Comisiones" en 5.2.02: va a Bonificaciones por Incentivo (contabilidad lo confirma).
  payrollAdminCommissions: "5.2.02.04.02.002",
  payrollAdminEmployerIess: "5.2.02.02.01.001",
  payrollAdminSecapIece: "5.2.02.02.01.002",
  payrollAdminReserveFund: "5.2.02.02.01.003",
  payrollAdminThirteenth: "5.2.02.03.01.001",
  payrollAdminFourteenth: "5.2.02.03.01.002",
  payrollAdminVacation: "5.2.02.03.01.003",
  payrollIessPersonal: "2.1.07.03.01.001",
  payrollIessPayable: "2.1.07.03.01.002",
  payrollNetPayable: "2.1.07.04.01.001",
  payrollThirteenthProvision: "2.1.07.04.02.001",
  payrollFourteenthProvision: "2.1.07.04.02.002",
  payrollVacationProvision: "2.1.07.04.02.003",
  payrollReserveFundProvision: "2.1.07.04.02.005",
  employeeLoans: "1.1.02.08.02.001",
  payrollOtherDeductions: "1.1.02.08.02.022",
};

/**
 * Tasas de la nómina y SBU (centavos). POR CONFIRMAR con contabilidad cada
 * año: el SBU 2026 no está confirmado (470.00 es el de 2025).
 * 11.15 % patronal + 0.5 % SECAP + 0.5 % IECE = 12.15 % a cargo de la empresa.
 */
export const PAYROLL_DEFAULTS = {
  sbu: 47000,
  iessPersonalRate: 9.45,
  iessEmployerRate: 11.15,
  secapRate: 0.5,
  ieceRate: 0.5,
  reserveFundRate: 8.33,
};
export type PayrollRates = typeof PAYROLL_DEFAULTS;

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
  payroll: PayrollRates;
}

const accountsShape = Object.fromEntries(
  ACCOUNT_MAP_KEYS.map((k) => [k, { type: String, default: ACCOUNT_DEFAULTS[k] ?? "" }]),
);
const payrollShape = Object.fromEntries(
  Object.entries(PAYROLL_DEFAULTS).map(([k, v]) => [k, { type: Number, default: v }]),
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
    payroll: payrollShape,
  },
  { timestamps: true },
);

export const Settings =
  mongoose.models.Settings || mongoose.model<ISettings>("Settings", settingsSchema);
