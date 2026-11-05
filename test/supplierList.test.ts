import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, ACTOR } from "./helpers";
import { Party } from "../src/models/party.model";

let list: typeof import("../src/services/migrationSupplierList.service");
let undo: typeof import("../src/services/migrationUndo.service");
before(async () => {
  await setup();
  list = await import("../src/services/migrationSupplierList.service");
  undo = await import("../src/services/migrationUndo.service");
});
after(teardown);

const NEW_RUC = "0992304219001";
const rows = (clientRuc: string) => [
  { line: 16, name: "acgroup worldwide ecuador s.a.", identification: NEW_RUC, address: "GUAYAQUIL", phone: "999999999 -", email: "a@acgroup.ec;b@acgroup.ec" },
  { line: 18, name: "Cliente que también vende", identification: clientRuc, address: "", phone: "0984441197-", email: "" },
  { line: 20, name: "Repetido", identification: NEW_RUC, address: "", phone: "", email: "" },
  { line: 22, name: "", identification: "1790011674001", address: "", phone: "", email: "" },
];

test("listado de proveedores en Excel: crea los nuevos, marca proveedor al cliente existente y se quita dejando todo como antes", async () => {
  const client = await Party.create({ identification: "1790016919001", name: "CLIENTE", isCustomer: true, address: "QUITO" });
  const p = await list.previewSupplierList(rows(client.identification));
  assert.deepEqual([p.counts.toCreate, p.counts.toMark, p.counts.skipped], [1, 1, 2]);
  assert.equal(await Party.countDocuments({ identification: NEW_RUC }), 0, "la vista previa no graba");

  const { batch } = await list.applySupplierList(rows(client.identification), ACTOR);
  const created = await Party.findOne({ identification: NEW_RUC }).lean<any>();
  assert.equal(created.name, "ACGROUP WORLDWIDE ECUADOR S.A.");
  assert.equal(created.isSupplier, true);
  assert.equal(created.phone, "", "999999999 de Macio es sin teléfono");
  assert.equal(created.email, "a@acgroup.ec");
  const marked = await Party.findById(client._id).lean<any>();
  assert.deepEqual([marked.isSupplier, marked.isCustomer, marked.address, marked.phone], [true, true, "QUITO", "0984441197"]);
  await assert.rejects(list.applySupplierList(rows(client.identification).slice(0, 2), ACTOR), /ya están en el sistema/);

  await undo.undoBatch(String(batch._id), { reason: "prueba" }, ACTOR);
  assert.equal(await Party.countDocuments({ identification: NEW_RUC }), 0);
  const back = await Party.findById(client._id).lean<any>();
  assert.deepEqual([back.isSupplier, back.phone, back.address], [false, "", "QUITO"]);
});
