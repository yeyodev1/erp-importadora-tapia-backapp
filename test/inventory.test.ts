import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, ACTOR } from "./helpers";
import * as inventory from "../src/services/inventory.service";
import * as reports from "../src/services/inventoryReports.service";
import * as counts from "../src/services/inventoryCount.service";
import { Product } from "../src/models/product.model";
import { Warehouse } from "../src/models/warehouse.model";
import { JournalEntry } from "../src/models/journalEntry.model";
import { StockBalance } from "../src/models/stockBalance.model";

after(teardown);

let gye: any, uio: any, achiote: any, almendras: any, lenteja: any;
let secondImport: any, lentejaImport: any, transfer: any;

const balance = async (product: any, warehouse: any) =>
  (await StockBalance.findOne({ productId: product._id, warehouseId: warehouse._id }).lean<any>()) ?? { qty: 0, totalValue: 0 };

/** Suma del debe menos haber de una cuenta en todos los asientos (vivos y reversos). */
async function ledger(code: string): Promise<number> {
  const [r] = await JournalEntry.aggregate([
    { $unwind: "$lines" },
    { $match: { "lines.accountCode": code } },
    { $group: { _id: null, v: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } },
  ]);
  return r?.v ?? 0;
}

before(async () => {
  await setup();
  [gye, uio] = await Warehouse.find().sort({ code: 1 }).lean<any[]>();
  achiote = await Product.findOne({ code: "000002" }).lean();
  almendras = await Product.findOne({ code: "000005" }).lean();
  lenteja = await Product.findOne({ code: "000030" }).lean();
});

test("importación: asiento cuadrado contra inventario en tránsito, por grupo", async () => {
  const doc = await inventory.create(
    {
      type: "INGRESO_IMPORTACION", warehouseId: String(gye._id), date: "2026-11-02", containers: 2,
      lines: [
        { productId: String(achiote._id), qty: 1000, unitCost: 0.85 },
        { productId: String(almendras._id), qty: 500, unitCost: 3.2 },
      ],
    },
    ACTOR,
  );
  assert.equal(doc.number, "000001");
  assert.equal(doc.totalCost, 245000);
  const entry = await JournalEntry.findById(doc.journalEntryId).lean<any>();
  assert.equal(entry.totalDebit, entry.totalCredit);
  const byCode = Object.fromEntries(entry.lines.map((l: any) => [l.accountCode, l]));
  assert.equal(byCode["1.1.03.01.01.001"].debit, 85000);
  assert.equal(byCode["1.1.03.01.01.002"].debit, 160000);
  assert.equal(byCode["1.1.03.01.01.004"].credit, 245000);
});

test("validaciones en la frontera", async () => {
  const line = { productId: String(achiote._id), qty: 0, unitCost: 1 };
  await assert.rejects(
    inventory.create({ type: "INGRESO_IMPORTACION", warehouseId: String(gye._id), date: "2026-11-02", lines: [line] }, ACTOR),
    /mayor que cero/,
  );
  await assert.rejects(
    inventory.create({ type: "EGRESO_VENTA", warehouseId: String(gye._id), date: "2026-11-02", lines: [line] }, ACTOR),
    /Tipo de transacción inválido/,
  );
  await assert.rejects(
    inventory.create(
      { type: "INGRESO_COMPRA", warehouseId: String(gye._id), date: "2026-11-02", lines: [{ ...line, qty: 1 }] },
      ACTOR,
    ),
    /proveedor/,
  );
});

test("merma: Debe mermas / Haber inventario al costo promedio", async () => {
  secondImport = await inventory.create(
    { type: "INGRESO_IMPORTACION", warehouseId: String(gye._id), date: "2026-11-03",
      lines: [{ productId: String(achiote._id), qty: 1000, unitCost: 0.9 }] },
    ACTOR,
  );
  const doc = await inventory.create(
    { type: "EGRESO_AJUSTE", warehouseId: String(gye._id), date: "2026-11-04", responsible: "Jefe de bodega",
      lines: [{ productId: String(achiote._id), qty: 2 }] },
    ACTOR,
  );
  assert.equal(doc.lines[0].unitCost, 0.875); // (850 + 900) / 2000
  assert.equal(doc.totalCost, 175);
  const entry = await JournalEntry.findById(doc.journalEntryId).lean<any>();
  const byCode = Object.fromEntries(entry.lines.map((l: any) => [l.accountCode, l]));
  assert.equal(byCode["5.2.02.01.01.005"].debit, 175);
  assert.equal(byCode["1.1.03.01.01.001"].credit, 175);
});

test("transferencia: mueve el costo exacto y no cambia el total contable", async () => {
  lentejaImport = await inventory.create(
    { type: "INGRESO_IMPORTACION", warehouseId: String(gye._id), date: "2026-11-03",
      lines: [{ productId: String(lenteja._id), qty: 300, unitCost: 0.333333 }] },
    ACTOR,
  );
  const before = await ledger("1.1.03.01.01.003");
  const entries = await JournalEntry.countDocuments();
  transfer = await inventory.create(
    { type: "TRANSFERENCIA", warehouseId: String(gye._id), targetWarehouseId: String(uio._id), date: "2026-11-04",
      responsible: "Chofer", lines: [{ productId: String(lenteja._id), qty: 100 }] },
    ACTOR,
  );
  assert.equal(transfer.journalEntryId, null);
  assert.equal(await JournalEntry.countDocuments(), entries);
  assert.equal(await ledger("1.1.03.01.01.003"), before);
  const [g, u] = [await balance(lenteja, gye), await balance(lenteja, uio)];
  assert.equal(u.totalValue, transfer.totalCost);
  assert.equal(g.totalValue + u.totalValue, lentejaImport.totalCost);
  assert.equal(g.qty, 200);
  assert.equal(u.qty, 100);
});

test("anular revierte stock y asiento; no deja anular si queda negativo", async () => {
  await assert.rejects(
    inventory.voidTransaction(String(lentejaImport._id), { reason: "error", date: "2026-11-05" }, ACTOR),
    /Stock insuficiente/,
  );
  const voided = await inventory.voidTransaction(String(secondImport._id), { reason: "duplicada", date: "2026-11-05" }, ACTOR);
  assert.equal(voided.status, "anulado");
  const b = await balance(achiote, gye);
  assert.equal(b.qty, 998);
  assert.equal(b.totalValue, 85000 + 90000 - 175 - 90000);
  const original = await JournalEntry.findById(secondImport.journalEntryId).lean<any>();
  assert.equal(original.status, "anulado");
  assert.equal(await ledger("1.1.03.01.01.004"), -85000 - 160000 - 10000);
  await assert.rejects(inventory.voidTransaction(String(secondImport._id), { reason: "otra vez" }, ACTOR), /ya está anulada/);

  // La transferencia se anula devolviendo lo mismo que movió.
  await inventory.voidTransaction(String(transfer._id), { reason: "no salió", date: "2026-11-05" }, ACTOR);
  assert.equal((await balance(lenteja, uio)).qty, 0);
  assert.equal((await balance(lenteja, uio)).totalValue, 0);
  assert.equal((await balance(lenteja, gye)).totalValue, lentejaImport.totalCost);
});

test("kardex: saldo anterior y saldo recalculado por fecha", async () => {
  const k = await reports.kardex({ productId: String(achiote._id), warehouseId: String(gye._id), from: "2026-11-03", to: "2026-11-30" });
  assert.deepEqual(k.opening, { qty: 1000, unitCost: 0.85, total: 85000 });
  assert.equal(k.items.length, 3);
  assert.equal(k.items[1].outbound?.total, 175);
  assert.equal(k.items[1].party, "Jefe de bodega");
  assert.match(k.items[2].voucher, /^Anulación/);
  assert.deepEqual(k.closing, { qty: 998, unitCost: 0.84995, total: 84825 });
});

test("toma física y ajuste por diferencias", async () => {
  const toma = await counts.physicalCount({ warehouseId: String(gye._id) });
  const row = toma.items.find((r) => r.code === "000002")!;
  assert.equal(row.qty, 998);
  assert.equal(row.purchaseQty, 9.98);
  assert.equal(row.count, null);

  const { ingreso, egreso } = await counts.adjustFromCount(
    {
      warehouseId: String(gye._id), date: "2026-11-06",
      counts: [
        { productId: String(achiote._id), count: 990 },
        { productId: String(almendras._id), count: 505 },
        { productId: String(lenteja._id), count: 300 },
      ],
    },
    ACTOR,
  );
  assert.equal(egreso!.type, "EGRESO_AJUSTE");
  assert.equal(egreso!.lines.length, 1);
  assert.equal(egreso!.lines[0].qty, 8);
  assert.equal(ingreso!.type, "INGRESO_AJUSTE");
  assert.equal(ingreso!.lines[0].qty, 5);
  assert.equal(ingreso!.totalCost, 1600); // 5 × 3.20 al promedio
  assert.equal((await balance(achiote, gye)).qty, 990);
  assert.equal((await balance(almendras, gye)).qty, 505);
  const entry = await JournalEntry.findById(ingreso!.journalEntryId).lean<any>();
  const byCode = Object.fromEntries(entry.lines.map((l: any) => [l.accountCode, l]));
  assert.equal(byCode["1.1.03.01.01.002"].debit, 1600);
  assert.equal(byCode["5.2.02.01.01.005"].credit, 1600);

  await assert.rejects(
    counts.adjustFromCount({ warehouseId: String(gye._id), date: "2026-11-06", counts: [{ productId: String(achiote._id), count: 990 }] }, ACTOR),
    /no hay nada que ajustar/,
  );
  const saldos = await reports.balances({ warehouseId: String(gye._id), valued: "true" });
  assert.equal(saldos.total, sum(saldos.items.map((i: any) => i.totalValue)));
});

function sum(v: number[]) {
  return v.reduce((a, b) => a + b, 0);
}
