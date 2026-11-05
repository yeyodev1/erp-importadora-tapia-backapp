import { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { ArMovement } from "../models/arMovement.model";
import { ImportBatch } from "../models/importBatch.model";
import { InventoryMovement } from "../models/inventoryMovement.model";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import { SalesInvoice } from "../models/salesInvoice.model";
import { StockBalance } from "../models/stockBalance.model";
import { parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import { applyMovement } from "./inventoryCore.service";
import { findUsages, partyChecks, productChecks, receivableChecks, stockAfterChecks } from "./migrationUsage.service";
import { oid, requireText, todayEc } from "./salesCommon.service";

/**
 * "Quitar datos importados": deja la base como antes de la importación.
 * Reversa el asiento (reverseEntry), saca el stock que entró, borra los
 * saldos iniciales y las fichas que creó, y devuelve a su estado las fichas
 * que ya existían. Si algo de lo importado ya se usó, no toca nada.
 */
export async function listBatches() {
  return ImportBatch.find().select("-restores").sort({ createdAt: -1 }).limit(100).lean();
}

async function idsOf(batchId: Types.ObjectId, session: ClientSession) {
  const pick = async (model: any) => (await model.find({ importBatchId: batchId }).session(session).select("_id").lean()).map((d: any) => d._id);
  const [parties, products, invoices] = await Promise.all([pick(Party), pick(Product), pick(SalesInvoice)]);
  const movements = await InventoryMovement.find({ "source.docId": batchId, type: "INVENTARIO_INICIAL" }).session(session).lean<any[]>();
  return { parties, products, invoices, movements };
}

export async function undoBatch(id: string, body: { reason?: string }, actor: Actor) {
  const reason = requireText(body?.reason, "el motivo");
  const date = parseDay(todayEc());
  return runInTransaction(async (session) => {
    const batch = await ImportBatch.findById(oid(id, "importación")).session(session);
    if (!batch) throw new CustomError("Importación no encontrada", 404);
    if (batch.status === "quitado") throw new CustomError("Esa importación ya se quitó", 409);
    const ids = await idsOf(batch._id, session);
    const created = new Set(ids.products.map(String));
    const touched = [...new Set(ids.movements.map((m) => String(m.productId)))].filter((p) => !created.has(p)).map((p) => new Types.ObjectId(p));

    const usages = await findUsages(
      [
        ...partyChecks(ids.parties, { batchId: batch._id }),
        ...productChecks(ids.products, batch._id),
        ...receivableChecks(ids.invoices, batch._id),
        ...stockAfterChecks(touched, batch.createdAt, batch._id),
      ],
      session,
    );
    if (usages.length) throw new CustomError(`No se puede quitar ${batch.number}: después de importar se registró ${usages.join("; ")}. Anula esos documentos primero.`, 409);

    if (batch.journalEntryId) await accounting.reverseEntry(batch.journalEntryId, `Quitar importación ${batch.number}: ${reason}`, date, actor, session);

    // Stock de productos que ya existían: sale con el movimiento contrario (valor 0, como entró).
    const source = { module: "migracion", docType: "QUITAR_MIGRACION", docId: batch._id, docNumber: batch.number };
    const byWarehouse = new Map<string, any[]>();
    for (const m of ids.movements.filter((m) => !created.has(String(m.productId)))) {
      byWarehouse.set(String(m.warehouseId), [...(byWarehouse.get(String(m.warehouseId)) ?? []), { productId: m.productId, qty: m.qty, totalCost: m.totalCost }]);
    }
    for (const [warehouseId, lines] of byWarehouse) {
      await applyMovement({ warehouseId, date, type: "EGRESO_AJUSTE", source, lines }, actor, session);
    }
    // Productos creados por la importación: solo tienen su kardex de la importación, se van con él.
    await InventoryMovement.deleteMany({ productId: { $in: ids.products } }, { session });
    await StockBalance.deleteMany({ productId: { $in: ids.products } }, { session });

    await ArMovement.deleteMany({ invoiceId: { $in: ids.invoices } }, { session });
    await SalesInvoice.deleteMany({ importBatchId: batch._id }, { session });
    await Product.deleteMany({ importBatchId: batch._id }, { session });
    await Party.deleteMany({ importBatchId: batch._id }, { session });

    for (const r of batch.restores) {
      const model: any = r.model === "Product" ? Product : Party;
      const doc = await model.findById(r.id).session(session).lean();
      if (!doc) continue;
      const $set: Record<string, unknown> = {};
      for (const [path, value] of Object.entries(r.applied ?? {})) {
        const current = path.split(".").reduce((o: any, k) => o?.[k], doc);
        // Si alguien lo cambió después de importar, se respeta su cambio.
        if (current === value) $set[path] = (r.previous as any)?.[path] ?? null;
      }
      if (Object.keys($set).length) await model.updateOne({ _id: r.id }, { $set }, { session });
    }

    batch.status = "quitado";
    batch.undoneAt = new Date();
    batch.undoneBy = { userId: actor.userId as any, name: actor.name };
    batch.undoReason = reason;
    await batch.save({ session });
    const { restores: _r, ...out } = batch.toObject();
    return out;
  });
}
