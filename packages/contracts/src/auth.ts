import { z } from 'zod';
import { objectIdSchema } from './primitives.js';

/** Emails are trimmed and lower-cased before validation and storage. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }));

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Length is counted in Unicode code points, so passphrases in any script are measured fairly. */
export const passwordSchema = z
  .string()
  .refine((value) => [...value].length >= PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((value) => [...value].length <= PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

export const personNameSchema = z.string().trim().min(1, 'Enter your name').max(100);
export const businessNameSchema = z.string().trim().min(2, 'Enter the business name').max(120);

/** A 6-digit authenticator code or a recovery code (xxxxx-xxxxx). */
export const mfaCodeSchema = z
  .string()
  .trim()
  .regex(/^(\d{6}|[a-z0-9]{5}-[a-z0-9]{5})$/i, 'Enter the 6-digit code or a recovery code');

/** Opaque single-use tokens (invitations, password resets): base64url, 43 characters. */
export const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This link is not valid');

export const signupRequestSchema = z.strictObject({
  name: personNameSchema,
  email: emailSchema,
  password: passwordSchema,
  businessName: businessNameSchema,
});

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  // Not validated against the policy on login: older passwords may predate it.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH * 4),
});

export const mfaVerifyRequestSchema = z.strictObject({ code: mfaCodeSchema });

export const totpConfirmRequestSchema = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export const passwordChangeRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH * 4),
  newPassword: passwordSchema,
});

export const passwordForgotRequestSchema = z.strictObject({ email: emailSchema });

export const passwordResetRequestSchema = z.strictObject({ token: opaqueTokenSchema, newPassword: passwordSchema });

export const invitationInspectRequestSchema = z.strictObject({ token: opaqueTokenSchema });

export const invitationAcceptRequestSchema = z.strictObject({
  token: opaqueTokenSchema,
  /** Required only when no account exists for the invited email. */
  name: personNameSchema.optional(),
  password: passwordSchema.optional(),
});

export const themePreferenceSchema = z.enum(['system', 'light', 'dark']);

export const preferencesRequestSchema = z.strictObject({ theme: themePreferenceSchema.optional() });

export const activeTenantRequestSchema = z.strictObject({ tenantId: objectIdSchema });

export const sessionUserSchema = z.strictObject({
  id: objectIdSchema,
  name: z.string(),
  email: z.string(),
  mfaEnabled: z.boolean(),
  preferences: z.strictObject({ theme: themePreferenceSchema }),
});

export const tenantSummarySchema = z.strictObject({ id: objectIdSchema, name: z.string() });

/**
 * GET /auth/session and the result of every sign-in step.
 * The CSRF token must be sent back as `X-CSRF-Token` on POST/PUT/PATCH/DELETE.
 */
export const sessionResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('anonymous'), csrfToken: z.string() }),
  z.strictObject({ status: z.literal('mfa_required'), csrfToken: z.string() }),
  z.strictObject({
    status: z.literal('authenticated'),
    csrfToken: z.string(),
    user: sessionUserSchema,
    tenants: z.array(tenantSummarySchema),
    activeTenantId: objectIdSchema.nullable(),
  }),
]);

export const totpSetupResponseSchema = z.strictObject({
  /** Base32 secret for manual entry. */
  secret: z.string(),
  otpauthUri: z.string(),
});

/** Returned once when MFA is turned on; the session token rotates at the same time. */
export const mfaEnabledResponseSchema = z.strictObject({ recoveryCodes: z.array(z.string()), session: sessionResponseSchema });

export const invitationInspectResponseSchema = z.strictObject({
  tenantName: z.string(),
  email: z.string(),
  accountExists: z.boolean(),
});

export const ownSessionSchema = z.strictObject({
  id: objectIdSchema,
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  userAgent: z.string(),
  current: z.boolean(),
});

export type SignupRequest = z.infer<typeof signupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type TenantSummary = z.infer<typeof tenantSummarySchema>;
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type MfaEnabledResponse = z.infer<typeof mfaEnabledResponseSchema>;
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;
export type InvitationInspectResponse = z.infer<typeof invitationInspectResponseSchema>;
export type OwnSession = z.infer<typeof ownSessionSchema>;
