import type { UserRole } from './auth.js';

export type AccountStatus = 'active' | 'disabled';

export const STATUS_LABELS: Record<AccountStatus, string> = {
  active: 'Active',
  disabled: 'Disabled',
};

/** An account as shown on the Users page. Never contains password data. */
export interface ManagedUser {
  id: number;
  email: string;
  fullName: string;
  role: UserRole;
  status: AccountStatus;
  mustChangePassword: boolean;
  isLocked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /** Active teams this account is assigned to. */
  assignedTeams: number;
}

export interface UsersListResponse {
  users: ManagedUser[];
  total: number;
  page: number;
  pageSize: number;
  /** Active administrators overall (for the last-admin rule in the UI). */
  activeAdmins: number;
}

export interface CreateUserRequest {
  fullName: string;
  email: string;
  role: UserRole;
}

export interface UpdateUserRequest {
  fullName?: string;
  email?: string;
  role?: UserRole;
  status?: AccountStatus;
}

/** The temporary password appears in this response only, once. */
export interface TemporaryPasswordResponse {
  user: ManagedUser;
  temporaryPassword: string;
}

export const USER_ERRORS = {
  USER_CONFLICT: 'USER_CONFLICT',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  LAST_ADMIN: 'LAST_ADMIN',
  CANNOT_DISABLE_SELF: 'CANNOT_DISABLE_SELF',
  USE_CHANGE_PASSWORD: 'USE_CHANGE_PASSWORD',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
} as const;
