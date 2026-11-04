import { Request, Response, NextFunction } from "express";
import * as inventoryService from "../services/inventory.service";
import * as reportsService from "../services/inventoryReports.service";
import * as countService from "../services/inventoryCount.service";
import { actorOf } from "../utils/actor";
import type { AuthRequest } from "../types/AuthRequest";

const wrap =
  (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await fn(req));
    } catch (error) {
      next(error);
    }
  };

const query = (req: Request) => req.query as Record<string, unknown>;

export const listTransactions = wrap((req) => inventoryService.list(query(req)));
export const getTransaction = wrap((req) => inventoryService.get(String(req.params.id)));
export const createTransaction = wrap((req) => inventoryService.create(req.body, actorOf(req as AuthRequest)), 201);
export const voidTransaction = wrap((req) =>
  inventoryService.voidTransaction(String(req.params.id), req.body, actorOf(req as AuthRequest)),
);

export const kardex = wrap((req) => reportsService.kardex(query(req)));
export const balances = wrap((req) => reportsService.balances(query(req)));
export const negatives = wrap((req) => reportsService.negatives(query(req)));
export const belowMinimum = wrap((req) => reportsService.belowMinimum(query(req)));
export const transfers = wrap((req) => inventoryService.list({ ...query(req), type: "TRANSFERENCIA" }));

export const physicalCount = wrap((req) => countService.physicalCount(query(req)));
export const adjustFromCount = wrap((req) => countService.adjustFromCount(req.body, actorOf(req as AuthRequest)), 201);
