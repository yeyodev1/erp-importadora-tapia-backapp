import { Request, Response, NextFunction } from "express";
import * as transactions from "../services/bankTransactions.service";
import * as balances from "../services/bankBalances.service";
import * as reconciliation from "../services/bankReconciliation.service";
import * as statement from "../services/bankStatement.service";
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
const id = (req: Request) => String(req.params.id);
const actor = (req: Request) => actorOf(req as AuthRequest);

export const listTransactions = wrap((req) => transactions.listTransactions(query(req)));
export const getTransaction = wrap((req) => transactions.getTransaction(id(req)));
export const createTransaction = wrap((req) => transactions.createTransaction(req.body, actor(req)), 201);
export const voidTransaction = wrap((req) => transactions.voidTransaction(id(req), req.body, actor(req)));

export const cashAndBankBalances = wrap((req) => balances.cashAndBankBalances(query(req).date));
export const balanceOf = wrap((req) => balances.balanceOf(id(req), query(req).date));
export const bankBook = wrap((req) => balances.bankBook(id(req), query(req)));
export const pendingChecks = wrap((req) => balances.pendingChecks(query(req)));

export const listReconciliations = wrap((req) => reconciliation.listReconciliations(query(req)));
export const createReconciliation = wrap((req) => reconciliation.createReconciliation(req.body, actor(req)), 201);
export const getReconciliation = wrap((req) => reconciliation.getReconciliation(id(req)));
export const updateReconciliation = wrap((req) => reconciliation.updateReconciliation(id(req), req.body));
export const loadMovements = wrap((req) => reconciliation.loadMovements(id(req)));
export const closeReconciliation = wrap((req) => reconciliation.closeReconciliation(id(req), req.body, actor(req)));
export const reopenReconciliation = wrap((req) => reconciliation.reopenReconciliation(id(req), req.body, actor(req)));
export const reconciliationReport = wrap((req) => reconciliation.reconciliationReport(id(req)));

export const matchStatement = wrap((req) => statement.matchStatement(id(req), req.body));
export const confirmMatches = wrap((req) => statement.confirmMatches(id(req), req.body));
export const noteFromLine = wrap((req) => statement.noteFromLine(id(req), req.body, actor(req)), 201);
