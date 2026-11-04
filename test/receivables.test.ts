import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, ACTOR, day } from "./helpers";
import { runInTransaction } from "../src/config/transaction";
import * as inventory from "../src/services/inventoryCore.service";
import { Product } from "../src/models/product.model";
import { Party } from "../src/models/party.model";
import { Warehouse } from "../src/models/warehouse.model";
import { BankAccount } from "../src/models/bankAccount.model";
import { BankMovement } from "../src/models/bankMovement.model";
import { JournalEntry } from "../src/models/journalEntry.model";
import { SalesInvoice } from "../src/models/salesInvoice.model";

// env.ts (vía sri) exige DB_URI al cargarse: los services se importan después de levantar la base en memoria.
let invoices: typeof import("../src/services/invoice.service");
let receipts: typeof import("../src/services/receipt.service");
let checks: typeof import("../src/services/postdatedCheck.service");
let withholdings: typeof import("../src/services/withholding.service");
let arReports: typeof import("../src/services/receivablesReport.service");
let collections: typeof import("../src/services/collectionsReport.service");
before(async () => {
  await setup();
  invoices = await import("../src/services/invoice.service");
  receipts = await import("../src/services/receipt.service");
  checks = await import("../src/services/postdatedCheck.service");
  withholdings = await import("../src/services/withholding.service");
  arReports = await import("../src/services/receivablesReport.service");
  collections = await import("../src/services/collectionsReport.service");
});
after(teardown);

const CUSTOMERS = "1.1.02.01.01.001";
const POSTDATED = "1.1.01.01.02.003";
const TRANSIT = "1.1.01.01.02.005";
let gye: any, customer: any, achiote: any, pichincha: any, guayaquil: any, invA: any, invB: any, deposit: any;

async function accountBalance(code: string) {
  const r = await JournalEntry.aggregate([{ $unwind: "$lines" }, { $match: { "lines.accountCode": code } }, { $group: { _id: null, d: { $sum: "$lines.debit" }, c: { $sum: "$lines.credit" } } }]);
  return r[0] ? r[0].d - r[0].c : 0;
}
const balanceOf = async (inv: any) => (await SalesInvoice.findById(inv._id).lean<any>()).balance;

test("preparación: stock y dos facturas (A vence 31-ago, B vence 19-nov)", async () => {
  gye = await Warehouse.findOne({ code: "GYE" }).lean();
  customer = await Party.findOne({ identification: "0912345678001" }).lean();
  achiote = await Product.findOne({ code: "000002" }).lean();
  pichincha = await BankAccount.findOne({ name: "Banco Pichincha" }).lean();
  guayaquil = await BankAccount.findOne({ name: "Banco de Guayaquil" }).lean();
  await runInTransaction((s) =>
    inventory.applyMovement({ warehouseId: gye._id, date: day("2026-07-01"), type: "INGRESO_COMPRA", source: { module: "test", docType: "TEST", docId: null, docNumber: "" }, lines: [{ productId: achiote._id, qty: 1000, unitCost: 1 }] }, ACTOR, s),
  );
  invA = await invoices.createInvoice({ warehouseId: gye._id, partyId: customer._id, date: "2026-08-01", lines: [{ productId: achiote._id, qty: 100, unitPrice: 300 }] }, ACTOR);
  invB = await invoices.createInvoice({ warehouseId: gye._id, partyId: customer._id, date: "2026-10-20", lines: [{ productId: achiote._id, qty: 50, unitPrice: 200 }] }, ACTOR);
  assert.equal(invA.total, 30000);
  assert.equal(invB.total, 10000);
});

test("cobro parcial por depósito + retención dejan el saldo correcto", async () => {
  await assert.rejects(
    receipts.createReceipt({ partyId: customer._id, date: "2026-09-15", method: "DEPOSITO", bankAccountId: pichincha._id, amount: 40000, applications: [{ invoiceId: invA._id, amount: 40000 }] }, ACTOR),
    /supera su saldo/,
  );
  deposit = await receipts.createReceipt(
    { partyId: customer._id, date: "2026-09-15", method: "DEPOSITO", bankAccountId: pichincha._id, reference: "DEP 123", amount: 10000, applications: [{ invoiceId: invA._id, amount: 10000 }] },
    ACTOR,
  );
  const w = await withholdings.createWithholding(
    { invoiceId: invA._id, date: "2026-08-05", voucherNumber: "001-001-000000555", authorization: "123", lines: [{ tax: "renta", rate: 1.75 }] },
    ACTOR,
  );
  assert.equal(w.total, 525);
  assert.equal(await balanceOf(invA), 30000 - 10000 - 525);
  const mov = await BankMovement.findOne({ "source.docId": deposit._id }).lean<any>();
  assert.equal(mov.amount, 10000);
  assert.equal(mov.direction, "in");
  assert.equal(await accountBalance("1.1.04.01.02.001"), 525);
  assert.equal(await accountBalance(pichincha.accountCode), 10000);
});

test("cartera por edades: resumida = detallada = libro = mayor de Clientes", async () => {
  const summary: any = await arReports.aging({ cutoff: "2026-11-04" });
  const detailed: any = await arReports.aging({ cutoff: "2026-11-04", detailed: "true" });
  assert.equal(summary.cuadra, true);
  assert.equal(detailed.cuadra, true);
  assert.equal(summary.summaryTotal, detailed.detailTotal);
  assert.equal(summary.summaryTotal, 19475 + 10000);
  assert.equal(summary.summary[0].d61_90, 19475); // A: 65 días vencida
  assert.equal(summary.summary[0].notDue, 10000);
  assert.deepEqual(detailed.detail.map((d: any) => d.bucket), ["d61_90", "notDue"]);
  assert.equal(await accountBalance(CUSTOMERS), summary.summaryTotal);

  // Al 1-sep todavía no había cobro y B no existía; la retención del 5-ago sí.
  const past: any = await arReports.aging({ cutoff: "2026-09-01" });
  assert.equal(past.summaryTotal, 30000 - 525);
  assert.equal(past.summary[0].d0_30, 30000 - 525);
});

test("facturas y cobros: Vencidas / por Vencer al corte, como el filtro de hoy", async () => {
  const at = (due: string) => arReports.invoicesAndReceipts({ cutoff: "2026-11-04", due }) as Promise<any>;
  assert.deepEqual((await at("overdue")).customers[0].invoices.map((i: any) => i.number), [invA.number]);
  assert.deepEqual((await at("notDue")).customers[0].invoices.map((i: any) => i.number), [invB.number]);
  assert.equal((await at("")).balance, 19475 + 10000);
});

test("cheque posfechado: posfechados → tránsito → banco, y devuelto reabre el saldo", async () => {
  const chq: any = await receipts.createReceipt(
    { partyId: customer._id, date: "2026-11-04", method: "CHEQUE_POSFECHADO", amount: 4000, applications: [{ invoiceId: invB._id, amount: 4000 }], check: { number: "8812", bank: "Produbanco", dueDate: "2026-11-20" } },
    ACTOR,
  );
  assert.equal(await balanceOf(invB), 6000);
  assert.equal(await accountBalance(POSTDATED), 4000);
  assert.equal((await checks.listChecks({ from: "2026-11-01", to: "2026-11-30" })).length, 1);

  await checks.depositCheck(String(chq._id), { date: "2026-11-20", bankAccountId: String(guayaquil._id) }, ACTOR);
  assert.equal(await accountBalance(POSTDATED), 0);
  assert.equal(await accountBalance(TRANSIT), 4000);

  const credited: any = await checks.confirmCheck(String(chq._id), { date: "2026-11-21" }, ACTOR);
  assert.equal(credited.check.status, "acreditado");
  assert.equal(await accountBalance(TRANSIT), 0);
  assert.equal(await accountBalance(guayaquil.accountCode), 4000);
  assert.equal(await BankMovement.countDocuments({ "source.docId": chq._id, direction: "in" }), 1);

  await checks.returnCheck(String(chq._id), { date: "2026-11-25", reason: "Fondos insuficientes" }, ACTOR);
  assert.equal(await accountBalance(guayaquil.accountCode), 0);
  assert.equal(await balanceOf(invB), 10000);
  await assert.rejects(receipts.voidReceipt(String(chq._id), { reason: "x", date: "2026-11-25" }, ACTOR), /ya fue devuelto/);
});

test("comisiones sobre lo cobrado, estado de cuenta y anular cobro", async () => {
  const c: any = await collections.commissions({ from: "2026-09-01", to: "2026-11-30", rate: "1" });
  assert.deepEqual(c.items, [{ sellerName: "RUBEN PALMA", collected: 10000, rate: 1, commission: 100 }]);

  const st: any = await arReports.statement({ partyId: String(customer._id) });
  assert.equal(st.closing, 19475 + 10000);

  await receipts.voidReceipt(String(deposit._id), { reason: "Depósito duplicado", date: "2026-11-26" }, ACTOR);
  assert.equal(await balanceOf(invA), 30000 - 525);
  assert.equal((await BankMovement.findOne({ "source.docId": deposit._id }).lean<any>()).status, "anulado");
  // El corte anterior a la anulación sigue mostrando el cobro: igual que el mayor a esa fecha.
  const atOct: any = await arReports.aging({ cutoff: "2026-10-31" });
  assert.equal(atOct.summaryTotal, 19475 + 10000);
  const rep: any = await collections.withholdingsReport({ groupBy: "type", tax: "renta" });
  assert.deepEqual(rep.types, [{ tax: "renta", rate: 1.75, count: 1, base: 30000, amount: 525 }]);
});
