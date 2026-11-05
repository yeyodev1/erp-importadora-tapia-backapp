import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { setup, teardown, ACTOR } from "./helpers";
import { Account } from "../src/models/account.model";
import { ImportBatch } from "../src/models/importBatch.model";
import { JournalEntry } from "../src/models/journalEntry.model";

let accounting: typeof import("../src/services/accounting.service");
let recode: typeof import("../src/services/openingRecode.service");
before(async () => {
  await setup();
  accounting = await import("../src/services/accounting.service");
  recode = await import("../src/services/openingRecode.service");
});
after(teardown);

const CUSTOMERS = "1.1.02.01.01.001";
const OPENING = "3.1.01.01.01.001";
const REAL = "1.1.02.01.01.009";

test("pasar saldos iniciales migrados a la cuenta real: cambia el asiento, lo anota en el lote y no toca otros módulos", async () => {
  await Account.create({ code: REAL, name: "Cartera Clientes Comerciales", kind: "movimiento", parentCode: "1.1.02.01.01", level: 6 });
  const batchId = new Types.ObjectId();
  await ImportBatch.create({ _id: batchId, number: "MIG-000099", source: "macio", cutoff: new Date(), createdBy: ACTOR });
  const lines = [{ accountCode: CUSTOMERS, debit: 5000 }, { accountCode: OPENING, credit: 5000 }];
  const entry = await accounting.postEntry({ date: new Date(), type: "DIARIO", description: "Saldo inicial", source: { module: "migracion", docType: "SALDO_INICIAL_CXC", docId: batchId, docNumber: "MIG-000099" }, lines }, ACTOR);

  await assert.rejects(recode.recodeOpening({ from: CUSTOMERS, to: "1.1.02", reason: "x" }, ACTOR), /no es de movimiento/);
  const r = await recode.recodeOpening({ from: CUSTOMERS, to: REAL, reason: "plan real de Tapia" }, ACTOR);
  assert.deepEqual(r.entries, [entry.number]);
  const moved = await JournalEntry.findById(entry._id).lean<any>();
  assert.deepEqual(moved.lines.map((l: any) => [l.accountCode, l.accountName]).slice(0, 1), [[REAL, "Cartera Clientes Comerciales"]]);
  assert.equal(moved.lines[1].accountCode, OPENING, "la otra línea no cambia");
  assert.match((await ImportBatch.findById(batchId).lean<any>()).warnings.join(), /pasados a 1\.1\.02\.01\.01\.009/);

  await accounting.postEntry({ date: new Date(), type: "DIARIO", description: "Otro", source: { module: "bancos", docType: "CHEQUE", docId: new Types.ObjectId(), docNumber: "1" }, lines: [{ accountCode: REAL, debit: 100 }, { accountCode: OPENING, credit: 100 }] }, ACTOR);
  await assert.rejects(recode.recodeOpening({ from: REAL, to: CUSTOMERS, reason: "volver" }, ACTOR), /de otro módulo/);
});
