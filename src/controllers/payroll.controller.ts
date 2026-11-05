import { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../types/AuthRequest";
import { actorOf } from "../utils/actor";
import * as payrollService from "../services/payroll.service";

const wrap =
  (fn: (req: AuthRequest) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await fn(req as AuthRequest));
    } catch (error) {
      next(error);
    }
  };

const id = (req: Request) => String(req.params.id);

export const list = wrap((req) => payrollService.list(req.query as Record<string, unknown>));
export const get = wrap((req) => payrollService.get(id(req)));
export const generate = wrap((req) => payrollService.generate(req.body ?? {}, actorOf(req)), 201);
export const update = wrap((req) => payrollService.update(id(req), req.body ?? {}));
export const approve = wrap((req) => payrollService.approve(id(req), actorOf(req)));
export const voidPayroll = wrap((req) => payrollService.voidPayroll(id(req), req.body ?? {}, actorOf(req)));
