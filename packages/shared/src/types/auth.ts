import { ServerRole } from './models';

export interface UserPayload {
  id: string;
  username: string;
  displayName: string;
  serverRole: ServerRole;
  avatarUrl?: string | null;
}

export interface RegisterDto {
  username: string;
  password: string;
  displayName: string;
  serverRole?: ServerRole; // Optional: allows first setup or admin creation
}

export interface LoginDto {
  username: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: UserPayload;
}
