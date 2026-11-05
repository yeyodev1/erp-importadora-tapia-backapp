import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { setup, teardown } from "./helpers";

before(setup);
after(teardown);

test("si la conexión se cae después de conectar, dbConnect vuelve a conectar de verdad (antes devolvía true sin estarlo → 503)", async () => {
  const { dbConnect, isConnected } = await import("../src/config/mongo");
  await mongoose.disconnect();
  assert.equal(await dbConnect({ exitOnFail: false }), true);
  assert.equal(isConnected(), true);

  // Caso de producción: la promesa ya quedó resuelta y la conexión se cae (Vercel congela la instancia).
  await mongoose.disconnect();
  assert.equal(isConnected(), false);
  assert.equal(await dbConnect({ exitOnFail: false }), true);
  assert.equal(isConnected(), true);
  assert.equal(await mongoose.connection.db!.collection("accounts").countDocuments() > 0, true);
});
