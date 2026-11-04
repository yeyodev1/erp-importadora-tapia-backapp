import { Account } from "../models/account.model";
import { BankAccount } from "../models/bankAccount.model";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import { ProductGroup } from "../models/productGroup.model";
import { Settings } from "../models/settings.model";
import { User } from "../models/user.model";
import { Warehouse } from "../models/warehouse.model";
import { WithholdingCode, DEFAULT_WITHHOLDING_CODES } from "../models/withholdingCode.model";
import { DEMO_CHART } from "./demoChart";

/**
 * Datos de arranque: empresa, plan de cuentas mínimo, mapa contable,
 * bodegas, grupos y algunos productos/terceros de ejemplo. Es idempotente:
 * si ya hay cuentas, no toca nada (nunca pisa datos reales).
 */
/**
 * demoUsers: solo para la base en memoria (`pnpm dev:memory`) y las pruebas.
 * En producción nunca: esa contraseña está en un repo público. Allí el admin
 * sale de ADMIN_EMAIL/ADMIN_PASSWORD (seedAdmin) y el resto se crea desde Usuarios.
 */
export async function seedDemo({ demoUsers = true, adminPassword = "tapia2026" } = {}) {
  if ((await Account.countDocuments()) > 0) return false;

  await Account.insertMany(
    DEMO_CHART.map(([code, name, k]) => ({
      code,
      name,
      kind: k === "m" ? "mayor" : "movimiento",
      parentCode: code.includes(".") ? code.slice(0, code.lastIndexOf(".")) : null,
      level: code.split(".").length,
      isExpense: code.startsWith("5.2"),
    })),
  );

  await Settings.create({
    _id: "main",
    company: {
      ruc: "0993014214001",
      legalName: "IMPORTADORA TAPIA BERZOZA IMCATABE CIA. LTDA.",
      tradeName: "IMPORTADORA TAPIA",
      address: "Pichincha 821 y Sucre, Guayaquil",
      keepsAccounting: true,
    },
    sriEnvironment: 1,
    accounts: {
      customers: "1.1.02.01.01.001",
      suppliers: "2.1.01.01.01.001",
      vatSales: "2.1.02.01.01.001",
      vatPurchases: "1.1.04.01.01.001",
      withheldIncomeReceivable: "1.1.04.01.02.001",
      withheldVatReceivable: "1.1.04.01.01.002",
      incomeWithholdingPayable: "2.1.02.02.01.001",
      vatWithholdingPayable: "2.1.02.02.01.002",
      supplierAdvances: "1.1.02.02.01.001",
      customerAdvances: "2.1.01.02.01.001",
      postdatedChecks: "1.1.01.01.02.003",
      depositsInTransit: "1.1.01.01.02.005",
      inventoryAdjustment: "5.2.02.01.01.005",
      inventoryInTransit: "1.1.03.01.01.004",
      openingBalance: "3.1.01.01.01.001",
      salesDiscounts: "4.1.01.01.02.001",
      yearResult: "3.1.01.01.01.002",
      retainedEarnings: "3.1.01.01.01.001",
    },
  });

  await BankAccount.insertMany([
    { name: "Banco de Guayaquil", bank: "Banco de Guayaquil", accountCode: "1.1.01.02.01.005" },
    { name: "Banco del Austro", bank: "Banco del Austro", accountCode: "1.1.01.02.01.006" },
    { name: "Banco Internacional", bank: "Banco Internacional", accountCode: "1.1.01.02.01.003" },
    { name: "Banco Pichincha", bank: "Banco Pichincha", accountCode: "1.1.01.02.01.004" },
    { kind: "caja", name: "Caja Chica Matriz", type: "", accountCode: "1.1.01.01.01.001" },
    { kind: "caja", name: "Caja Chica Quito", type: "", accountCode: "1.1.01.01.01.002" },
    { kind: "caja", name: "Caja General por Facturación", type: "", accountCode: "1.1.01.01.02.001" },
  ]);

  const [gye] = await Warehouse.insertMany([
    { code: "GYE", name: "Bodega Guayaquil", establishment: "001", emissionPoint: "001", address: "Pichincha 821 y Sucre" },
    { code: "UIO", name: "Bodega Quito", establishment: "002", emissionPoint: "001", address: "Quito" },
  ]);

  const groups = await ProductGroup.insertMany([
    { name: "ESPECIAS", subgroups: ["Materia prima"], accounts: { inventory: "1.1.03.01.01.001", sales: "4.1.01.01.01.001", cost: "5.1.01.01.01.001" } },
    { name: "FRUTOS SECOS", subgroups: ["Materia prima"], accounts: { inventory: "1.1.03.01.01.002", sales: "4.1.01.01.01.002", cost: "5.1.01.01.01.002" } },
    { name: "GRANOS Y SEMILLAS", subgroups: ["Materia prima"], accounts: { inventory: "1.1.03.01.01.003", sales: "4.1.01.01.01.003", cost: "5.1.01.01.01.003" } },
  ]);
  const [especias, frutos, granos] = groups;

  const supplier = await Party.create({
    identification: "0990000000001",
    name: "PROVEEDOR DE EJEMPLO S.A.",
    isSupplier: true,
    email: "proveedor@ejemplo.com",
    supplier: { creditDays: 30, defaultExpenseAccount: "5.2.02.01.01.002" },
  });
  await Party.insertMany([
    { identification: "0912345678001", name: "CLIENTE DE EJEMPLO GUAYAQUIL", isCustomer: true, email: "cliente@ejemplo.com", customer: { sellerName: "RUBEN PALMA", creditDays: 30, parish: "GUAYAQUIL/CENTRO" } },
    { identification: "1712345678001", name: "CLIENTE DE EJEMPLO QUITO", isCustomer: true, customer: { sellerName: "VICTOR VERA", creditDays: 15, parish: "LA FLORESTA", withholdsVat: true } },
    { identification: "0911111111", idType: "05", name: "EMPLEADO DE EJEMPLO", isEmployee: true, isSupplier: true },
  ]);

  const p = (code: string, name: string, groupId: unknown, factor: number, purchaseUnit: string, price: number) => ({
    code, name, groupId, unit: "LIBRAS", purchaseUnit: { name: purchaseUnit, factor },
    supplierId: supplier._id, subgroup: "Materia prima", vatRate: 0, prices: [{ list: "GENERAL", price }],
  });
  await Product.insertMany([
    p("000002", "ACHIOTE LIBRA", especias._id, 100, "SACOS", 145),
    p("000010", "CANELA SUPERIOR", especias._id, 100, "SACOS", 420),
    p("000020", "LAUREL", especias._id, 55, "BULTOS", 210),
    p("000005", "ALMENDRAS 25/27", frutos._id, 50, "CAJAS", 690),
    p("000030", "LENTEJA SACO 100LBS", granos._id, 100, "SACOS", 75),
    p("000031", "LINAZA", granos._id, 100, "SACOS", 95),
  ]);

  await WithholdingCode.insertMany(DEFAULT_WITHHOLDING_CODES);

  if (demoUsers && !(await User.findOne({ email: "admin@importadoratapia.app" }))) {
    await User.create({ email: "admin@importadoratapia.app", password: adminPassword, name: "Gerencia", role: "admin" });
    await User.create({ email: "contabilidad@importadoratapia.app", password: adminPassword, name: "Contabilidad", role: "contabilidad" });
    await User.create({ email: "bodega@importadoratapia.app", password: adminPassword, name: "Bodega Guayaquil", role: "bodega", warehouseId: gye._id });
    await User.create({ email: "facturacion@importadoratapia.app", password: adminPassword, name: "Facturación", role: "facturacion", warehouseId: gye._id });
  }
  return true;
}
