import 'dotenv/config'
import { z } from 'zod'

const optionalString = z.string().trim().optional().transform((value) => value || undefined)

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: optionalString,
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  AUTH_SECRET: optionalString,
  COOKIE_SECURE: z.string().optional().transform((value) => value === 'true'),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z.string().optional().transform((value) => value === 'true'),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: z.string().default('Vista <no-reply@example.com>'),
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_PRICE_PRO_MONTHLY: optionalString,
  STRIPE_PRICE_BUSINESS_MONTHLY: optionalString,
  OBJECT_STORAGE_ENDPOINT: optionalString,
  OBJECT_STORAGE_BUCKET: optionalString,
  OBJECT_STORAGE_ACCESS_KEY: optionalString,
  OBJECT_STORAGE_SECRET_KEY: optionalString,
  OBJECT_STORAGE_REGION: z.string().default('auto'),
})

const parsed = environmentSchema.safeParse(process.env)
if (!parsed.success) {
  throw new Error(`Invalid server configuration: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
}

export const config = {
  ...parsed.data,
  cookieSecure: parsed.data.COOKIE_SECURE || parsed.data.NODE_ENV === 'production',
  authEnabled: Boolean(parsed.data.DATABASE_URL && parsed.data.AUTH_SECRET && parsed.data.AUTH_SECRET.length >= 32),
  smtpEnabled: Boolean(parsed.data.SMTP_HOST && parsed.data.SMTP_USER && parsed.data.SMTP_PASSWORD),
  stripeEnabled: Boolean(parsed.data.STRIPE_SECRET_KEY && parsed.data.STRIPE_WEBHOOK_SECRET),
  objectStorageEnabled: Boolean(parsed.data.OBJECT_STORAGE_ENDPOINT && parsed.data.OBJECT_STORAGE_BUCKET &&
    parsed.data.OBJECT_STORAGE_ACCESS_KEY && parsed.data.OBJECT_STORAGE_SECRET_KEY),
}
