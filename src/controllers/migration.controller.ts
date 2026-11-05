import { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../types/AuthRequest";
import { actorOf } from "../utils/actor";
import * as macio from "../services/migrationMacio.service";
import { previewMacio } from "../services/migrationPreview.service";
import * as suppliers from "../services/migrationSuppliers.service";
import * as demo from "../services/migrationDemo.service";
import * as undo from "../services/migrationUndo.service";

const wrap =
  (fn: (req: AuthRequest) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await fn(req as AuthRequest));
    } catch (error) {
      next(error);
    }
  };

export const macioPreview = wrap((req) => previewMacio(req.body?.data));
export const macioApply = wrap((req) => macio.applyMacio(req.body?.data, actorOf(req)), 201);
export const suppliersPreview = wrap(() => suppliers.previewSuppliers());
export const suppliersApply = wrap((req) => suppliers.applySuppliers(actorOf(req)), 201);
export const demoPreview = wrap(() => demo.previewDemo());
export const demoApply = wrap(() => demo.applyDemo());
export const listBatches = wrap(() => undo.listBatches());
export const undoBatch = wrap((req) => undo.undoBatch(String(req.params.id), req.body ?? {}, actorOf(req)));
