import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, ACTOR, day } from "./helpers";
import { runInTransaction } from "../src/config/transaction";
import * as accounting from "../src/services/accounting.service";
import * as inventory from "../src/services/inventoryCore.service";
import { Product } from "../src/models/product.model";
import { Warehouse } from "../src/models/warehouse.model";
import { JournalEntry } from "../src/models/journalEntry.model";
import { StockBalance } from "../src/models/stockBalance.model";
import { Settings } from "../src/models/settings.model";

before(setup);
after(teardown);

const source = { module: "test", docType: "TEST", docId: null, docNumber: "" };

test("un asiento descuadrado no se graba", async () => {
  await assert.rejects(
    runInTransaction((s) =>
      accounting.postEntry(
        { date: day("2026-11-04"), type: "DIARIO", description: "x", lines: [
          { accountCode: "1.1.01.02.01.004", debit: 1000 },
          { accountCode: "2.1.01.01.01.001", credit: 999 },
        ] },
        ACTOR, s,
      ),
    ),
    /no cuadra/,
  );
  assert.equal(await JournalEntry.countDocuments(), 0);
});

test("no se puede mover una cuenta de mayor", async () => {
  await assert.rejects(
    runInTransaction((s) =>
      accounting.postEntry(
        { date: day("2026-11-04"), type: "DIARIO", description: "x", lines: [
          { accountCode: "1.1.01.02", debit: 500 },
          { accountCode: "2.1.01.01.01.001", credit: 500 },
        ] },
        ACTOR, s,
      ),
    ),
    /de mayor/,
  );
});

test("asiento válido, reverso y período cerrado", async () => {
  const entry = await runInTransaction((s) =>
    accounting.postEntry(
      { date: day("2026-10-15"), type: "DIARIO", description: "pago", lines: [
        { accountCode: "2.1.01.01.01.001", debit: 20000 },
        { accountCode: "1.1.01.02.01.004", credit: 20000 },
      ] },
      ACTOR, s,
    ),
  );
  assert.equal(entry.number, "2026-000001");
  await runInTransaction((s) => accounting.reverseEntry(entry._id, "error", day("2026-10-16"), ACTOR, s));
  const original = await JournalEntry.findById(entry._id).lean<any>();
  assert.equal(original.status, "anulado");

  await Settings.updateOne({ _id: "main" }, { lockedThrough: "2026-10" });
  await assert.rejects(
    runInTransaction((s) =>
      accounting.postEntry(
        { date: day("2026-10-20"), type: "DIARIO", description: "tarde", lines: [
          { accountCode: "2.1.01.01.01.001", debit: 100 },
          { accountCode: "1.1.01.02.01.004", credit: 100 },
        ] },
        ACTOR, s,
      ),
    ),
    /cerrado/,
  );
  await Settings.updateOne({ _id: "main" }, { lockedThrough: null });
});

test("costo promedio ponderado: compra, compra, venta y la transferencia no queda en cero", async () => {
  const product = await Product.findOne({ code: "000002" }).lean<any>();
  const [gye, uio] = await Warehouse.find().sort({ code: 1 }).lean<any[]>();
  const move = (type: any, warehouseId: any, qty: number, unitCost?: number) =>
    runInTransaction((s) =>
      inventory.applyMovement({ warehouseId, date: day("2026-11-04"), type, source, lines: [{ productId: product._id, qty, unitCost }] }, ACTOR, s),
    );

  await move("INGRESO_COMPRA", gye._id, 100, 1.0);
  await move("INGRESO_IMPORTACION", gye._id, 300, 2.0); // promedio (100 + 600) / 400 = 1.75
  const sale = await move("EGRESO_VENTA", gye._id, 40);
  assert.equal(sale[0].unitCost, 1.75);
  assert.equal(sale[0].totalCost, 7000);

  const out = await move("EGRESO_TRANSFERENCIA", gye._id, 60);
  await move("INGRESO_TRANSFERENCIA", uio._id, 60, out[0].unitCost);
  const uioBal = await StockBalance.findOne({ productId: product._id, warehouseId: uio._id }).lean<any>();
  assert.equal(uioBal.avgCost, 1.75);
  assert.equal(uioBal.totalValue, 10500);

  await assert.rejects(move("EGRESO_VENTA", gye._id, 1000), /Stock insuficiente/);
  const gyeBal = await StockBalance.findOne({ productId: product._id, warehouseId: gye._id }).lean<any>();
  assert.equal(gyeBal.qty, 300);
  assert.equal(gyeBal.totalValue, 70000 - 7000 - 10500);
});
