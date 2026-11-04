import { Request, Response, NextFunction } from "express";
import * as settingsService from "../services/settings.service";
import * as catalogService from "../services/catalog.service";

const wrap =
  (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await fn(req));
    } catch (error) {
      next(error);
    }
  };

export const get = wrap(() => settingsService.get());
export const update = wrap((req) => settingsService.update(req.body));
export const lock = wrap((req) => settingsService.lockThrough(req.body?.period ?? null));
export const listUsers = wrap(() => settingsService.listUsers());
export const createUser = wrap((req) => settingsService.createUser(req.body), 201);
export const updateUser = wrap((req) => settingsService.updateUser(String(req.params.id), req.body));
export const partyByIdentification = wrap((req) =>
  catalogService.findPartyByIdentification(String(req.params.identification)),
);
