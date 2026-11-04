import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, teardown, ACTOR } from "./helpers";
import { BankAccount } from "../src/models/bankAccount.model";
import { BankMovement } from "../src/models/bankMovement.model";
import { JournalEntry } from "../src/models/journalEntry.model";
import { Party } from "../src/models/party.model";
import { PurchaseInvoice } from "../src/models/purchaseInvoice.model";
import { WithholdingCode } from "../src/models/withholdingCode.model";
import * as xml from "../src/services/purchaseXml.service";
import * as payables from "../src/services/payables.service";
import * as payments from "../src/services/supplierPayments.service";
import * as creditNotes from "../src/services/supplierCreditNote.service";
import * as payableReports from "../src/services/payableReports.service";
import * as purchaseReports from "../src/services/purchaseReports.service";

// purchaseInvoice.service carga el emisor SRI, que lee env.ts (exige DB_URI): se importa tras levantar la base.
let invoices: typeof import("../src/services/purchaseInvoice.service");
before(async () => {
  await setup();
  invoices = await import("../src/services/purchaseInvoice.service");
  const { env } = await import("../src/config/env");
  // Un .env local con la firma real no debe mandar retenciones al SRI desde las pruebas.
  Object.assign(env, { SRI_P12_BASE64: "", SRI_P12_PASSWORD: "" });
});
after(teardown);

const FIXTURE = readFileSync(join(__dirname, "fixtures/factura-proveedor-autorizada.xml"), "utf8");
const EXPENSE = "5.2.02.01.01.001"; // Mantenimiento Vehículos Livianos
const code = async (tax: string, c: string) => (await WithholdingCode.findOne({ tax, code: c }).lean<any>())._id;
const pichincha = async () => (await BankAccount.findOne({ name: "Banco Pichincha" }).lean<any>())._id;

async function simpleInvoice(supplierId: unknown, number: string, base0: number) {
  return invoices.createInvoice(
    { supplierId, docType: "01", series: "001-001", number, date: "2026-10-20", taxSupport: "01", expenseLines: [{ accountCode: EXPENSE, base0 }] },
    ACTOR,
  ) as Promise<any>;
}

test("lee la factura SRI envuelta en <autorizacion> con CDATA", () => {
  const parsed = xml.parseInvoiceXml(FIXTURE);
  assert.equal(parsed.supplier.ruc, "0991234567001");
  assert.equal(parsed.supplier.name, "TECNICENTRO AUTOMOTRIZ DEL PACIFICO S.A.");
  assert.equal(parsed.invoice.docNumber, "001-002-000012345");
  assert.equal(parsed.invoice.date, "2026-10-14");
  assert.equal(parsed.invoice.accessKey.length, 49);
  assert.equal(parsed.invoice.authorization, parsed.invoice.accessKey);
  assert.deepEqual([parsed.invoice.base0, parsed.invoice.baseVat, parsed.invoice.vat, parsed.invoice.total], [0, 16755, 2513, 19268]);
  assert.equal(parsed.invoice.lines.length, 2);
  assert.equal(parsed.invoice.lines[1].subtotal, 13955);
  assert.equal(parsed.invoice.creditDays, 30);
});

test("asiento del video: base 167.55, IVA 25.13, IR 2 % y 3 %, IVA 10 % y 20 % → a pagar 183.32; duplicado detectado", async () => {
  const imported: any = await xml.importXml(FIXTURE, { createSupplier: true });
  assert.equal(imported.duplicate, false);
  assert.ok(imported.supplier.existingId);
  assert.deepEqual(imported.warnings, []);

  const inv: any = await invoices.createInvoice(
    {
      supplierId: imported.supplier.existingId,
      docType: "01",
      series: "001-002",
      number: "000012345",
      date: imported.invoice.date,
      accessKey: imported.invoice.accessKey,
      authorization: imported.invoice.authorization,
      creditDays: imported.invoice.creditDays,
      taxSupport: "01",
      goodsOrServices: "servicio",
      vat: imported.invoice.vat,
      expenseLines: [{ accountCode: EXPENSE, baseVat: 16755, description: "Mantenimiento camioneta" }],
      // Bases como en el comprobante del video: 28.00 de bienes al 2 % y 139.55 de servicios al 3 %; IVA 4.19 y 20.94.
      withholdings: [
        { codeId: await code("renta", "312"), base: 2800, rate: 2 },
        { codeId: await code("renta", "307"), base: 13955, rate: 3 },
        { codeId: await code("iva", "721"), base: 419, rate: 10, amount: 42 },
        { codeId: await code("iva", "723"), base: 2094, rate: 20 },
      ],
    },
    ACTOR,
  );
  assert.equal(inv.total, 19268);
  assert.equal(inv.withholdingTotal, 936);
  assert.equal(inv.payable, 18332);
  assert.equal(inv.balance, 18332);
  assert.equal(inv.withholding.number, "001-001-000000001");
  assert.equal(inv.withholding.sriStatus, "sin_firma");

  const entry = await JournalEntry.findById(inv.journalEntryId).lean<any>();
  assert.equal(entry.type, "COMPRA");
  assert.equal(entry.totalDebit, 19268);
  assert.equal(entry.totalCredit, 19268);
  const at = (accountCode: string) => entry.lines.filter((l: any) => l.accountCode === accountCode);
  assert.equal(at(EXPENSE)[0].debit, 16755);
  assert.equal(at("1.1.04.01.01.001")[0].debit, 2513);
  assert.deepEqual(at("2.1.02.02.01.001").map((l: any) => l.credit), [56, 419]);
  assert.deepEqual(at("2.1.02.02.01.002").map((l: any) => l.credit), [42, 419]);
  assert.equal(at("2.1.01.01.01.001")[0].credit, 18332);

  const again: any = await xml.importXml(FIXTURE);
  assert.deepEqual([again.duplicate, again.existingId], [true, String(inv._id)]);
  const batch = await xml.importBatch([FIXTURE, "<no-es-factura/>"]);
  assert.equal(batch.registered.length, 1);
  assert.equal(batch.errors.length, 1);
  await assert.rejects(
    invoices.createInvoice({ supplierId: imported.supplier.existingId, series: "001002", number: "12345", date: "2026-10-14", expenseLines: [{ accountCode: EXPENSE, baseVat: 100 }] }, ACTOR),
    /ya está ingresada/,
  );

  const byCode: any = await purchaseReports.withholdingsReport({ from: "2026-10-01", to: "2026-10-31", by: "code" });
  assert.deepEqual(byCode.totals, { renta: 475, iva: 461 });
  assert.deepEqual(byCode.items.map((g: any) => g.code), ["307", "312", "721", "723"]);
  const bySupport: any = await purchaseReports.purchasesByTaxSupport({ from: "2026-10-01", to: "2026-10-31" });
  assert.equal(bySupport.items[0].baseVat, 16755);
});

test("pago parcial: se aprueban 200 de 1.000, se ejecuta con cheque y anular el pago reabre el saldo", async () => {
  const supplier = await Party.findOne({ identification: "0990000000001" }).lean<any>();
  const inv = await simpleInvoice(supplier._id, "1001", 100000);
  const approval: any = await payables.approve({ date: "2026-10-25", lines: [{ invoiceId: inv._id, amount: 20000 }] }, ACTOR);
  assert.equal(String(approval.beneficiaryId), String(supplier._id));
  let fresh = await PurchaseInvoice.findById(inv._id).lean<any>();
  assert.deepEqual([fresh.balance, fresh.approved], [100000, 20000]); // aprobar no paga
  assert.equal(await JournalEntry.countDocuments({ "source.docType": "PAGO_PROVEEDOR" }), 0);
  await assert.rejects(payables.approve({ lines: [{ invoiceId: inv._id, amount: 80001 }] }, ACTOR), /por aprobar/);

  const pay: any = await payments.executePayment({ approvalIds: [approval._id], bankAccountId: await pichincha(), method: "CHEQUE", date: "2026-10-26" }, ACTOR);
  assert.equal(pay.amount, 20000);
  assert.equal(pay.checkNumber, "1");
  fresh = await PurchaseInvoice.findById(inv._id).lean<any>();
  assert.deepEqual([fresh.balance, fresh.approved], [80000, 0]);
  const entry = await JournalEntry.findById(pay.journalEntryId).lean<any>();
  assert.deepEqual(entry.lines.map((l: any) => [l.accountCode, l.debit, l.credit]), [
    ["2.1.01.01.01.001", 20000, 0],
    ["1.1.01.02.01.004", 0, 20000],
  ]);
  const mov = await BankMovement.findOne({ "source.docId": pay._id }).lean<any>();
  assert.deepEqual([mov.direction, mov.amount, mov.type], ["out", 20000, "CHEQUE"]);
  await assert.rejects(payments.executePayment({ approvalIds: [approval._id], bankAccountId: await pichincha(), method: "CHEQUE" }, ACTOR), /ya pagadas/);

  const balances: any = await payableReports.supplierBalances({ cutoff: "2026-10-31", mode: "por_pagar", supplierId: String(supplier._id) });
  assert.deepEqual([balances.totals.billed, balances.totals.paid, balances.totals.balance], [100000, 20000, 80000]);
  const before = await payableReports.supplierBalances({ cutoff: "2026-10-25", supplierId: String(supplier._id) });
  assert.equal(before.totals.balance, 100000);

  await payments.voidTransaction(String(pay._id), { reason: "cheque dañado", date: "2026-10-27" }, ACTOR);
  fresh = await PurchaseInvoice.findById(inv._id).lean<any>();
  assert.equal(fresh.balance, 100000);
  assert.equal((await BankMovement.findOne({ "source.docId": pay._id }).lean<any>()).status, "anulado");

  // Faltante: NC de 100 baja la CxP a 900.
  await creditNotes.createCreditNote({ invoiceId: inv._id, series: "001-001", number: "77", date: "2026-10-28", lines: [{ accountCode: EXPENSE, base0: 10000 }], reason: "faltante" }, ACTOR);
  assert.equal((await PurchaseInvoice.findById(inv._id).lean<any>()).balance, 90000);
});

test("anticipo de $1.000 a un empleado cruzado contra facturas de dos proveedores y devolución del sobrante", async () => {
  const employee = await Party.findOne({ identification: "0911111111" }).lean<any>();
  const supplierA = await Party.findOne({ identification: "0990000000001" }).lean<any>();
  const supplierB = await Party.create({ identification: "0920000000001", name: "FERRETERIA PEQUEÑA", isSupplier: true });
  const invA = await simpleInvoice(supplierA._id, "2001", 40000);
  const invB = await simpleInvoice(supplierB._id, "3001", 58000);

  const advance: any = await payments.createAdvance({ partyId: employee._id, amount: 100000, bankAccountId: await pichincha(), method: "CHEQUE", date: "2026-10-20" }, ACTOR);
  await payments.crossAdvance(String(advance._id), { date: "2026-10-22", lines: [{ invoiceId: invA._id, amount: 40000 }, { invoiceId: invB._id, amount: 58000 }] }, ACTOR);
  assert.equal((await PurchaseInvoice.findById(invA._id).lean<any>()).balance, 0);
  assert.equal((await PurchaseInvoice.findById(invB._id).lean<any>()).balance, 0);

  let open = await payableReports.openAdvances({});
  assert.equal(open.items.find((a: any) => String(a._id) === String(advance._id))?.open, 2000);
  await assert.rejects(payments.refundAdvance(String(advance._id), { amount: 2001, bankAccountId: await pichincha() }, ACTOR), /solo tiene 20.00/);
  const refund: any = await payments.refundAdvance(String(advance._id), { amount: 2000, bankAccountId: await pichincha(), date: "2026-10-23" }, ACTOR);
  const dep = await BankMovement.findOne({ "source.docId": refund._id }).lean<any>();
  assert.deepEqual([dep.direction, dep.amount], ["in", 2000]);
  open = await payableReports.openAdvances({});
  assert.equal(open.items.some((a: any) => String(a._id) === String(advance._id)), false);
  await assert.rejects(payments.crossAdvance(String(advance._id), { lines: [{ invoiceId: invA._id, amount: 1 }] }, ACTOR), /por aplicar/);

  // Anticipos a proveedores quedó en cero para el empleado: 1.000 al debe, 980 + 20 al haber.
  const entries = await JournalEntry.find({ status: "contabilizado", "lines.partyId": employee._id }).lean<any[]>();
  const advLines = entries.flatMap((e) => e.lines).filter((l: any) => l.accountCode === "1.1.02.02.01.001" && String(l.partyId) === String(employee._id));
  assert.equal(advLines.reduce((s: number, l: any) => s + l.debit - l.credit, 0), 0);
  const balances: any = await payableReports.supplierBalances({ mode: "canceladas", cutoff: "2026-10-31" });
  assert.ok(balances.items.find((r: any) => r.name === "FERRETERIA PEQUEÑA" && r.balance === 0));
});

test("compra de mercadería ingresa a bodega con su costo y anularla saca el stock", async () => {
  const { Product } = await import("../src/models/product.model");
  const { Warehouse } = await import("../src/models/warehouse.model");
  const { StockBalance } = await import("../src/models/stockBalance.model");
  const supplier = await Party.findOne({ identification: "0990000000001" }).lean<any>();
  const product = await Product.findOne({ code: "000031" }).lean<any>(); // LINAZA, grupo Granos y semillas
  const gye = await Warehouse.findOne({ code: "GYE" }).lean<any>();
  const inv: any = await invoices.createInvoice(
    { supplierId: supplier._id, series: "001-001", number: "4001", date: "2026-10-21", warehouseId: gye._id, productLines: [{ productId: product._id, qty: 300, subtotal: 28500 }] },
    ACTOR,
  );
  const entry = await JournalEntry.findById(inv.journalEntryId).lean<any>();
  assert.equal(entry.lines.find((l: any) => l.accountCode === "1.1.03.01.01.003").debit, 28500);
  let bal = await StockBalance.findOne({ productId: product._id, warehouseId: gye._id }).lean<any>();
  assert.deepEqual([bal.qty, bal.avgCost, bal.totalValue], [300, 0.95, 28500]);

  await invoices.voidInvoice(String(inv._id), { reason: "mal ingresada", date: "2026-10-22" }, ACTOR);
  bal = await StockBalance.findOne({ productId: product._id, warehouseId: gye._id }).lean<any>();
  assert.deepEqual([bal.qty, bal.totalValue], [0, 0]);
  assert.equal((await JournalEntry.findById(inv.journalEntryId).lean<any>()).status, "anulado");
});
