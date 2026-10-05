import { createTransport, type Transporter } from 'nodemailer'
import { config } from './config'

let transport: Transporter | undefined

function getTransport(): Transporter {
  if (!config.smtpEnabled) throw new Error('Email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASSWORD to enable verification and password recovery.')
  transport ??= createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
  })
  return transport
}

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  await getTransport().sendMail({ from: config.SMTP_FROM, to, subject, text })
}

export async function sendVerification(to: string, name: string, token: string): Promise<void> {
  const url = new URL('/verify-email', config.APP_ORIGIN)
  url.searchParams.set('token', token)
  await sendEmail(to, 'Confirme seu e-mail do Vista', `Olá ${name},\n\nConfirme seu e-mail neste link (válido por 24 horas):\n${url}\n`)
}

export async function sendPasswordRecovery(to: string, token: string): Promise<void> {
  const url = new URL('/reset-password', config.APP_ORIGIN)
  url.searchParams.set('token', token)
  await sendEmail(to, 'Recuperação de acesso ao Vista', `Use este link para criar uma nova senha. Ele expira em uma hora:\n${url}\nSe você não solicitou isso, ignore esta mensagem.`)
}

export async function sendInvitation(to: string, organizationName: string, token: string): Promise<void> {
  const url = new URL('/invite', config.APP_ORIGIN)
  url.searchParams.set('token', token)
  await sendEmail(to, `Convite para ${organizationName} no Vista`, `Você foi convidado para participar de ${organizationName} no Vista.\nAceite o convite (válido por 7 dias):\n${url}\n`)
}
