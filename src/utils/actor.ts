import { CustomError } from "../errors/customError.error";
import type { AuthRequest } from "../types/AuthRequest";
import type { Actor } from "../services/accounting.service";

/** El usuario del token como autor de la operación (va al asiento y al kardex). */
export function actorOf(req: AuthRequest): Actor {
  if (!req.user) throw new CustomError("No autorizado", 401);
  return { userId: req.user.userId, name: req.user.name || req.user.email };
}
