export const STAFF_ROLES = [
  "SUPER_ADMIN",
  "OPS",
  "FINANCE",
  "CONTENT",
  "SUPPORT",
  "REVIEWER",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = [
  "users:read",
  "users:suspend",
  "payments:read",
  "payments:refund",
  "payments:mark-paid",
  "plans:write",
  "content:write",
  "reviews:work",
  "ops:queues",
  "tickets:work",
  "broadcast:send",
  "impersonate",
  "staff:manage",
  "settings:write",
  "flags:write",
  "audit:read",
  "audit:export",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const rolePermissions: Record<StaffRole, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  OPS: [
    "users:read",
    "users:suspend",
    "impersonate",
    "reviews:work",
    "ops:queues",
    "tickets:work",
    "broadcast:send",
  ],
  FINANCE: [
    "users:read",
    "payments:read",
    "payments:refund",
    "payments:mark-paid",
    "plans:write",
  ],
  CONTENT: ["users:read", "content:write", "reviews:work"],
  SUPPORT: ["users:read", "impersonate", "payments:read", "tickets:work"],
  REVIEWER: ["reviews:work"],
};

export function permissionsFor(role: StaffRole): readonly Permission[] {
  return rolePermissions[role];
}

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}
