import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, ACTOR, day } from "./helpers";
import { runInTransaction } from "../src/config/transaction";
import * as inventory from "../src/services/inventoryCore.service";
import { Product } from "../src/models/product.model";
import { Party } from "../src/models/party.model";
import { Warehouse } from "../src/models/warehouse.model";
import { JournalEntry } from "../src/models/journalEntry.model";
import { StockBalance } from "../src/models/stockBalance.model";
import { SalesInvoice } from "../src/models/salesInvoice.model";
import { ArMovement } from "../src/models/arMovement.model";

// env.ts (vía sri) exige DB_URI al cargarse: los services se importan después de levantar la base en memoria.
let invoices: typeof import("../src/services/invoice.service");
let creditNotes: typeof import("../src/services/creditNote.service");
let debitNotes: typeof import("../src/services/debitNote.service");
let proformas: typeof import("../src/services/proforma.service");
let reports: typeof import("../src/services/salesReport.service");
let rides: typeof import("../src/services/salesRide.service");
before(async () => {
  await setup();
  invoices = await import("../src/services/invoice.service");
  creditNotes = await import("../src/services/creditNote.service");
  debitNotes = await import("../src/services/debitNote.service");
  proformas = await import("../src/services/proforma.service");
  reports = await import("../src/services/salesReport.service");
  rides = await import("../src/services/salesRide.service");
});
after(teardown);

let gye: any, customer: any, achiote: any, almendras: any, linaza: any, firstInvoice: any;
const source = { module: "test", docType: "TEST", docId: null, docNumber: "" };
const stock = async (p: any) => (await StockBalance.findOne({ productId: p._id, warehouseId: gye._id }).lean<any>()) ?? { qty: 0, totalValue: 0 };
const lineOf = (entry: any, code: string) => entry.lines.find((l: any) => l.accountCode === code) ?? { debit: 0, credit: 0 };

test("preparación: compras a GYE (achiote promedio 1.75)", async () => {
  gye = await Warehouse.findOne({ code: "GYE" }).lean();
  customer = await Party.findOne({ identification: "0912345678001" }).lean();
  await Product.updateOne({ code: "000005" }, { vatRate: 15 });
  [achiote, almendras, linaza] = await Promise.all(["000002", "000005", "000031"].map((code) => Product.findOne({ code }).lean()));
  const buy = (p: any, qty: number, unitCost: number) =>
    runInTransaction((s) => inventory.applyMovement({ warehouseId: gye._id, date: day("2026-11-01"), type: "INGRESO_COMPRA", source, lines: [{ productId: p._id, qty, unitCost }] }, ACTOR, s));
  await buy(achiote, 100, 1);
  await buy(achiote, 300, 2);
  await buy(almendras, 50, 5);
});

test("factura cuadra, descuenta stock al costo promedio y abre la cuenta por cobrar", async () => {
  const inv: any = await invoices.createInvoice(
    {
      warehouseId: gye._id, partyId: customer._id, date: "2026-11-04",
      lines: [{ productId: achiote._id, qty: 40, unitPrice: 300 }, { productId: almendras._id, qty: 10, unitPrice: 900, discount: 500 }],
    },
    ACTOR,
  );
  firstInvoice = inv;
  assert.equal(inv.number, "001-001-000000001");
  assert.equal(inv.sellerName, "RUBEN PALMA");
  assert.equal(inv.sriStatus, "sin_firma");
  assert.equal(new Date(inv.dueDate).toISOString().slice(0, 10), "2026-12-04");
  assert.deepEqual([inv.subtotal0, inv.subtotalVat, inv.discount, inv.vat, inv.total], [12000, 8500, 500, 1275, 21775]);
  assert.equal(inv.balance, 21775);
  assert.deepEqual(inv.lines.map((l: any) => l.costTotal), [7000, 5000]);

  const entry = await JournalEntry.findById(inv.journalEntryId).lean<any>();
  assert.equal(entry.type, "VENTA");
  assert.equal(entry.totalDebit, entry.totalCredit);
  assert.equal(lineOf(entry, "1.1.02.01.01.001").debit, 21775);
  assert.equal(lineOf(entry, "4.1.01.01.01.001").credit, 12000);
  assert.equal(lineOf(entry, "4.1.01.01.01.002").credit, 8500);
  assert.equal(lineOf(entry, "2.1.02.01.01.001").credit, 1275);
  assert.equal(lineOf(entry, "5.1.01.01.01.001").debit, 7000);
  assert.equal(lineOf(entry, "1.1.03.01.01.001").credit, 7000);
  assert.equal(lineOf(entry, "1.1.03.01.01.002").credit, 5000);
  assert.equal((await stock(achiote)).qty, 360);
  assert.equal((await stock(achiote)).totalValue, 70000 - 7000);
});

test("factura sin stock falla y no deja nada grabado", async () => {
  const before = await Promise.all([SalesInvoice.countDocuments(), JournalEntry.countDocuments(), ArMovement.countDocuments()]);
  await assert.rejects(
    invoices.createInvoice(
      { warehouseId: gye._id, partyId: customer._id, date: "2026-11-04", lines: [{ productId: achiote._id, qty: 10 }, { productId: linaza._id, qty: 5 }] },
      ACTOR,
    ),
    /Stock insuficiente de LINAZA/,
  );
  assert.deepEqual(await Promise.all([SalesInvoice.countDocuments(), JournalEntry.countDocuments(), ArMovement.countDocuments()]), before);
  assert.equal((await stock(achiote)).qty, 360);
});

test("NC parcial baja el saldo, reingresa al costo de salida y no excede saldo ni cantidad", async () => {
  const nc: any = await creditNotes.createCreditNote(
    { invoiceId: firstInvoice._id, date: "2026-11-05", reason: "DEVOLUCION DE 10 LB DE ACHIOTE", lines: [{ productId: achiote._id, qty: 10 }] },
    ACTOR,
  );
  assert.equal(nc.number, "001-001-000000001");
  assert.equal(nc.total, 3000);
  assert.equal((await SalesInvoice.findById(firstInvoice._id).lean<any>()).balance, 18775);
  assert.equal((await stock(achiote)).qty, 370);
  assert.equal((await stock(achiote)).totalValue, 63000 + 1750);
  const entry = await JournalEntry.findById(nc.journalEntryId).lean<any>();
  assert.equal(lineOf(entry, "4.1.01.01.01.001").debit, 3000);
  assert.equal(lineOf(entry, "1.1.02.01.01.001").credit, 3000);
  assert.equal(lineOf(entry, "1.1.03.01.01.001").debit, 1750);
  assert.equal(lineOf(entry, "5.1.01.01.01.001").credit, 1750);

  await assert.rejects(
    creditNotes.createCreditNote({ invoiceId: firstInvoice._id, date: "2026-11-05", reason: "x", lines: [{ productId: achiote._id, qty: 31 }] }, ACTOR),
    /solo quedan 30/,
  );
  await assert.rejects(
    creditNotes.createCreditNote({ invoiceId: firstInvoice._id, date: "2026-11-05", reason: "x", returnsStock: false, lines: [{ productId: almendras._id, qty: 1, unitPrice: 9999999 }] }, ACTOR),
    /supera el saldo/,
  );
});

test("nota de débito suma al saldo con IVA", async () => {
  const nd: any = await debitNotes.createDebitNote({ invoiceId: firstInvoice._id, date: "2026-11-06", reason: "Flete", amount: 1000, vatRate: 15 }, ACTOR);
  assert.equal(nd.total, 1150);
  assert.equal((await SalesInvoice.findById(firstInvoice._id).lean<any>()).balance, 18775 + 1150);
});

test("anular: reversa asiento, devuelve stock; con abonos/NC no se puede", async () => {
  const inv: any = await invoices.createInvoice({ warehouseId: gye._id, partyId: customer._id, date: "2026-11-06", lines: [{ productId: achiote._id, qty: 20, unitPrice: 300 }] }, ACTOR);
  assert.equal(inv.number, "001-001-000000002"); // el intento fallido no consumió secuencial
  assert.equal((await stock(achiote)).qty, 350);
  const voided = await invoices.voidInvoice(String(inv._id), { reason: "Error de digitación", date: "2026-11-06" }, ACTOR);
  assert.equal(voided.status, "anulado");
  assert.equal(voided.balance, 0);
  assert.equal((await stock(achiote)).qty, 370);
  assert.equal((await JournalEntry.findById(inv.journalEntryId).lean<any>()).status, "anulado");
  await assert.rejects(invoices.voidInvoice(String(firstInvoice._id), { reason: "x", date: "2026-11-06" }, ACTOR), /abonos, notas o retenciones/);
});

test("proforma no mueve stock y se convierte en factura", async () => {
  const pf: any = await proformas.createProforma({ warehouseId: gye._id, partyId: customer._id, date: "2026-11-06", lines: [{ productId: achiote._id, qty: 5 }] }, ACTOR);
  assert.equal(pf.total, 725); // precio de lista GENERAL 1.45
  assert.equal((await stock(achiote)).qty, 370);
  const inv: any = await proformas.invoiceProforma(String(pf._id), { date: "2026-11-07" }, ACTOR);
  assert.equal(inv.orderRef, pf.number);
  assert.equal(inv.total, 725);
  assert.equal((await stock(achiote)).qty, 365);
  await assert.rejects(proformas.invoiceProforma(String(pf._id), {}, ACTOR), /ya fue facturada/);
});

test("reportes de ventas: resumido por bodega/día, vendedor y más vendidos", async () => {
  const summary: any = await reports.salesReport({ from: "2026-11-01", to: "2026-11-30" });
  assert.equal(summary.totals.count, 2);
  assert.equal(summary.totals.total, 21775 + 725);
  assert.equal(summary.groups[0].days.length, 2);
  const withVoided: any = await reports.salesReport({ from: "2026-11-01", to: "2026-11-30", includeVoided: "true", type: "detailed" });
  assert.equal(withVoided.groups[0].days.flatMap((d: any) => d.rows).length, 3);
  assert.equal(withVoided.totals.total, 21775 + 725);
  const bySeller: any = await reports.salesReport({ type: "seller" });
  assert.equal(bySeller.items[0].name, "RUBEN PALMA");
  const top: any = await reports.topProducts({ by: "qty", limit: "1" });
  assert.equal(top.items[0].code, "000002");
  assert.equal(top.items[0].qty, 45);
  const byValue: any = await reports.topProducts({ by: "value", groupId: String(almendras.groupId) });
  assert.deepEqual(byValue.items.map((i: any) => i.code), ["000005"]);
});

test("RIDE: A4 y ticket de factura (con firma del cliente) y de la NC", async () => {
  const a4 = await rides.ride("invoice", String(firstInvoice._id), "a4");
  assert.match(a4, /FACTURA 001-001-000000001/);
  assert.match(a4, /RUBEN PALMA/);
  assert.match(a4, /217\.75/);
  assert.doesNotMatch(a4, /Firma del cliente/);
  assert.match(await rides.ride("invoice", String(firstInvoice._id), "ticket"), /Firma del cliente/);
  const nc: any = (await creditNotes.listCreditNotes({ invoiceId: String(firstInvoice._id) })).items[0];
  assert.match(await rides.ride("creditNote", String(nc._id), "a4"), /NOTA DE CRÉDITO[\s\S]*001-001-000000001/);
  await assert.rejects(rides.ride("debitNote", String(nc._id), "a4"), /no encontrado/);
});
