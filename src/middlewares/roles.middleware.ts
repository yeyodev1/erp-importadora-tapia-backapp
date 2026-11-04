import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import type { Role } from "../models/user.model";

/**
 * Deja pasar solo a los roles indicados. Gerencia (admin) pasa siempre.
 * El auditor pasa en lecturas (GET) de cualquier módulo y nunca escribe.
 * Va siempre después de authMiddleware.
 */
export function requireRoles(...roles: Role[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    const isRead = req.method === "GET";
    if (role === "admin" || (role && roles.includes(role)) || (role === "auditor" && isRead)) {
      if (role === "auditor" && !isRead) {
        res.status(403).json({ message: "El rol auditor es de solo lectura" });
        return;
      }
      next();
      return;
    }
    res.status(403).json({ message: "No tienes permiso para esta sección" });
  };
}

/** Solo gerencia. */
export const adminOnly = requireRoles();
