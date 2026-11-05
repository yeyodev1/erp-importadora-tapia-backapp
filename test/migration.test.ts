import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, ACTOR } from "./helpers";
import { Party } from "../src/models/party.model";
import { Product } from "../src/models/product.model";
import { SalesInvoice } from "../src/models/salesInvoice.model";
import { ArMovement } from "../src/models/arMovement.model";
import { StockBalance } from "../src/models/stockBalance.model";
import { JournalEntry } from "../src/models/journalEntry.model";
import { BankAccount } from "../src/models/bankAccount.model";
import { idProblem, idTypeOf, groupOf } from "../src/services/migrationRules.service";

// env.ts exige DB_URI al cargarse: los services se importan después de levantar la base en memoria.
let macio: typeof import("../src/services/migrationMacio.service");
let preview: typeof import("../src/services/migrationPreview.service");
let undo: typeof import("../src/services/migrationUndo.service");
let suppliers: typeof import("../src/services/migrationSuppliers.service");
let demo: typeof import("../src/services/migrationDemo.service");
let ar: typeof import("../src/services/receivablesReport.service");
let ledger: typeof import("../src/services/ledgerReports.service");
let receipts: typeof import("../src/services/receipt.service");
let sales: typeof import("../src/services/salesReport.service");
let invoices: typeof import("../src/services/invoice.service");
before(async () => {
  await setup();
  macio = await import("../src/services/migrationMacio.service");
  preview = await import("../src/services/migrationPreview.service");
  undo = await import("../src/services/migrationUndo.service");
  suppliers = await import("../src/services/migrationSuppliers.service");
  demo = await import("../src/services/migrationDemo.service");
  ar = await import("../src/services/receivablesReport.service");
  ledger = await import("../src/services/ledgerReports.service");
  receipts = await import("../src/services/receipt.service");
  sales = await import("../src/services/salesReport.service");
  invoices = await import("../src/services/invoice.service");
});
after(teardown);

const CUSTOMERS = "1.1.02.01.01.001";
const OPENING = "3.1.01.01.01.001";

/** Exportación INVENTADA con la forma real de Macio (números como texto, fechas ISO a las 05:00Z). */
const cli = (code: string, name: string, id: string, seller = "1") => ({
  per_codigo: code, per_nombre: name, per_direccion: `DIRECCION ${code}`, per_identificacion: id, per_telefono: "0990000000",
  per_email: `c${code}@ejemplo.test`, ven_codigo: seller, ven_nombre: seller === "1" ? "VENDEDOR UNO" : "VENDEDOR DOS",
});
const inv = (name: string, tipdoc: string, serdoc: string, num: string, total: string, paid: string, saldo: string, date: string, due: string, days = 30) => ({
  per_nombre: name, per_diascredito: days, trc_codigo: num, trc_tipdoc: tipdoc, descripcion_tipdoc: tipdoc === "1" ? "Factura ventas" : "Nota de Crédito ventas",
  trc_serdoc: serdoc, trc_numdoc: num, numero_factura_impreso: `${serdoc}-${num}`, trc_totfact: total, trc_fecha: `${date}T05:00:00.000Z`,
  fecha_vencimiento: `${due}T05:00:00.000Z`, total_abonado: paid, saldo_pendiente: saldo, estado_factura: "VENCIDO",
});
const stock = (code: string, name: string, unit: string, bod: string, qty: string) => ({
  pro_codigo: code, pro_nombre: name, uni_nombre: unit, bod_codigo: bod, bod_nombre: bod === "12" ? "Bodega Guayaquil" : "Bodega Quito", stock_actual: qty,
});
const FIXTURE = {
  clientes: [
    cli("1", "COMERCIAL  alfa s.a.", "0991234567001"),
    cli("2", "PEREZ JUAN", "0910000009", "2"),
    cli("3", "TURISTA EXTRANJERO", "12345"),
    cli("4", "CONSUMIDOR FINAL", "9999999999999"),
    cli("5", "COMERCIAL ALFA S.A.", "0991234567001"),
    cli("6", "CLIENTE DE EJEMPLO GUAYAQUIL", "0912345678001"),
  ],
  vendedores: [{ ven_codigo: "1", ven_nombre: "VENDEDOR UNO" }, { ven_codigo: "2", ven_nombre: "VENDEDOR DOS" }],
  inventario: [
    stock("2", "ACHIOTE LIBRA", "Libras", "12", "100.0000"),
    stock("40", "ALMENDRAS ENTERAS", "Caja", "12", "10.0000"),
    stock("40", "ALMENDRAS ENTERAS", "Caja", "13", "0.0000"),
    stock("41", "LENTEJA ROJA", "Sacos", "13", "5.5000"),
    stock("42", "COMINO MOLIDO", "Libras", "12", "0.0000"),
  ],
  cartera: [
    inv("COMERCIAL ALFA S.A.", "1", "102999", "100", "1000.00", "400.00", "600.00", "2026-06-01", "2026-07-01", 60),
    inv("PEREZ JUAN", "1", "301999", "200", "250.50", "0.00", "250.50", "2026-10-01", "2026-12-01"),
    inv("CLIENTE DE EJEMPLO GUAYAQUIL", "1", "102999", "300", "99.99", "0.00", "99.99", "2026-09-01", "2026-10-01"),
    inv("COMERCIAL ALFA S.A.", "4", "102999", "50", "50.00", "0.00", "50.00", "2026-06-15", "2026-06-15"),
    inv("NADIE CONOCIDO", "1", "102999", "400", "10.00", "0.00", "10.00", "2026-06-01", "2026-06-01"),
  ],
};
const IMPORTED = 60000 + 25050 + 9999;

async function balanceOf(code: string) {
  const [r] = await JournalEntry.aggregate([{ $unwind: "$lines" }, { $match: { "lines.accountCode": code } }, { $group: { _id: null, v: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]);
  return r?.v ?? 0;
}
const snapshot = async () => ({
  parties: await Party.countDocuments(), products: await Product.countDocuments(), invoices: await SalesInvoice.countDocuments(),
  ar: await ArMovement.countDocuments(), stock: (await StockBalance.find().lean<any[]>()).reduce((a, b) => a + b.qty, 0),
  customers: await balanceOf(CUSTOMERS), opening: await balanceOf(OPENING),
});

test("reglas: tipo de identificación, validación y grupo sugerido", () => {
  assert.equal(idTypeOf("0991234567001"), "04");
  assert.equal(idTypeOf("0910000009"), "05");
  assert.equal(idTypeOf("12345"), "06");
  assert.equal(idTypeOf("9999999999999"), "07");
  assert.equal(idProblem("0910000009"), "");
  assert.match(idProblem("0910000008"), /verificador/);
  assert.match(idProblem("12345"), /pasaporte/);
  assert.equal(groupOf("MANÍ CONFITADO"), "FRUTOS SECOS");
  assert.equal(groupOf("GRANO DE CHIA NEGRA"), "GRANOS Y SEMILLAS");
  assert.equal(groupOf("CLAVO DE OLOR"), "ESPECIAS");
});

test("vista previa: cuenta bien, excluye NC y no graba nada", async () => {
  const before = await snapshot();
  const p = await preview.previewMacio(FIXTURE);
  assert.equal(p.counts.clientRows, 6);
  assert.equal(p.counts.clients, 5);
  assert.equal(p.counts.repeatedInFile, 1);
  assert.equal(p.counts.existingClients, 1);
  assert.equal(p.counts.invalidIds, 2, "12345 y el RUC de ejemplo 0912345678001 (verificador)");
  assert.equal(p.counts.sellers, 2);
  assert.deepEqual([p.counts.products, p.counts.newProducts, p.counts.existingProducts], [4, 3, 1]);
  assert.equal(p.counts.stockLines, 3);
  assert.equal(p.counts.invoices, 3);
  assert.equal(p.totals.receivables, IMPORTED);
  assert.equal(p.counts.creditNotes, 1);
  assert.equal(p.totals.creditNotes, 5000);
  assert.equal(p.counts.unmatchedInvoices, 1);
  assert.equal(p.products.find((x) => x.code === "000040")!.group, "FRUTOS SECOS");
  assert.equal(p.products.find((x) => x.code === "000041")!.unit, "SACOS");
  assert.ok(p.notices.some((n) => /Notas de crédito excluidas/.test(n)));
  assert.ok(p.canApply);
  assert.deepEqual(await snapshot(), before);
});

test("vista previa: un código que ya existe con otro nombre bloquea la importación", async () => {
  const p = await preview.previewMacio({ ...FIXTURE, inventario: [stock("10", "COMINO", "Libras", "12", "1")] });
  assert.equal(p.counts.conflicts, 1);
  assert.equal(p.canApply, false);
  await assert.rejects(macio.applyMacio({ ...FIXTURE, inventario: [stock("10", "COMINO", "Libras", "12", "1")] }, ACTOR), /otro nombre/);
});

test("importar y quitar: la cartera por edades suma lo importado, el balance cuadra y quitar deja todo como antes", async () => {
  const before = await snapshot();
  const { batch, verification } = await macio.applyMacio(FIXTURE, ACTOR);
  assert.equal(verification.imported, IMPORTED);
  assert.ok(verification.agingMatches && verification.agingCuadra && verification.trialBalanceCuadra);

  const aging = await ar.aging({});
  assert.equal(aging.totals.total, IMPORTED);
  assert.equal(aging.totals.over120, 60000);
  assert.equal(await balanceOf(CUSTOMERS), IMPORTED);
  const tb = await ledger.trialBalance({});
  assert.ok(tb.cuadra);

  const alfa = await Party.findOne({ identification: "0991234567001" }).lean<any>();
  assert.equal(alfa.customer.creditDays, 60);
  assert.equal(alfa.customer.sellerName, "VENDEDOR UNO");
  const opening = await SalesInvoice.findOne({ number: "102999-100" }).lean<any>();
  assert.ok(opening.isOpening && opening.lines.length === 0 && opening.sriStatus === "no_aplica");
  assert.equal(opening.total, 100000);
  assert.equal(opening.balance, 60000);
  const open = await invoices.listInvoices({ status: "vigente", pending: "true", includeOpening: "true" });
  assert.equal(open.total, 3);
  assert.equal((await invoices.listInvoices({})).total, 0, "los saldos iniciales no salen en el listado de ventas");
  assert.equal((await sales.salesReport({ type: "summary" }) as any).totals.count, 0);
  assert.equal((await StockBalance.find().lean<any[]>()).reduce((a, b) => a + b.qty, 0), before.stock + 115.5);
  const demoClient = await Party.findOne({ identification: "0912345678001" }).lean<any>();
  assert.equal(demoClient.address, "DIRECCION 6");
  assert.equal(demoClient.customer.sellerName, "RUBEN PALMA", "no pisa lo que ya tenía");

  await undo.undoBatch(String(batch._id), { reason: "prueba" }, ACTOR);
  const after = await snapshot();
  assert.deepEqual(after, { ...before });
  assert.equal((await Party.findOne({ identification: "0912345678001" }).lean<any>()).address, "");
  assert.equal((await ar.aging({})).totals.total, 0);
  assert.ok((await ledger.trialBalance({})).cuadra);
  await assert.rejects(undo.undoBatch(String(batch._id), { reason: "otra vez" }, ACTOR), /ya se quitó/);
});

test("quitar se niega si ya hay un cobro aplicado a un saldo importado", async () => {
  const { batch } = await macio.applyMacio(FIXTURE, ACTOR);
  await assert.rejects(macio.applyMacio(FIXTURE, ACTOR), /ya hay una importación de Macio aplicada/i);
  const opening = await SalesInvoice.findOne({ number: "301999-200" }).lean<any>();
  const bank = await BankAccount.findOne({ name: "Banco Pichincha" }).lean<any>();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });
  await receipts.createReceipt(
    { partyId: opening.partyId, date: today, method: "DEPOSITO", bankAccountId: bank._id, amount: 5050, applications: [{ invoiceId: opening._id, amount: 5050 }] },
    ACTOR,
  );
  assert.equal((await SalesInvoice.findById(opening._id).lean<any>()).balance, 20000);
  await assert.rejects(undo.undoBatch(String(batch._id), { reason: "prueba" }, ACTOR), /Cobro/);
  assert.equal(await SalesInvoice.countDocuments({ importBatchId: batch._id }), 3, "no deshizo nada");
  await assert.rejects(invoices.voidInvoice(String(opening._id), { reason: "x" }, ACTOR), /saldo inicial/);
});

test("app de Proveedores: sin esa base, la vista previa dice que no hay datos", async () => {
  const p = await suppliers.previewSuppliers();
  assert.equal(p.empty, true);
  assert.equal(p.canApply, false);
});

test("datos de ejemplo: quita lo que nadie usa y lista lo usado", async () => {
  const p = await demo.previewDemo();
  const achiote = p.items.find((i) => i.code === "000002")!;
  assert.equal(achiote.status, "en_uso", "tiene el stock de Macio");
  const customer = p.items.find((i) => i.code === "0912345678001")!;
  assert.equal(customer.status, "en_uso", "tiene un saldo importado y un cobro");
  const r = await demo.applyDemo();
  assert.equal(r.removed.products, 5);
  assert.ok(r.removed.parties >= 2);
  assert.ok(await Product.exists({ code: "000002" }));
  assert.equal(await Product.exists({ code: "000010" }), null);
  assert.equal(await Party.exists({ name: "CLIENTE DE EJEMPLO QUITO" }), null);
  assert.ok(await Party.exists({ identification: "0912345678001" }));
});
