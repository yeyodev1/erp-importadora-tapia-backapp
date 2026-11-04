import { Request, Response, NextFunction } from "express";
import type { makeCrud } from "../services/crud.service";

type Crud = ReturnType<typeof makeCrud>;

/** Handlers estándar para un catálogo: GET /, GET /:id, POST /, PUT /:id. */
export function crudHandlers(crud: Crud) {
  const wrap =
    (fn: (req: Request) => Promise<unknown>, status = 200) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(status).json(await fn(req));
      } catch (error) {
        next(error);
      }
    };

  return {
    list: wrap((req) => crud.list(req.query as Record<string, unknown>)),
    get: wrap((req) => crud.get(String(req.params.id))),
    create: wrap((req) => crud.create(req.body), 201),
    update: wrap((req) => crud.update(String(req.params.id), req.body)),
  };
}
