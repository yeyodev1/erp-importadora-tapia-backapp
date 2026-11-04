import { Request } from "express";
import type { Role } from "../models/user.model";

export interface JwtPayload {
  userId: string;
  email: string;
  name: string;
  role: Role;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}
