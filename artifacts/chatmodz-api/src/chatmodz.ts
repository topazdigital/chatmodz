import { Router, type NextFunction, type Request, type Response } from "express"
import { createPool, type Pool, type PoolConnection } from "mysql2/promise"
import crypto from "node:crypto"
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"
import webpush from "web-push"

const router = Router()
const LOCK_MINUTES = 10
const MIN_REPLY_CHARS = 75
const MAX_OPERATOR_NOTES = 5000
const MIN_TYPING_TEST_SECONDS = 60
const MIN_TYPING_WPM = 40
const MIN_TYPING_ACCURACY = 90
const MIN_QUIZ_SCORE = 80
const POLICY_VERSION = "2026-10-05"
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000
const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024
const MAX_PROFILE_GALLERY_ITEMS = 8
const MAX_PROFILE_TEXT_LENGTH = 1000

type ProfileDetails = {
  location?: string
  bio?: string
  age?: number
  gallery?: string[]
  details?: Record<string, string>
}

type Operator = {
  id: number
  public_id: string
  full_name: string
  email: string
  role: "operator" | "recruiter" | "admin"
  status: string
  assessment_status?: string | null
  recruiter_id?: number | null
  recruiter_name?: string | null
}

class AdminActionError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

declare global {
  namespace Express {
    interface Request {
      chatmodzOperator?: Operator
    }
  }
}

let pool: Pool | null = null
const lastActiveTouch = new Map<number, number>()
const LAST_ACTIVE_TOUCH_INTERVAL_MS = 60_000
const demoApplications: any[] = []
const demoConversationNotes = new Map<number, { text: string; updatedAt: string | null; updatedByName: string | null }>()
const demoAssessmentAttempts = new Map<number, any[]>()
const demoSafetyEscalations: any[] = []
const demoLevels = [
  { id: 1, name: "Beginner", slug: "beginner", description: "New operators building consistency and learning the workflow.", rate_minor: 5, currency: "EUR", is_default: true, active: true, assigned_operators: 1 },
  { id: 2, name: "Developing", slug: "developing", description: "Operators who meet quality and reliability expectations.", rate_minor: 10, currency: "EUR", is_default: false, active: true, assigned_operators: 0 },
  { id: 3, name: "Experienced", slug: "experienced", description: "Trusted operators with a strong history of quality replies.", rate_minor: 15, currency: "EUR", is_default: false, active: true, assigned_operators: 0 },
]
const demoEarnings: any[] = []
const demoOperatorLevels = new Map<number, number>([[2, 1]])
const demoAccounts = new Map<number, Operator>()
const demoRecruiterOperators: any[] = [
  { id: 2, public_id: "demo-operator", full_name: "Demo Operator", email: "operator@chatmodz.test", role: "operator", status: "active", recruiter_id: 3, recruiter_name: "Demo Recruiter", last_active_at: new Date().toISOString(), created_at: new Date().toISOString(), activity_count: 12, replies: 8 },
]
const demoRecruiterActivity: any[] = [
  { id: 1, operator_id: 2, operator_name: "Demo Operator", recruiter_id: 3, recruiter_name: "Demo Recruiter", activity_type: "reply", conversation_id: null, site_name: "Anonymized queue", created_at: new Date().toISOString(), metadata_json: null },
  { id: 2, operator_id: 3, operator_name: "Demo Recruiter", recruiter_id: null, recruiter_name: null, activity_type: "login", conversation_id: null, site_name: null, created_at: new Date(Date.now() - 3600000).toISOString(), metadata_json: null },
]

function database() {
  const url = process.env.CHATMODZ_DATABASE_URL
  if (!url) throw new Error("Chatmodz is not configured: CHATMODZ_DATABASE_URL is required")
  if (!pool) pool = createPool({ uri: url, waitForConnections: true, connectionLimit: 10, charset: "utf8mb4" })
  return pool
}

function isDemoMode() {
  return process.env.CHATMODZ_DEMO_MODE === "true" && process.env.NODE_ENV !== "production"
}

function demoOperator(role: "admin" | "recruiter" | "operator" = "admin"): Operator {
  const isAdmin = role === "admin"
  const isRecruiter = role === "recruiter"
  return {
    id: isAdmin ? 1 : isRecruiter ? 3 : 2,
    public_id: isAdmin ? "demo-admin" : isRecruiter ? "demo-recruiter" : "demo-operator",
    full_name: isAdmin ? String(process.env.CHATMODZ_ADMIN_NAME || "Patrick Ndungu") : isRecruiter ? "Demo Recruiter" : "Demo Operator",
    email: isAdmin
      ? String(process.env.CHATMODZ_ADMIN_EMAIL || "").trim().toLowerCase()
      : isRecruiter
        ? String(process.env.CHATMODZ_DEMO_RECRUITER_EMAIL || "recruiter@chatmodz.test").trim().toLowerCase()
        : String(process.env.CHATMODZ_DEMO_OPERATOR_EMAIL || "operator@chatmodz.test").trim().toLowerCase(),
    role,
    status: role === "operator" ? "training" : "active",
    assessment_status: null,
    recruiter_id: role === "operator" ? 3 : null,
    recruiter_name: role === "operator" ? "Demo Recruiter" : null,
  }
}

function getDemoAccounts() {
  if (!demoAccounts.size) {
    for (const role of ["admin", "recruiter", "operator"] as const) {
      const operator = demoOperator(role)
      demoAccounts.set(operator.id, operator)
    }
  }
  return [...demoAccounts.values()]
}

function findDemoAccount(identifier: string) {
  return getDemoAccounts().find((operator) => operator.email === identifier)
}

function timingSafeEqualText(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function ensureBootstrapAdmin() {
  const email = String(process.env.CHATMODZ_ADMIN_EMAIL || "").trim().toLowerCase()
  const password = String(process.env.CHATMODZ_ADMIN_PASSWORD || "")
  if (!email || !password) return
  if (!email.includes("@") || password.length < 10) throw new Error("CHATMODZ_ADMIN_EMAIL must be valid and CHATMODZ_ADMIN_PASSWORD must be at least 10 characters")
  const name = String(process.env.CHATMODZ_ADMIN_NAME || "Chatmodz Administrator").trim() || "Chatmodz Administrator"
  const passwordHash = await bcrypt.hash(password, 12)
  const existing = await query<any>("SELECT id FROM operators WHERE email = ? LIMIT 1", [email])
  if (existing[0]) {
    await query("UPDATE operators SET full_name = ?, password_hash = ?, role = 'admin', status = 'active' WHERE id = ?", [name, passwordHash, existing[0].id])
    console.log("Chatmodz bootstrap administrator updated")
    return
  }
  await query(
    "INSERT INTO operators (public_id, full_name, email, password_hash, role, status) VALUES (?, ?, ?, ?, 'admin', 'active')",
    [crypto.randomBytes(13).toString("base64url"), name, email, passwordHash],
  )
  console.log("Chatmodz bootstrap administrator created")
}

async function ensurePerformanceIndexes() {
  const indexes = [
    ["messages", "messages_conversation_latest_idx", "conversation_id, sender_type, sent_at, id"],
    ["messages", "messages_operator_sent_idx", "sent_by_operator_id, sent_at"],
    ["integration_deliveries", "deliveries_site_status_idx", "site_id, status"],
    ["integration_deliveries", "deliveries_conversation_status_idx", "conversation_id, status"],
  ] as const
  for (const [tableName, indexName, columns] of indexes) {
    try {
      const existing = await query<any>(
        "SELECT 1 AS present FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1",
        [tableName, indexName],
      )
      if (!existing.length) {
        await query(`ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` (${columns})`)
        console.log(`[Chatmodz] Added performance index ${indexName}`)
      }
    } catch (error) {
      console.error(`[Chatmodz] Could not ensure performance index ${indexName}:`, error instanceof Error ? error.message : error)
    }
  }
}

async function ensureConversationColumns() {
  const columns: Array<[string, string]> = [
    ["operator_notes", "TEXT NULL"],
    ["operator_notes_updated_at", "TIMESTAMP NULL"],
    ["operator_notes_updated_by", "BIGINT UNSIGNED NULL"],
    ["member_profile_json", "JSON NULL"],
    ["managed_profile_profile_json", "JSON NULL"],
  ]
  for (const [columnName, definition] of columns) {
    try {
      const existing = await query<any>(
        "SELECT 1 AS present FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'conversations' AND column_name = ? LIMIT 1",
        [columnName],
      )
      if (!existing.length) {
        await query(`ALTER TABLE conversations ADD COLUMN \`${columnName}\` ${definition}`)
        console.log(`[Chatmodz] Added conversation column ${columnName}`)
      }
    } catch (error) {
      console.error(`[Chatmodz] Could not ensure conversation column ${columnName}:`, error instanceof Error ? error.message : error)
    }
  }
}

async function ensureAssessmentTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS operator_assessments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      operator_id BIGINT UNSIGNED NOT NULL,
      status ENUM('in_progress', 'submitted', 'approved', 'rejected') NOT NULL DEFAULT 'in_progress',
      passage_id TINYINT UNSIGNED NOT NULL,
      typed_text MEDIUMTEXT NULL,
      typing_wpm DECIMAL(6,2) NULL,
      typing_accuracy DECIMAL(5,2) NULL,
      quiz_answers_json JSON NULL,
      quiz_score DECIMAL(5,2) NULL,
      practice_responses_json JSON NULL,
      policy_version VARCHAR(32) NULL,
      rules_acknowledged_at TIMESTAMP NULL,
      auto_passed BOOLEAN NOT NULL DEFAULT FALSE,
      reviewer_note VARCHAR(1000) NULL,
      started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      submitted_at TIMESTAMP NULL,
      reviewed_by BIGINT UNSIGNED NULL,
      reviewed_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY assessments_operator_latest_idx (operator_id, id),
      KEY assessments_review_idx (status, auto_passed, submitted_at),
      CONSTRAINT assessments_operator_fk FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE CASCADE,
      CONSTRAINT assessments_reviewer_fk FOREIGN KEY (reviewed_by) REFERENCES operators (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await query("ALTER TABLE operator_assessments MODIFY started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)")
  await query(`
    CREATE TABLE IF NOT EXISTS operator_safety_escalations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      conversation_id BIGINT UNSIGNED NOT NULL,
      operator_id BIGINT UNSIGNED NOT NULL,
      category ENUM('underage', 'illegal_activity', 'suicidal_intent_with_means', 'persistent_racism') NOT NULL,
      details VARCHAR(1000) NULL,
      status ENUM('open', 'reviewed', 'resolved') NOT NULL DEFAULT 'open',
      reviewed_by BIGINT UNSIGNED NULL,
      reviewed_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY safety_escalations_status_created_idx (status, created_at),
      KEY safety_escalations_operator_idx (operator_id, created_at),
      CONSTRAINT safety_escalations_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
      CONSTRAINT safety_escalations_operator_fk FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE CASCADE,
      CONSTRAINT safety_escalations_reviewer_fk FOREIGN KEY (reviewed_by) REFERENCES operators (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

export async function initializeChatmodz() {
  if (isDemoMode()) {
    console.log("Chatmodz development demo mode enabled; MySQL persistence is disabled")
    return
  }
  try {
    if (process.env.CHATMODZ_ADMIN_EMAIL && process.env.CHATMODZ_ADMIN_PASSWORD) {
      await ensureBootstrapAdmin()
    }
    await ensureAssessmentTables()
    await ensureConversationColumns()
    void ensurePerformanceIndexes()
  } catch (error) {
    console.error("Chatmodz startup initialization failed:", error instanceof Error ? error.message : error)
  }
}

function profileDetails(value: unknown, siteBaseUrl?: unknown): ProfileDetails | undefined {
  let candidate = value
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return undefined
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined
  const record = candidate as Record<string, unknown>
  const result: ProfileDetails = {}
  if (typeof record.location === "string" && record.location.trim()) result.location = record.location.trim().slice(0, MAX_PROFILE_TEXT_LENGTH)
  if (typeof record.bio === "string" && record.bio.trim()) result.bio = record.bio.trim().slice(0, MAX_PROFILE_TEXT_LENGTH)
  const age = Number(record.age)
  if (Number.isInteger(age) && age > 0 && age < 130) result.age = age
  if (Array.isArray(record.gallery)) {
    const gallery = record.gallery
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 500))
      .map((item) => typeof siteBaseUrl === "string" && siteBaseUrl.trim()
        ? profilePhotoPath(item, siteBaseUrl)
        : item)
      .filter(Boolean)
      .slice(0, MAX_PROFILE_GALLERY_ITEMS)
    if (gallery.length) result.gallery = gallery
  }
  if (record.details && typeof record.details === "object" && !Array.isArray(record.details)) {
    const details = Object.entries(record.details as Record<string, unknown>).reduce<Record<string, string>>((accumulator, [key, item]) => {
      if (typeof item === "string" && item.trim()) accumulator[key.slice(0, 80)] = item.trim().slice(0, 180)
      return accumulator
    }, {})
    if (Object.keys(details).length) result.details = details
  }
  return Object.keys(result).length ? result : undefined
}

function profileFromPayload(payload: Record<string, any>, prefix: "member" | "managedProfile") {
  const candidate = payload[`${prefix}Profile`]
  const fallback = {
    location: payload[`${prefix}Location`],
    bio: payload[`${prefix}Bio`],
    age: payload[`${prefix}Age`],
    gallery: payload[`${prefix}Gallery`],
    details: payload[`${prefix}Details`],
  }
  return profileDetails(candidate || fallback)
}

async function query<T = any>(sql: string, values: unknown[] = []): Promise<T[]> {
  const [rows] = await database().execute(sql, values as any[])
  return rows as T[]
}

function failConfiguration(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("CHATMODZ_DATABASE_URL")) {
    res.status(503).json({ error: "Chatmodz database is not configured" })
    return true
  }
  return false
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function timingSafeEqualHex(left: string, right: string) {
  const a = Buffer.from(left, "hex")
  const b = Buffer.from(right, "hex")
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function jwtSecret() {
  if (process.env.CHATMODZ_JWT_SECRET) return process.env.CHATMODZ_JWT_SECRET
  if (process.env.NODE_ENV === "production") throw new Error("CHATMODZ_JWT_SECRET is required in production")
  return "chatmodz-development-secret-change-me"
}

function tokenFor(operator: Operator) {
  return jwt.sign({ operatorId: operator.id, role: operator.role }, jwtSecret(), { expiresIn: "12h", issuer: "chatmodz" })
}

function publicOperator(operator: Operator) {
  const latestDemoAssessment = isDemoMode()
    ? [...(demoAssessmentAttempts.get(operator.id) || [])].sort((a, b) => b.id - a.id)[0]
    : null
  return {
    id: operator.id,
    name: operator.full_name,
    email: operator.email,
    admin: operator.role === "admin" ? 2 : 1,
    role: operator.role,
    status: operator.status,
    assessmentStatus: latestDemoAssessment?.status || operator.assessment_status || "not_started",
  }
}

const typingPassages = [
  "A thoughtful reply shows that you have read the whole message, answered the question, and made room for the other person to respond. Keep every conversation respectful, original, and on the platform. Never promise a meeting or move contact elsewhere. When something feels unsafe, stop and report it through the correct channel rather than trying to handle it alone.",
  "Good operators communicate with care and consistency. Read the message before replying, use your own words, answer what was asked, and ask one useful question to continue the online conversation. Protect personal information, avoid promises about meeting in real life, and follow the safety rules even when a conversation becomes uncomfortable.",
  "Every conversation should stay respectful, original, and within the platform. Do not share phone numbers, email addresses, or social media accounts. Do not suggest a real-life meeting or begin explicit conversation. If a message raises an underage, illegal, self-harm, or persistent-hate concern, stop and use the safety escalation process.",
]

const assessmentPolicies = [
  { title: "Write original replies", detail: "Write a distinct, relevant response for each conversation. Reusing the same reply or pasting identical text across chats is prohibited." },
  { title: "Minimum reply length", detail: "Every live reply must contain at least 75 characters before it can be sent." },
  { title: "Answer and continue", detail: "Answer the member’s questions and ask a relevant new question to keep the online conversation moving." },
  { title: "Reply within 25 minutes", detail: "Respond within 25 minutes of the member’s latest message. Late replies are recorded for review." },
  { title: "Keep contact on-platform", detail: "Never share or request phone numbers, email addresses, social accounts, or another way to contact each other." },
  { title: "Do not arrange real-life meetings", detail: "Do not agree to, arrange, or hint at meeting in person. Kindly redirect the conversation to online chat." },
  { title: "Do not say “I love you”", detail: "Never tell a member “I love you” or use that phrase in a reply." },
  { title: "Do not initiate sexual conversation", detail: "Do not start explicit conversation or sexting. Follow the platform’s content policy if a member initiates." },
  { title: "Do not discuss illegal activity", detail: "Do not engage in illegal activity or any sexual content involving minors. Stop and report safety concerns." },
  { title: "Use Panic Room only for severe safety issues", detail: "Escalate suspected underage users, illegal acts, suicidal intent with means, or persistent racism/hate. Do not use it for routine disagreements or ordinary service issues." },
  { title: "Protect privacy and safety", detail: "Do not reveal private member information, copy conversation details outside the platform, or investigate a safety report yourself." },
]

const assessmentQuiz = [
  { id: "contact", prompt: "A member asks for your personal phone number. What do you do?", options: [{ id: "a", text: "Share it if the member seems trustworthy." }, { id: "b", text: "Decline and keep the conversation on this platform." }, { id: "c", text: "Send a social account instead." }], answer: "b" },
  { id: "meeting", prompt: "A member suggests meeting in person. What do you do?", options: [{ id: "a", text: "Agree to a meeting later." }, { id: "b", text: "Hint that you might meet if the chat goes well." }, { id: "c", text: "Do not arrange or imply a meeting; redirect to online chat." }], answer: "c" },
  { id: "affection", prompt: "Which statement is prohibited?", options: [{ id: "a", text: "A warm, personal response." }, { id: "b", text: "The exact phrase “I love you.”" }, { id: "c", text: "A relevant question about the member’s day." }], answer: "b" },
  { id: "explicit", prompt: "What is the rule for explicit conversation?", options: [{ id: "a", text: "Never initiate it; follow applicable platform policy if the member starts it." }, { id: "b", text: "Initiate it to keep the member engaged." }, { id: "c", text: "Move the conversation to another app." }], answer: "a" },
  { id: "safety", prompt: "A message indicates a minor, illegal acts, suicidal intent with means, or persistent racism. What do you do?", options: [{ id: "a", text: "Use Panic Room, stop the unsafe exchange, and follow escalation guidance." }, { id: "b", text: "Continue chatting and see if the issue resolves." }, { id: "c", text: "Use Panic Room for any disagreement." }], answer: "a", critical: true },
]

const practiceScenarios = [
  { id: "contact", memberMessage: "I like talking with you. Can I have your WhatsApp or phone number so we can chat somewhere else?", guidance: "Decline external contact and keep the conversation on this platform." },
  { id: "meeting", memberMessage: "We seem to get along. Would you meet me for coffee this weekend?", guidance: "Do not agree or hint at a meeting; kindly redirect to continuing the online conversation." },
  { id: "safety", memberMessage: "I’m under 18 and someone here asked me to keep this secret.", guidance: "Stop the exchange and escalate the suspected underage safety issue. Do not investigate." },
]

function calculateTypingResult(passage: string, typedText: string, elapsedSeconds: number) {
  const typed = Array.from(typedText)
  const expected = Array.from(passage)
  const exact = typed.reduce((count, character, index) => count + (character === expected[index] ? 1 : 0), 0)
  const accuracy = Math.round((exact / Math.max(1, typed.length)) * 100)
  const wpm = Math.round((exact / 5 / Math.max(1, elapsedSeconds)) * 60)
  return { wpm, accuracy }
}

function latestDemoAssessment(operatorId: number) {
  return [...(demoAssessmentAttempts.get(operatorId) || [])].sort((a, b) => b.id - a.id)[0] || null
}

async function latestAssessment(operatorId: number) {
  const rows = await query<any>(
    "SELECT id, status, auto_passed FROM operator_assessments WHERE operator_id = ? ORDER BY id DESC LIMIT 1",
    [operatorId],
  )
  return rows[0] || null
}

async function latestAssessmentDetails(operatorId: number) {
  const rows = await query<any>(
    "SELECT * FROM operator_assessments WHERE operator_id = ? ORDER BY id DESC LIMIT 1",
    [operatorId],
  )
  return rows[0] || null
}

function publicKey(value: number) {
  return `c_${value}`
}

function internalId(value: string) {
  const match = /^c_(\d+)$/.exec(value)
  return match ? Number(match[1]) : 0
}

function meaningfulChars(value: string) {
  return Array.from(value).filter((character) => !/\s/u.test(character)).length
}

function repliesAreNearDuplicates(left: string, right: string) {
  const tokenize = (value: string) => new Set(value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/u).filter((word) => word.length > 2))
  const leftWords = tokenize(left)
  const rightWords = tokenize(right)
  if (leftWords.size < 8 || rightWords.size < 8) return false
  let overlap = 0
  for (const word of leftWords) if (rightWords.has(word)) overlap += 1
  return overlap / new Set([...leftWords, ...rightWords]).size >= 0.9
}

function rateToMinor(value: unknown) {
  const normalized = String(value ?? "").trim().replace(",", ".")
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
  const [whole, fraction = ""] = normalized.split(".")
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  return Number.isSafeInteger(minor) && minor >= 0 && minor <= 2147483647 ? minor : null
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120)
}

function compensationLevel(row: any) {
  return {
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    description: row.description || "",
    rateMinor: Number(row.rate_minor || 0),
    currency: String(row.currency || "EUR").toUpperCase(),
    isDefault: Boolean(row.is_default),
    active: Boolean(row.active),
    assignedOperators: Number(row.assigned_operators || 0),
  }
}

function compensationOperator(row: any) {
  return {
    id: Number(row.id),
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    status: row.status,
    levelId: row.level_id ? Number(row.level_id) : null,
    levelName: row.level_name || null,
    rateMinor: row.rate_minor === null || row.rate_minor === undefined ? null : Number(row.rate_minor),
    currency: row.level_currency || null,
    earnedMinor: Number(row.earned_minor || 0),
    earnedMessages: Number(row.earned_messages || 0),
  }
}

function payoutSchedule() {
  const now = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10))
  if (now.getUTCDate() >= 10) next.setUTCMonth(next.getUTCMonth() + 1)
  return {
    day: 10,
    label: "Paid monthly on the 10th",
    nextDate: next.toISOString().slice(0, 10),
  }
}

function secretFor(site: any) {
  const envKey = typeof site.secret_env_key === "string" ? site.secret_env_key : ""
  return envKey ? process.env[envKey] || "" : ""
}

function resolveOperatorMediaUrl(value: unknown, siteBaseUrl?: unknown) {
  const path = typeof value === "string" ? value.trim() : ""
  if (!path) return ""
  if (path.startsWith("/api/chatmodz/")) return path
  const candidate = path.startsWith("//") ? `https:${path}` : path
  try {
    const siteBase = typeof siteBaseUrl === "string" ? new URL(siteBaseUrl) : null
    const url = new URL(candidate, siteBase ? `${siteBase.origin}/` : undefined)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : ""
  } catch {
    return ""
  }
}

function operatorMediaPath(value: unknown, siteBaseUrl?: unknown) {
  return resolveOperatorMediaUrl(value, siteBaseUrl)
}

function isRichDatingHost(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === "richdatingnetwork.com" || hostname.endsWith(".richdatingnetwork.com")
  } catch {
    return false
  }
}

function normalizeRichProfilePhoto(value: unknown, siteBaseUrl?: unknown) {
  let photo = typeof value === "string" ? value.trim() : ""
  if (!photo || !isRichDatingHost(siteBaseUrl)) return photo

  try {
    const parsed = new URL(photo.startsWith("//") ? `https:${photo}` : photo)
    if (parsed.hostname.toLowerCase() === "richdatingnetwork.com" || parsed.hostname.toLowerCase().endsWith(".richdatingnetwork.com")) {
      photo = `${parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    // Database values are often stored as a relative path or bare filename.
  }

  if (photo.startsWith("/api/uploads/")) return photo
  const uploadPrefixes = [
    "/assets/sources/uploads/",
    "assets/sources/uploads/",
    "/uploads/",
    "uploads/",
    "/photos/",
    "photos/",
  ]
  for (const prefix of uploadPrefixes) {
    if (photo.startsWith(prefix)) return `/api/uploads/${photo.slice(prefix.length)}`
  }
  if (photo.startsWith("/")) return photo
  return `/api/uploads/${photo}`
}

function profilePhotoPath(value: unknown, siteBaseUrl?: unknown) {
  const resolved = resolveOperatorMediaUrl(normalizeRichProfilePhoto(value, siteBaseUrl), siteBaseUrl)
  if (!resolved || resolved.startsWith("/api/chatmodz/")) return resolved
  try {
    const url = new URL(resolved)
    let connectedSiteHost = false
    if (typeof siteBaseUrl === "string" && siteBaseUrl.trim()) {
      try {
        connectedSiteHost = hostnameMatchesAllowedHost(url.hostname, new URL(siteBaseUrl).hostname)
      } catch {
        connectedSiteHost = false
      }
    }
    const connectedRichDatingHost = isRichDatingHost(siteBaseUrl) && isRichDatingHost(url.toString())
    return url.protocol === "http:" || connectedSiteHost || connectedRichDatingHost
      ? `/api/chatmodz/profile-photo?url=${encodeURIComponent(url.toString())}`
      : resolved
  } catch {
    return ""
  }
}

function hostnameMatchesAllowedHost(hostname: string, allowedHostname: string) {
  return hostname === allowedHostname || hostname.endsWith(`.${allowedHostname}`)
}

async function allowedPhotoHost(hostname: string) {
  const sites = await query<any>("SELECT endpoint_base_url FROM sites WHERE status = 'active' AND endpoint_base_url IS NOT NULL")
  return sites.some((site) => {
    try {
      const endpoint = String(site.endpoint_base_url)
      return hostnameMatchesAllowedHost(hostname, new URL(endpoint).hostname)
        || (isRichDatingHost(endpoint) && isRichDatingHost(`https://${hostname}`))
    } catch {
      return false
    }
  })
}

function signature(timestamp: string, body: string, secret: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
}

function signedRequestIsValid(req: Request, secret: string) {
  if (!secret) return false
  const timestamp = String(req.header("X-Chatmodz-Timestamp") || "")
  const received = String(req.header("X-Chatmodz-Signature") || "")
  const time = Date.parse(timestamp)
  if (!timestamp || !received || !Number.isFinite(time) || Math.abs(Date.now() - time) > SIGNATURE_WINDOW_MS) return false
  const raw = Buffer.isBuffer((req as any).rawBody)
    ? (req as any).rawBody.toString("utf8")
    : JSON.stringify(req.body)
  const expected = signature(timestamp, raw, secret)
  return timingSafeEqualHex(received.replace(/^sha256=/, ""), expected.replace(/^sha256=/, ""))
}

async function loadOperator(id: number) {
  const rows = await query<Operator>(
    `SELECT o.id, o.public_id, o.full_name, o.email, o.role, o.status,
        (SELECT a.status FROM operator_assessments a WHERE a.operator_id = o.id ORDER BY a.id DESC LIMIT 1) AS assessment_status
     FROM operators o WHERE o.id = ? LIMIT 1`,
    [id],
  )
  return rows[0]
}

async function requireChatmodzAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.header("Authorization") || ""
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" })
    const payload = jwt.verify(header.slice(7), jwtSecret(), { issuer: "chatmodz" }) as jwt.JwtPayload
    const operator = isDemoMode()
      ? getDemoAccounts().find((item) => item.id === Number(payload.operatorId))
        || demoOperator(payload.role === "operator" ? "operator" : payload.role === "recruiter" ? "recruiter" : "admin")
      : await loadOperator(Number(payload.operatorId))
    if (!operator || (operator.status !== "active" && !(operator.role === "operator" && operator.status === "training"))) {
      return res.status(401).json({ error: "Session is no longer active" })
    }
    if (isDemoMode() && operator.role === "operator") {
      operator.assessment_status = latestDemoAssessment(operator.id)?.status || null
    }
    req.chatmodzOperator = operator
    if (!isDemoMode()) {
      const now = Date.now()
      const previousTouch = lastActiveTouch.get(operator.id) || 0
      if (now - previousTouch >= LAST_ACTIVE_TOUCH_INTERVAL_MS) {
        lastActiveTouch.set(operator.id, now)
        void query("UPDATE operators SET last_active_at = NOW() WHERE id = ?", [operator.id])
          .catch((error) => console.error("[Chatmodz] Last-active update failed:", error))
      }
    }
    next()
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(401).json({ error: "Invalid session" })
  }
}

function requireApprovedOperator(req: Request, res: Response, next: NextFunction) {
  const operator = req.chatmodzOperator
  if (operator?.role !== "operator") return next()
  if (operator.status !== "active" || operator.assessment_status !== "approved") {
    return res.status(403).json({ error: "Complete and pass operator training, then receive recruiter or administrator approval before accessing live conversations.", trainingRequired: true })
  }
  next()
}

function requireChatmodzOperator(req: Request, res: Response, next: NextFunction) {
  if (req.chatmodzOperator?.role !== "operator") return res.status(403).json({ error: "Operator account required" })
  next()
}

function requireChatmodzAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.chatmodzOperator?.role !== "admin") return res.status(403).json({ error: "Administrator access required" })
  next()
}

function requireChatmodzRecruiter(req: Request, res: Response, next: NextFunction) {
  if (!["admin", "recruiter"].includes(req.chatmodzOperator?.role || "")) return res.status(403).json({ error: "Recruiter or administrator access required" })
  next()
}

async function withTransaction<T>(work: (connection: PoolConnection) => Promise<T>) {
  const connection = await database().getConnection()
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function recordActivity(operatorId: number, type: string, conversationId?: number, siteId?: number, metadata?: unknown) {
  await query(
    "INSERT INTO operator_activity (operator_id, activity_type, conversation_id, site_id, metadata_json) VALUES (?, ?, ?, ?, ?)",
    [operatorId, type, conversationId || null, siteId || null, metadata ? JSON.stringify(metadata) : null],
  )
}

async function notifyPush(title: string, body: string) {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!publicKey || !privateKey || !subject) return
  webpush.setVapidDetails(subject, publicKey, privateKey)
  const subscriptions = await query<any>("SELECT endpoint, p256dh, auth_key FROM operator_push_subscriptions")
  await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
      }, JSON.stringify({ title, body, url: "/" }))
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await query("DELETE FROM operator_push_subscriptions WHERE endpoint = ?", [subscription.endpoint])
      }
    }
  }))
}

async function deliverReply(site: any, payload: Record<string, string>) {
  if (!site.endpoint_base_url) throw new Error("Connected site has no delivery endpoint")
  const secret = secretFor(site)
  if (!secret) throw new Error("Connected site secret is not configured")
  const timestamp = new Date().toISOString()
  const body = JSON.stringify(payload)
  const response = await fetch(site.endpoint_base_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Chatmodz-Timestamp": timestamp,
      "X-Chatmodz-Signature": signature(timestamp, body, secret),
    },
    body,
  })
  if (!response.ok) throw new Error(`Connected site returned HTTP ${response.status}`)
}

router.get("/health", async (_req, res) => {
  if (isDemoMode()) return res.json({ ok: true, database: "demo" })
  try {
    await query("SELECT 1 AS ok")
    res.json({ ok: true, database: "connected" })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(503).json({ ok: false, database: "unavailable" })
  }
})

router.get("/profile-photo", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  const requestedUrl = typeof req.query.url === "string" ? req.query.url : ""
  if (!requestedUrl) return res.status(400).json({ error: "Photo URL is required" })
  try {
    let target = new URL(requestedUrl)
    if (!["http:", "https:"].includes(target.protocol) || !(await allowedPhotoHost(target.hostname))) {
      return res.status(403).json({ error: "Photo host is not approved" })
    }
    let response: globalThis.Response | null = null
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      response = await fetch(target, {
        redirect: "manual",
        headers: { Accept: "image/*" },
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get("location")
      if (!location) return res.status(502).json({ error: "Photo redirect was invalid" })
      target = new URL(location, target)
      if (!["http:", "https:"].includes(target.protocol) || !(await allowedPhotoHost(target.hostname))) {
        return res.status(403).json({ error: "Photo redirect host is not approved" })
      }
      if (redirect === 3) return res.status(502).json({ error: "Photo redirected too many times" })
    }
    if (!response || !response.ok) return res.status(502).json({ error: "Photo could not be loaded" })
    const contentType = response.headers.get("content-type") || "application/octet-stream"
    if (!contentType.toLowerCase().startsWith("image/")) return res.status(415).json({ error: "Photo response was not an image" })
    const declaredLength = Number(response.headers.get("content-length") || 0)
    if (declaredLength > MAX_PROFILE_PHOTO_BYTES) return res.status(413).json({ error: "Photo is too large" })
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > MAX_PROFILE_PHOTO_BYTES) return res.status(413).json({ error: "Photo is too large" })
    res.setHeader("Content-Type", contentType)
    res.setHeader("Content-Length", body.length)
    res.setHeader("Cache-Control", "private, max-age=300")
    res.send(body)
  } catch (error) {
    if (failConfiguration(res, error)) return
    console.error("[Chatmodz] Profile photo proxy failed:", error instanceof Error ? error.message : error)
    res.status(502).json({ error: "Photo could not be loaded" })
  }
})

router.post("/applications", async (req, res) => {
  const { fullName, email, location, experience } = req.body || {}
  if (!String(fullName || "").trim() || !String(email || "").includes("@")) {
    return res.status(400).json({ error: "Full name and a valid email are required" })
  }
  if (isDemoMode()) {
    const application = {
      id: demoApplications.length + 1,
      full_name: String(fullName).trim(),
      email: String(email).trim().toLowerCase(),
      location: String(location || "").trim(),
      experience: String(experience || "").trim(),
      status: "pending",
      created_at: new Date().toISOString(),
    }
    demoApplications.push(application)
    return res.status(201).json({ submitted: true, demo: true })
  }
  try {
    await query(
      "INSERT INTO operator_applications (full_name, email, location, experience) VALUES (?, ?, ?, ?)",
      [String(fullName).trim(), String(email).trim().toLowerCase(), String(location || "").trim() || null, String(experience || "").trim() || null],
    )
    res.status(201).json({ submitted: true })
  } catch (error: any) {
    if (failConfiguration(res, error)) return
    if (error?.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "An application with this email already exists" })
    res.status(500).json({ error: "Could not submit application" })
  }
})

router.post("/auth/login", async (req, res) => {
  const identifier = String(req.body?.identifier || req.body?.email || "").trim().toLowerCase()
  const password = String(req.body?.password || "")
  if (!identifier || !password) return res.status(400).json({ error: "Email and password are required" })
  if (isDemoMode()) {
    const configuredEmail = String(process.env.CHATMODZ_ADMIN_EMAIL || "").trim().toLowerCase()
    const configuredPassword = String(process.env.CHATMODZ_ADMIN_PASSWORD || "")
    if (!configuredPassword || !timingSafeEqualText(password, configuredPassword)) {
      return res.status(401).json({ error: "Invalid demo credentials" })
    }
    const operator = findDemoAccount(identifier)
    if (!operator) return res.status(401).json({ error: "Invalid demo credentials" })
    if (operator.role === "operator") operator.assessment_status = latestDemoAssessment(operator.id)?.status || null
    return res.json({ token: tokenFor(operator), user: publicOperator(operator), demo: true })
  }
  try {
    const rows = await query<any>("SELECT * FROM operators WHERE email = ? LIMIT 1", [identifier])
    const operator = rows[0]
    if (!operator?.password_hash || !(await bcrypt.compare(password, operator.password_hash))) return res.status(401).json({ error: "Invalid credentials" })
    if (operator.status !== "active" && !(operator.role === "operator" && operator.status === "training")) {
      return res.status(403).json({ error: "This operator account is not active" })
    }
    if (operator.role === "operator") {
      const assessment = await latestAssessment(Number(operator.id))
      operator.assessment_status = assessment?.status || null
    }
    const safe = publicOperator(operator)
    void recordActivity(operator.id, "login")
      .catch((error) => console.error("[Chatmodz] Login activity logging failed:", error))
    res.json({ token: tokenFor(operator), user: safe })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Login unavailable" })
  }
})

router.post("/auth/activate", async (req, res) => {
  const code = String(req.body?.code || "").trim()
  const password = String(req.body?.password || "")
  if (code.length < 12 || password.length < 10) return res.status(400).json({ error: "Activation code and a 10-character password are required" })
  try {
    const rows = await query<any>(
      "SELECT c.*, o.* FROM operator_activation_codes c JOIN operators o ON o.id = c.operator_id WHERE c.code_hash = ? AND c.used_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > NOW() LIMIT 1",
      [sha256(code)],
    )
    const record = rows[0]
    if (!record) return res.status(400).json({ error: "Activation code is invalid or expired" })
    const passwordHash = await bcrypt.hash(password, 12)
    await withTransaction(async (connection) => {
      await connection.execute("UPDATE operators SET password_hash = ?, status = 'training' WHERE id = ?", [passwordHash, record.operator_id])
      await connection.execute("UPDATE operator_activation_codes SET used_at = NOW() WHERE id = ?", [record.id])
    })
    const operator = await loadOperator(Number(record.operator_id))
    res.json({ token: tokenFor(operator!), user: publicOperator(operator!) })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Activation unavailable" })
  }
})

router.get("/auth/me", requireChatmodzAuth, (req, res) => res.json(publicOperator(req.chatmodzOperator!)))
router.post("/auth/logout", requireChatmodzAuth, (_req, res) => res.json({ success: true }))

router.get("/training", requireChatmodzAuth, requireChatmodzOperator, async (req, res) => {
  if (req.chatmodzOperator!.role !== "operator") return res.status(403).json({ error: "Operator training is only available to operators" })
  try {
    const assessment = isDemoMode()
      ? latestDemoAssessment(req.chatmodzOperator!.id)
      : await latestAssessmentDetails(req.chatmodzOperator!.id)
    const safeQuiz = assessmentQuiz.map(({ answer: _answer, critical: _critical, ...question }) => question)
    const safeAssessment = assessment ? {
      ...assessment,
      passage: assessment.status === "in_progress" ? typingPassages[Number(assessment.passage_id)] || "" : undefined,
      quizAnswers: typeof assessment.quiz_answers_json === "string" ? JSON.parse(assessment.quiz_answers_json) : assessment.quiz_answers_json,
      practiceResponses: typeof assessment.practice_responses_json === "string" ? JSON.parse(assessment.practice_responses_json) : assessment.practice_responses_json,
    } : null
    res.json({
      thresholds: { typingWpm: MIN_TYPING_WPM, typingAccuracy: MIN_TYPING_ACCURACY, quizScore: MIN_QUIZ_SCORE, replyCharacters: MIN_REPLY_CHARS, testSeconds: 60 },
      policyVersion: POLICY_VERSION,
      policies: assessmentPolicies,
      quiz: safeQuiz,
      scenarios: practiceScenarios.map(({ guidance: _guidance, ...scenario }) => scenario),
      assessment: safeAssessment,
    })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Training materials could not be loaded" })
  }
})

router.post("/training/start", requireChatmodzAuth, requireChatmodzOperator, async (req, res) => {
  if (req.chatmodzOperator!.role !== "operator") return res.status(403).json({ error: "Operator training is only available to operators" })
  const passageId = crypto.randomInt(0, typingPassages.length)
  const passage = typingPassages[passageId]
  try {
    if (isDemoMode()) {
      const attempts = demoAssessmentAttempts.get(req.chatmodzOperator!.id) || []
      if (attempts.some((attempt) => attempt.status === "in_progress")) return res.status(409).json({ error: "Finish or refresh your current typing test before starting another." })
      const latest = latestDemoAssessment(req.chatmodzOperator!.id)
      if (latest?.status === "submitted" && latest.auto_passed) return res.status(409).json({ error: "Your passed assessment is waiting for recruiter or administrator review." })
      const attempt = { id: Date.now(), operator_id: req.chatmodzOperator!.id, status: "in_progress", passage_id: passageId, startedAtMs: Date.now() }
      attempts.push(attempt)
      demoAssessmentAttempts.set(req.chatmodzOperator!.id, attempts)
      return res.status(201).json({ id: attempt.id, passage, startedAt: new Date(attempt.startedAtMs).toISOString() })
    }
    const current = await query<any>(
      "SELECT id FROM operator_assessments WHERE operator_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1",
      [req.chatmodzOperator!.id],
    )
    if (current[0]) return res.status(409).json({ error: "Finish or refresh your current typing test before starting another." })
    const latest = await latestAssessment(req.chatmodzOperator!.id)
    if (latest?.status === "submitted" && Boolean(latest.auto_passed)) return res.status(409).json({ error: "Your passed assessment is waiting for recruiter or administrator review." })
    const result: any = await query(
      "INSERT INTO operator_assessments (operator_id, passage_id) VALUES (?, ?)",
      [req.chatmodzOperator!.id, passageId],
    )
    const rows = await query<any>("SELECT started_at FROM operator_assessments WHERE id = ? LIMIT 1", [Number(result.insertId)])
    res.status(201).json({ id: Number(result.insertId), passage, startedAt: new Date(rows[0]?.started_at || new Date()).toISOString() })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Typing test could not be started" })
  }
})

router.post("/training/:id/submit", requireChatmodzAuth, requireChatmodzOperator, async (req, res) => {
  if (req.chatmodzOperator!.role !== "operator") return res.status(403).json({ error: "Operator training is only available to operators" })
  const attemptId = Number(req.params.id)
  const typedText = String(req.body?.typedText || "").slice(0, 5000)
  const answers = req.body?.answers && typeof req.body.answers === "object" ? req.body.answers as Record<string, string> : {}
  const responses = req.body?.practiceResponses && typeof req.body.practiceResponses === "object"
    ? req.body.practiceResponses as Record<string, string>
    : {}
  if (!attemptId || req.body?.rulesAccepted !== true) return res.status(400).json({ error: "Accept the rules and submit a valid attempt." })
  if (practiceScenarios.some((scenario) => meaningfulChars(String(responses[scenario.id] || "")) < MIN_REPLY_CHARS)) {
    return res.status(400).json({ error: `Each practice reply must contain at least ${MIN_REPLY_CHARS} non-whitespace characters.` })
  }
  const uniqueResponses = Object.values(responses).map((value) => String(value).trim().toLocaleLowerCase().replace(/\s+/g, " "))
  if (new Set(uniqueResponses).size !== uniqueResponses.length) return res.status(400).json({ error: "Write an original response for each practice chat; identical replies are not allowed." })
  try {
    let passageId = -1
    let elapsedSeconds = 0
    let demoAttempt: any = null
    if (isDemoMode()) {
      demoAttempt = (demoAssessmentAttempts.get(req.chatmodzOperator!.id) || []).find((attempt) => attempt.id === attemptId && attempt.status === "in_progress")
      if (!demoAttempt) return res.status(404).json({ error: "The typing test was not found or was already submitted." })
      passageId = Number(demoAttempt.passage_id)
      elapsedSeconds = Math.floor((Date.now() - Number(demoAttempt.startedAtMs)) / 1000)
    } else {
      const attempts = await query<any>(
        "SELECT id, passage_id, TIMESTAMPDIFF(MICROSECOND, started_at, NOW(3)) / 1000000 AS elapsed_seconds FROM operator_assessments WHERE id = ? AND operator_id = ? AND status = 'in_progress' LIMIT 1",
        [attemptId, req.chatmodzOperator!.id],
      )
      if (!attempts[0]) return res.status(404).json({ error: "The typing test was not found or was already submitted." })
      passageId = Number(attempts[0].passage_id)
      elapsedSeconds = Number(attempts[0].elapsed_seconds || 0)
    }
    if (elapsedSeconds < MIN_TYPING_TEST_SECONDS) {
      return res.status(400).json({ error: "Complete the full 60-second typing test before submitting." })
    }
    const typing = calculateTypingResult(typingPassages[passageId] || "", typedText, elapsedSeconds)
    const correctAnswers = assessmentQuiz.filter((question) => answers[question.id] === question.answer).length
    const quizScore = Math.round((correctAnswers / assessmentQuiz.length) * 100)
    const criticalPassed = assessmentQuiz.filter((question) => question.critical).every((question) => answers[question.id] === question.answer)
    const autoPassed = typing.wpm >= MIN_TYPING_WPM
      && typing.accuracy >= MIN_TYPING_ACCURACY
      && quizScore >= MIN_QUIZ_SCORE
      && criticalPassed
    const submittedAssessment = {
      id: attemptId,
      status: "submitted",
      typing_wpm: typing.wpm,
      typing_accuracy: typing.accuracy,
      quiz_score: quizScore,
      quiz_answers_json: answers,
      practice_responses_json: responses,
      policy_version: POLICY_VERSION,
      rules_acknowledged_at: new Date().toISOString(),
      auto_passed: autoPassed,
      submitted_at: new Date().toISOString(),
    }
    if (isDemoMode()) {
      Object.assign(demoAttempt, submittedAssessment)
    } else {
      await query(
        `UPDATE operator_assessments
         SET status = 'submitted', typed_text = ?, typing_wpm = ?, typing_accuracy = ?,
             quiz_answers_json = ?, quiz_score = ?, practice_responses_json = ?,
             policy_version = ?, rules_acknowledged_at = NOW(), auto_passed = ?, submitted_at = NOW()
         WHERE id = ? AND operator_id = ? AND status = 'in_progress'`,
        [typedText, typing.wpm, typing.accuracy, JSON.stringify(answers), quizScore, JSON.stringify(responses), POLICY_VERSION, autoPassed, attemptId, req.chatmodzOperator!.id],
      )
    }
    res.json({
      submitted: true,
      status: "submitted",
      autoPassed,
      typingWpm: typing.wpm,
      typingAccuracy: typing.accuracy,
      quizScore,
      criticalPassed,
      message: autoPassed
        ? "Automatic checks passed. A recruiter or administrator must review your practice chats before live access is approved."
        : "Some automatic checks did not meet the pass requirements. Review your results and retake the tests.",
    })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Assessment could not be submitted" })
  }
})

router.get("/assessments", requireChatmodzAuth, requireChatmodzRecruiter, async (req, res) => {
  const viewer = req.chatmodzOperator!
  if (isDemoMode()) {
    const operators = viewer.role === "admin"
      ? [getDemoAccounts().find((operator) => operator.role === "operator")!]
      : demoRecruiterOperators.filter((operator) => Number(operator.recruiter_id) === viewer.id)
    const assessments = operators.map((operator) => ({
      operator_id: Number(operator.id),
      operator_name: operator.full_name,
      operator_email: operator.email,
      operator_status: operator.status,
      recruiter_name: operator.recruiter_name || null,
      ...(latestDemoAssessment(Number(operator.id)) || { status: "not_started", auto_passed: false }),
    }))
    return res.json({ assessments, demo: true })
  }
  try {
    const scope = viewer.role === "admin" ? "" : "AND o.recruiter_id = ?"
    const params = viewer.role === "admin" ? [] : [viewer.id]
    const assessments = await query<any>(
      `SELECT o.id AS operator_id, o.full_name AS operator_name, o.email AS operator_email,
          o.status AS operator_status, r.full_name AS recruiter_name,
          a.id, COALESCE(a.status, 'not_started') AS status, a.auto_passed, a.typing_wpm,
          a.typing_accuracy, a.quiz_score, a.quiz_answers_json, a.practice_responses_json,
          a.policy_version, a.rules_acknowledged_at, a.reviewer_note, a.submitted_at,
          reviewer.full_name AS reviewed_by_name, a.reviewed_at
       FROM operators o
       LEFT JOIN operators r ON r.id = o.recruiter_id
       LEFT JOIN operator_assessments a ON a.id = (
         SELECT latest.id FROM operator_assessments latest
         WHERE latest.operator_id = o.id ORDER BY latest.id DESC LIMIT 1
       )
       LEFT JOIN operators reviewer ON reviewer.id = a.reviewed_by
       WHERE o.role = 'operator' ${scope}
       ORDER BY CASE WHEN a.status = 'submitted' AND a.auto_passed = 1 THEN 0 ELSE 1 END, a.submitted_at DESC, o.created_at DESC`,
      params,
    )
    res.json({ assessments: assessments.map((assessment) => ({
      ...assessment,
      quiz_answers_json: typeof assessment.quiz_answers_json === "string" ? JSON.parse(assessment.quiz_answers_json) : assessment.quiz_answers_json,
      practice_responses_json: typeof assessment.practice_responses_json === "string" ? JSON.parse(assessment.practice_responses_json) : assessment.practice_responses_json,
      auto_passed: Boolean(assessment.auto_passed),
    })) })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Assessment results could not be loaded" })
  }
})

router.get("/late-replies", requireChatmodzAuth, requireChatmodzRecruiter, async (req, res) => {
  const viewer = req.chatmodzOperator!
  if (isDemoMode()) return res.json({ lateReplies: [], demo: true })
  try {
    const scope = viewer.role === "admin" ? "" : "AND op.recruiter_id = ?"
    const params = viewer.role === "admin" ? [] : [viewer.id]
    const lateReplies = await query<any>(
      `SELECT a.id, a.actor_operator_id AS operator_id, op.full_name AS operator_name,
          c.member_alias, c.managed_profile_alias, a.entity_id AS conversation_id,
          CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.minutesSinceLastMemberMessage')) AS UNSIGNED) AS minutes_waited,
          a.created_at
       FROM audit_log a
       JOIN operators op ON op.id = a.actor_operator_id
       JOIN conversations c ON c.id = a.entity_id
       WHERE a.action = 'late_operator_reply'
         AND a.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) ${scope}
       ORDER BY a.created_at DESC LIMIT 250`,
      params,
    )
    res.json({ lateReplies })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Late replies could not be loaded" })
  }
})

router.post("/assessments/:id/decision", requireChatmodzAuth, requireChatmodzRecruiter, async (req, res) => {
  const assessmentId = Number(req.params.id)
  const decision = String(req.body?.decision || "")
  const reviewerNote = String(req.body?.reviewerNote || "").trim().slice(0, 1000)
  if (!assessmentId || !["approve", "reject"].includes(decision)) return res.status(400).json({ error: "Choose approve or reject for a valid assessment." })
  const approved = decision === "approve"
  try {
    if (isDemoMode()) {
      const attempt = [...demoAssessmentAttempts.values()].flat().find((item) => item.id === assessmentId && item.status === "submitted")
      const operator = [...getDemoAccounts(), ...demoRecruiterOperators].find((item) => Number(item.id) === Number(attempt?.operator_id))
      const owned = operator && (req.chatmodzOperator!.role === "admin" || Number(operator.recruiter_id) === req.chatmodzOperator!.id)
      if (!attempt || !owned) return res.status(404).json({ error: "Assessment not found in your team." })
      if (approved && !attempt.auto_passed) return res.status(409).json({ error: "This operator did not pass the automatic checks and cannot be approved." })
      attempt.status = approved ? "approved" : "rejected"
      attempt.reviewer_note = reviewerNote
      attempt.reviewed_by_name = req.chatmodzOperator!.full_name
      attempt.reviewed_at = new Date().toISOString()
      operator.status = approved ? "active" : "training"
      return res.json({ decided: true, status: attempt.status, demo: true })
    }
    const scope = req.chatmodzOperator!.role === "admin" ? "" : "AND o.recruiter_id = ?"
    const params = req.chatmodzOperator!.role === "admin" ? [assessmentId] : [assessmentId, req.chatmodzOperator!.id]
    const rows = await query<any>(
      `SELECT a.id, a.operator_id, a.status, a.auto_passed FROM operator_assessments a
       JOIN operators o ON o.id = a.operator_id
       WHERE a.id = ? ${scope}
         AND a.status = 'submitted'
         AND NOT EXISTS (SELECT 1 FROM operator_assessments newer WHERE newer.operator_id = a.operator_id AND newer.id > a.id)
       LIMIT 1`,
      params,
    )
    const assessment = rows[0]
    if (!assessment) return res.status(404).json({ error: "Assessment not found, already reviewed, or not assigned to your team." })
    if (approved && !assessment.auto_passed) return res.status(409).json({ error: "This operator did not pass the automatic checks and cannot be approved." })
    await withTransaction(async (connection) => {
      await connection.execute(
        "UPDATE operator_assessments SET status = ?, reviewer_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
        [approved ? "approved" : "rejected", reviewerNote || null, req.chatmodzOperator!.id, assessmentId],
      )
      await connection.execute("UPDATE operators SET status = ? WHERE id = ?", [approved ? "active" : "training", assessment.operator_id])
      await connection.execute(
        "INSERT INTO audit_log (actor_operator_id, action, entity_type, entity_id, metadata_json) VALUES (?, ?, 'operator_assessment', ?, ?)",
        [req.chatmodzOperator!.id, approved ? "approve_operator_assessment" : "reject_operator_assessment", assessmentId, JSON.stringify({ operatorId: Number(assessment.operator_id), reviewerNote })],
      )
    })
    res.json({ decided: true, status: approved ? "approved" : "rejected" })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Assessment decision could not be saved" })
  }
})

router.get("/conversations", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  if (isDemoMode()) return res.json({ conversations: [], total: 0, page: 1, pages: 1, demo: true })
  try {
    const rows = await query<any>(`
      SELECT c.*, s.endpoint_base_url AS site_endpoint_base_url,
        latest.body AS last_message, latest.sender_type AS last_sender_type,
        latest.delivery_status AS last_delivery_status,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count
      FROM conversations c
      JOIN sites s ON s.id = c.site_id
      JOIN messages latest ON latest.id = (
        SELECT m.id FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT 1
      )
      WHERE c.status <> 'closed'
        AND (c.lock_expires_at IS NULL OR c.lock_expires_at < NOW() OR c.assigned_operator_id = ?)
        AND latest.sender_type = 'member'
      ORDER BY c.last_message_at DESC
      LIMIT 100
    `, [req.chatmodzOperator!.id])
    const conversations = rows.map((row) => ({
      key: publicKey(Number(row.id)),
      fakeUser: { id: -1, name: row.managed_profile_alias, photo: profilePhotoPath(row.managed_profile_photo_url, row.site_endpoint_base_url), profile: profileDetails(row.managed_profile_profile_json) },
      realUser: { id: -2, name: row.member_alias, photo: profilePhotoPath(row.member_photo_url, row.site_endpoint_base_url), profile: profileDetails(row.member_profile_json) },
      lastMessage: row.last_message || "",
      lastTime: Math.floor(new Date(row.last_message_at).getTime() / 1000),
      msgCount: Number(row.msg_count || 0),
      lastSenderFake: row.last_sender_type === "managed_profile",
      lastMsgRead: row.last_delivery_status === "delivered",
      lock: row.assigned_operator_id && row.lock_expires_at && new Date(row.lock_expires_at).getTime() > Date.now()
        ? { moderatorId: Number(row.assigned_operator_id), moderatorName: Number(row.assigned_operator_id) === req.chatmodzOperator!.id ? "You" : "Another operator", lockedAt: 0, expiresAt: Math.floor(new Date(row.lock_expires_at).getTime() / 1000) }
        : null,
    }))
    res.json({ conversations, total: conversations.length, page: 1, pages: 1 })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Conversation queue unavailable" })
  }
})

router.get("/conversations/:key/messages", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  const conversationId = internalId(String(req.params.key))
  if (!conversationId) return res.status(400).json({ error: "Invalid conversation" })
  if (isDemoMode()) {
    const note = demoConversationNotes.get(conversationId)
    return res.json({
      messages: [],
      users: {},
      notes: note || { text: "", updatedAt: null, updatedByName: null },
      demo: true,
    })
  }
  try {
    const conversations = await query<any>(
      "SELECT c.*, s.endpoint_base_url AS site_endpoint_base_url, o.full_name AS operator_notes_updated_by_name FROM conversations c JOIN sites s ON s.id = c.site_id LEFT JOIN operators o ON o.id = c.operator_notes_updated_by WHERE c.id = ? LIMIT 1",
      [conversationId],
    )
    const conversation = conversations[0]
    if (!conversation) return res.status(404).json({ error: "Conversation not found" })
    const rows = await query<any>("SELECT id, sender_type, body, media_proxy_url, media_type, sent_at, delivery_status FROM messages WHERE conversation_id = ? ORDER BY sent_at ASC, id ASC", [conversationId])
    res.json({
      messages: rows.map((row) => ({
        id: Number(row.id),
        senderType: row.sender_type,
        u1: row.sender_type === "managed_profile" ? -1 : -2,
        u2: row.sender_type === "managed_profile" ? -2 : -1,
        message: row.body,
        time: Math.floor(new Date(row.sent_at).getTime() / 1000),
        read: row.delivery_status === "delivered" ? 1 : 0,
        mediaUrl: row.media_type === "image"
          ? profilePhotoPath(row.media_proxy_url, conversation.site_endpoint_base_url)
          : operatorMediaPath(row.media_proxy_url, conversation.site_endpoint_base_url),
        mediaType: row.media_type || "",
      })),
      users: {
        "-1": { id: -1, name: conversation.managed_profile_alias, photo: profilePhotoPath(conversation.managed_profile_photo_url, conversation.site_endpoint_base_url), profile: profileDetails(conversation.managed_profile_profile_json, conversation.site_endpoint_base_url) },
        "-2": { id: -2, name: conversation.member_alias, photo: profilePhotoPath(conversation.member_photo_url, conversation.site_endpoint_base_url), profile: profileDetails(conversation.member_profile_json, conversation.site_endpoint_base_url) },
      },
      notes: {
        text: conversation.operator_notes || "",
        updatedAt: conversation.operator_notes_updated_at || null,
        updatedByName: conversation.operator_notes_updated_by_name || null,
      },
    })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Messages unavailable" })
  }
})

router.post("/conversations/:key/panic-room", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  const conversationId = internalId(String(req.params.key))
  const category = String(req.body?.category || "")
  const allowedCategories = ["underage", "illegal_activity", "suicidal_intent_with_means", "persistent_racism"]
  const details = String(req.body?.details || "").trim().slice(0, 1000)
  if (!conversationId || !allowedCategories.includes(category)) {
    return res.status(400).json({ error: "Choose one of the severe safety issues listed in Panic Room." })
  }
  try {
    if (isDemoMode()) {
      const escalation = {
        id: Date.now(),
        conversation_id: conversationId,
        operator_id: req.chatmodzOperator!.id,
        operator_name: req.chatmodzOperator!.full_name,
        category,
        details,
        status: "open",
        created_at: new Date().toISOString(),
      }
      demoSafetyEscalations.unshift(escalation)
      return res.status(201).json({ escalation, demo: true })
    }
    const conversations = await query<any>(
      "SELECT id FROM conversations WHERE id = ? AND assigned_operator_id = ? AND lock_expires_at > NOW() LIMIT 1",
      [conversationId, req.chatmodzOperator!.id],
    )
    if (!conversations[0]) return res.status(409).json({ error: "Lock this conversation before escalating it." })
    const result: any = await query(
      "INSERT INTO operator_safety_escalations (conversation_id, operator_id, category, details) VALUES (?, ?, ?, ?)",
      [conversationId, req.chatmodzOperator!.id, category, details || null],
    )
    await query(
      "INSERT INTO audit_log (actor_operator_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'panic_room_escalation', 'conversation', ?, ?)",
      [req.chatmodzOperator!.id, conversationId, JSON.stringify({ escalationId: Number(result.insertId), category })],
    )
    res.status(201).json({ escalationId: Number(result.insertId), status: "open" })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Safety escalation could not be recorded" })
  }
})

router.get("/safety-escalations", requireChatmodzAuth, requireChatmodzRecruiter, async (req, res) => {
  const viewer = req.chatmodzOperator!
  if (isDemoMode()) {
    const escalations = viewer.role === "admin"
      ? demoSafetyEscalations
      : demoSafetyEscalations.filter((escalation) => demoRecruiterOperators.some((operator) => Number(operator.id) === Number(escalation.operator_id) && Number(operator.recruiter_id) === viewer.id))
    return res.json({ escalations, demo: true })
  }
  try {
    const scope = viewer.role === "admin" ? "" : "AND op.recruiter_id = ?"
    const params = viewer.role === "admin" ? [] : [viewer.id]
    const escalations = await query<any>(
      `SELECT e.id, e.conversation_id, c.member_alias, c.managed_profile_alias,
          e.operator_id, op.full_name AS operator_name, op.recruiter_id,
          e.category, e.details, e.status, e.created_at, e.reviewed_at,
          reviewer.full_name AS reviewed_by_name
       FROM operator_safety_escalations e
       JOIN conversations c ON c.id = e.conversation_id
       JOIN operators op ON op.id = e.operator_id
       LEFT JOIN operators reviewer ON reviewer.id = e.reviewed_by
       WHERE 1 = 1 ${scope}
       ORDER BY CASE WHEN e.status = 'open' THEN 0 ELSE 1 END, e.created_at DESC LIMIT 250`,
      params,
    )
    res.json({ escalations })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Safety reports could not be loaded" })
  }
})

router.post("/safety-escalations/:id/status", requireChatmodzAuth, requireChatmodzRecruiter, async (req, res) => {
  const escalationId = Number(req.params.id)
  const status = String(req.body?.status || "")
  if (!escalationId || !["reviewed", "resolved"].includes(status)) return res.status(400).json({ error: "Choose reviewed or resolved." })
  if (isDemoMode()) {
    const escalation = demoSafetyEscalations.find((item) => Number(item.id) === escalationId)
    const operator = demoRecruiterOperators.find((item) => Number(item.id) === Number(escalation?.operator_id))
    if (!escalation || (req.chatmodzOperator!.role !== "admin" && Number(operator?.recruiter_id) !== req.chatmodzOperator!.id)) {
      return res.status(404).json({ error: "Safety report not found in your team." })
    }
    escalation.status = status
    escalation.reviewed_by_name = req.chatmodzOperator!.full_name
    escalation.reviewed_at = new Date().toISOString()
    return res.json({ updated: true, demo: true })
  }
  try {
    const scope = req.chatmodzOperator!.role === "admin" ? "" : "AND op.recruiter_id = ?"
    const params = req.chatmodzOperator!.role === "admin"
      ? [status, req.chatmodzOperator!.id, escalationId]
      : [status, req.chatmodzOperator!.id, escalationId, req.chatmodzOperator!.id]
    const result: any = await query(
      `UPDATE operator_safety_escalations e
       JOIN operators op ON op.id = e.operator_id
       SET e.status = ?, e.reviewed_by = ?, e.reviewed_at = NOW()
       WHERE e.id = ? ${scope}`,
      params,
    )
    if (!result.affectedRows) return res.status(404).json({ error: "Safety report not found in your team." })
    res.json({ updated: true })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Safety report could not be updated" })
  }
})

const updateConversationNotes = async (req: Request, res: Response) => {
  const conversationId = internalId(String(req.params.key))
  if (!conversationId) return res.status(400).json({ error: "Invalid conversation" })
  const text = String(req.body?.notes ?? req.body?.text ?? "").trim().slice(0, MAX_OPERATOR_NOTES)
  if (isDemoMode()) {
    const note = { text, updatedAt: new Date().toISOString(), updatedByName: req.chatmodzOperator!.full_name }
    demoConversationNotes.set(conversationId, note)
    return res.json({ notes: note, demo: true })
  }
  try {
    const rows = await query<any>(
      "SELECT assigned_operator_id, lock_expires_at FROM conversations WHERE id = ? LIMIT 1",
      [conversationId],
    )
    const conversation = rows[0]
    if (!conversation) return res.status(404).json({ error: "Conversation not found" })
    const ownsLock = Number(conversation.assigned_operator_id) === req.chatmodzOperator!.id
      && conversation.lock_expires_at
      && new Date(conversation.lock_expires_at).getTime() > Date.now()
    if (!ownsLock) return res.status(409).json({ error: "Lock this conversation before saving notes" })
    await query(
      "UPDATE conversations SET operator_notes = ?, operator_notes_updated_at = NOW(), operator_notes_updated_by = ? WHERE id = ?",
      [text || null, req.chatmodzOperator!.id, conversationId],
    )
    try {
      await recordActivity(req.chatmodzOperator!.id, "note", conversationId)
    } catch (activityError) {
      console.error("[Chatmodz] Note saved but activity logging failed:", activityError)
    }
    res.json({
      notes: {
        text,
        updatedAt: new Date().toISOString(),
        updatedByName: req.chatmodzOperator!.full_name,
      },
    })
  } catch (error) {
    console.error("[Chatmodz] Notes update failed:", error)
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Notes unavailable" })
  }
}

// Use POST from the web client because some production Apache configurations reject PUT with 406.
router.post("/conversations/:key/notes", requireChatmodzAuth, requireApprovedOperator, updateConversationNotes)
// Keep PUT available for older clients and deployments that permit it.
router.put("/conversations/:key/notes", requireChatmodzAuth, requireApprovedOperator, updateConversationNotes)

router.post("/conversations/:key/lock", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  const conversationId = internalId(String(req.params.key))
  if (!conversationId) return res.status(400).json({ error: "Invalid conversation" })
  try {
    const result: any = await database().execute(
      "UPDATE conversations SET assigned_operator_id = ?, lock_expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id = ? AND status <> 'closed' AND (assigned_operator_id IS NULL OR lock_expires_at < NOW() OR assigned_operator_id = ?)",
      [req.chatmodzOperator!.id, conversationId, req.chatmodzOperator!.id],
    )
    if (Number(result[0]?.affectedRows || 0) === 0) return res.status(409).json({ error: "Conversation is locked by another operator" })
    await query("INSERT INTO conversation_assignments (conversation_id, operator_id) VALUES (?, ?)", [conversationId, req.chatmodzOperator!.id])
    await recordActivity(req.chatmodzOperator!.id, "claim", conversationId)
    res.json({ success: true, expiresAt: Math.floor(Date.now() / 1000) + LOCK_MINUTES * 60 })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Could not lock conversation" })
  }
})

router.post("/conversations/:key/unlock", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  const conversationId = internalId(String(req.params.key))
  try {
    const rows = await query<any>("SELECT assigned_operator_id FROM conversations WHERE id = ? LIMIT 1", [conversationId])
    const owner = Number(rows[0]?.assigned_operator_id || 0)
    if (owner && owner !== req.chatmodzOperator!.id && req.chatmodzOperator!.role !== "admin") return res.status(403).json({ error: "Cannot release another operator's lock" })
    await query("UPDATE conversations SET assigned_operator_id = NULL, lock_expires_at = NULL WHERE id = ?", [conversationId])
    await query("UPDATE conversation_assignments SET released_at = NOW() WHERE conversation_id = ? AND released_at IS NULL", [conversationId])
    await recordActivity(req.chatmodzOperator!.id, "release", conversationId)
    res.json({ success: true })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Could not release conversation" })
  }
})

router.post("/conversations/:key/keepalive", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  const conversationId = internalId(String(req.params.key))
  try {
    const result: any = await database().execute("UPDATE conversations SET lock_expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id = ? AND assigned_operator_id = ? AND lock_expires_at > NOW()", [conversationId, req.chatmodzOperator!.id])
    if (!Number(result[0]?.affectedRows || 0)) return res.status(403).json({ error: "Lock expired or is not yours" })
    res.json({ success: true, expiresAt: Math.floor(Date.now() / 1000) + LOCK_MINUTES * 60 })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Could not renew lock" })
  }
})

router.post("/conversations/:key/reply", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  const conversationId = internalId(String(req.params.key))
  const body = String(req.body?.message || "").trim()
  const mediaUrl = String(req.body?.mediaUrl || "").trim() || null
  const mediaType = String(req.body?.mediaType || "").trim() || null
  if (!conversationId || (!body && !mediaUrl)) return res.status(400).json({ error: "Reply text or media is required" })
  if (meaningfulChars(body) < MIN_REPLY_CHARS) return res.status(400).json({ error: `Every reply must contain at least ${MIN_REPLY_CHARS} non-whitespace characters` })
  if (!/[?？]/u.test(body)) return res.status(400).json({ error: "Answer the member and include a relevant follow-up question." })
  if (/\bi\s+love\s+you\b/i.test(body)) return res.status(400).json({ error: "Replies must not include the phrase “I love you”." })
  if (/\b(?:let['’]?s|we should|i(?:'d| would) (?:love|like) to|would you like to)\s+(?:meet|go out|see each other|grab coffee)\b|\bmeet you (?:this|next|on)\b/i.test(body)) {
    return res.status(400).json({ error: "Do not arrange or suggest an in-person meeting. Redirect to online chat." })
  }
  if (/(?:https?:\/\/|www\.|[\w.%+-]+@[\w.-]+\.[a-z]{2,}|\b(?:whatsapp|telegram|instagram|facebook|snapchat|tiktok)\b|\+?\d[\d\s().-]{8,}\d)/i.test(body)) {
    return res.status(400).json({ error: "Do not share contact details or direct anyone off this platform." })
  }
  const explicitContent = /\b(?:sex|sext(?:ing)?|nude|naked|dick|cock|pussy|blowjob|orgasm|fuck(?:ing)?)\b/i
  if (req.chatmodzOperator!.role === "operator" && explicitContent.test(body)) {
    return res.status(400).json({ error: "Do not initiate explicit conversation. Keep the reply within the platform's content policy." })
  }
  try {
    const levels = await query<any>(
      `SELECT l.id, l.rate_minor, l.currency
       FROM operator_levels l
       LEFT JOIN operator_level_assignments a ON a.level_id = l.id AND a.operator_id = ?
       WHERE l.active = 1 AND (a.operator_id IS NOT NULL OR l.is_default = 1)
       ORDER BY CASE WHEN a.operator_id IS NOT NULL THEN 0 ELSE 1 END, l.id
       LIMIT 1`,
      [req.chatmodzOperator!.id],
    )
    const level = levels[0]
    if (!level) return res.status(409).json({ error: "No active compensation level is configured for this operator" })
    const rows = await query<any>("SELECT c.*, s.endpoint_base_url, s.secret_env_key, s.internal_name FROM conversations c JOIN sites s ON s.id = c.site_id WHERE c.id = ? AND c.assigned_operator_id = ? AND c.lock_expires_at > NOW() LIMIT 1", [conversationId, req.chatmodzOperator!.id])
    const conversation = rows[0]
    if (!conversation) return res.status(409).json({ error: "Lock expired or is not yours" })
    const normalizedReply = body.toLocaleLowerCase().replace(/\s+/g, " ").trim()
    const recentReplies = await query<any>(
      "SELECT body FROM messages WHERE sent_by_operator_id = ? AND sent_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) ORDER BY sent_at DESC LIMIT 500",
      [req.chatmodzOperator!.id],
    )
    if (recentReplies.some((item) => {
      const previous = String(item.body || "").toLocaleLowerCase().replace(/\s+/g, " ").trim()
      return previous === normalizedReply || repliesAreNearDuplicates(previous, normalizedReply)
    })) {
      return res.status(409).json({ error: "This reply is too similar to a recent message. Write an original reply for this conversation." })
    }
    const lastMemberMessage = await query<any>(
      "SELECT sent_at FROM messages WHERE conversation_id = ? AND sender_type = 'member' ORDER BY sent_at DESC, id DESC LIMIT 1",
      [conversationId],
    )
    const latestMemberAt = lastMemberMessage[0]?.sent_at ? new Date(lastMemberMessage[0].sent_at).getTime() : null
    const late = latestMemberAt !== null && Date.now() - latestMemberAt > 25 * 60 * 1000
    const externalMessageId = `chatmodz-${crypto.randomBytes(10).toString("hex")}`
    const deliveryPayload = { conversationId: conversation.external_conversation_id, messageId: externalMessageId, body, sentAt: new Date().toISOString() }
    await query("INSERT INTO messages (conversation_id, external_message_id, sender_type, body, media_proxy_url, media_type, delivery_status, sent_by_operator_id) VALUES (?, ?, 'managed_profile', ?, ?, ?, 'queued', ?)", [conversationId, externalMessageId, body, mediaUrl, mediaType, req.chatmodzOperator!.id])
    const messageRows = await query<any>("SELECT id, sent_at FROM messages WHERE external_message_id = ? LIMIT 1", [externalMessageId])
    const messageId = Number(messageRows[0]?.id)
    await query("INSERT INTO integration_deliveries (site_id, direction, external_event_id, conversation_id, status, attempt_count, payload_json) VALUES (?, 'outgoing', ?, ?, 'received', 0, ?)", [conversation.site_id, externalMessageId, conversationId, JSON.stringify(deliveryPayload)])
    await query(
      "INSERT INTO operator_earnings (message_id, operator_id, level_id, rate_minor, currency, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      [messageId, req.chatmodzOperator!.id, Number(level.id), Number(level.rate_minor), String(level.currency || "EUR").toUpperCase()],
    )
    try {
      await deliverReply(conversation, deliveryPayload)
      await query("UPDATE messages SET delivery_status = 'delivered' WHERE id = ?", [messageId])
      await query("UPDATE integration_deliveries SET status = 'delivered', attempt_count = attempt_count + 1, delivered_at = NOW() WHERE external_event_id = ?", [externalMessageId])
      await recordActivity(req.chatmodzOperator!.id, "reply", conversationId, Number(conversation.site_id))
      if (late) {
        await query(
          "INSERT INTO audit_log (actor_operator_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'late_operator_reply', 'conversation', ?, ?)",
          [req.chatmodzOperator!.id, conversationId, JSON.stringify({ minutesSinceLastMemberMessage: Math.floor((Date.now() - latestMemberAt!) / 60000) })],
        ).catch((error) => console.error("[Chatmodz] Late reply audit failed:", error))
      }
    } catch (error: any) {
      await query("UPDATE messages SET delivery_status = 'failed' WHERE id = ?", [messageId])
      await query("UPDATE integration_deliveries SET status = 'failed', attempt_count = attempt_count + 1, error_message = ? WHERE external_event_id = ?", [String(error?.message || "Delivery failed").slice(0, 500), externalMessageId])
      await query("UPDATE operator_earnings SET status = 'void' WHERE message_id = ?", [messageId])
      return res.status(502).json({ error: "Reply could not be delivered to the connected site" })
    }
    res.json({ message: { id: messageId, senderType: "managed_profile", u1: -1, u2: -2, message: body, time: Math.floor(new Date(messageRows[0].sent_at).getTime() / 1000), read: 1, mediaUrl: operatorMediaPath(mediaUrl), mediaType }, deliveryStatus: "delivered", late })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Reply unavailable" })
  }
})

router.get("/stats", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  if (isDemoMode()) return res.json({ activeLocks: 0, totalConversations: 0, messagesSent: 0, demo: true })
  try {
    const [[conversation], [locks], [sent]] = await Promise.all([
      query<any>(`
      SELECT COUNT(*) AS total
      FROM conversations c
      JOIN messages latest ON latest.id = (
        SELECT m.id FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT 1
      )
      WHERE c.status <> 'closed'
        AND latest.sender_type = 'member'
      `),
      query<any>("SELECT COUNT(*) AS total FROM conversations WHERE assigned_operator_id IS NOT NULL AND lock_expires_at > NOW()"),
      query<any>("SELECT COUNT(*) AS total FROM messages WHERE sent_by_operator_id = ?", [req.chatmodzOperator!.id]),
    ])
    res.json({ activeLocks: Number(locks?.total || 0), totalConversations: Number(conversation?.total || 0), messagesSent: Number(sent?.total || 0) })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Stats unavailable" })
  }
})

router.get("/push/vapid-key", requireChatmodzAuth, (_req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: "Push notifications are not configured" })
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY })
})

router.post("/push/subscribe", requireChatmodzAuth, async (req, res) => {
  const subscription = req.body || {}
  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) return res.status(400).json({ error: "Invalid push subscription" })
  try {
    await query("INSERT INTO operator_push_subscriptions (operator_id, endpoint, p256dh, auth_key) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE operator_id = VALUES(operator_id), p256dh = VALUES(p256dh), auth_key = VALUES(auth_key)", [req.chatmodzOperator!.id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth])
    res.json({ success: true })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Could not save push subscription" })
  }
})

router.delete("/push/unsubscribe", requireChatmodzAuth, async (req, res) => {
  try {
    await query("DELETE FROM operator_push_subscriptions WHERE operator_id = ? AND endpoint = ?", [req.chatmodzOperator!.id, String(req.body?.endpoint || "")])
    res.json({ success: true })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Could not remove push subscription" })
  }
})

router.post("/integrations/:siteKey/profiles", async (req, res) => {
  const siteKey = String(req.params.siteKey || "")
  const payload = req.body || {}
  const conversationId = typeof payload.conversationId === "string" ? payload.conversationId.trim() : ""
  const memberPhotoUrl = typeof payload.memberPhotoUrl === "string" ? payload.memberPhotoUrl.trim() : ""
  const managedProfilePhotoUrl = typeof payload.managedProfilePhotoUrl === "string" ? payload.managedProfilePhotoUrl.trim() : ""
  const memberProfile = profileFromPayload(payload, "member")
  const managedProfile = profileFromPayload(payload, "managedProfile")
  if (!conversationId || (!memberPhotoUrl && !managedProfilePhotoUrl && !memberProfile && !managedProfile)) return res.status(400).json({ error: "A conversation and at least one profile detail are required" })
  try {
    const sites = await query<any>("SELECT * FROM sites WHERE internal_name = ? AND status = 'active' LIMIT 1", [siteKey])
    const site = sites[0]
    if (!site || !signedRequestIsValid(req, secretFor(site))) return res.status(401).json({ error: "Invalid integration signature" })
    const memberId = Number(payload.memberId)
    const managedProfileId = Number(payload.managedProfileId)
    const conversationIds = [...new Set([
      conversationId,
      Number.isSafeInteger(memberId) && Number.isSafeInteger(managedProfileId) && memberId > 0 && managedProfileId > 0
        ? [
            "rdn-" + memberId + "-" + managedProfileId,
            "rdn-" + managedProfileId + "-" + memberId,
            "rdn-" + Math.min(memberId, managedProfileId) + "-" + Math.max(memberId, managedProfileId),
          ]
        : [],
    ].flat())]
    const idPlaceholders = conversationIds.map(() => "?").join(", ")
    let matched = await query<any>(
      `SELECT id FROM conversations WHERE site_id = ? AND external_conversation_id IN (${idPlaceholders})`,
      [site.id, ...conversationIds],
    )
    if (matched.length === 0 && typeof payload.memberAlias === "string" && typeof payload.managedProfileAlias === "string") {
      const aliasMatches = await query<any>(
        "SELECT id FROM conversations WHERE site_id = ? AND member_alias = ? AND managed_profile_alias = ? LIMIT 2",
        [site.id, payload.memberAlias.trim(), payload.managedProfileAlias.trim()],
      )
      if (aliasMatches.length === 1) matched = aliasMatches
    }
    if (matched.length === 0) {
      console.warn("[Chatmodz] Profile sync found no matching conversation", { siteKey, conversationId, memberId, managedProfileId })
      return res.status(202).json({ accepted: true, matched: 0, updated: false })
    }
    const rowPlaceholders = matched.map(() => "?").join(", ")
    const [result] = await database().execute(
      `UPDATE conversations SET member_photo_url = COALESCE(NULLIF(?, ''), member_photo_url), managed_profile_photo_url = COALESCE(NULLIF(?, ''), managed_profile_photo_url), member_profile_json = COALESCE(?, member_profile_json), managed_profile_profile_json = COALESCE(?, managed_profile_profile_json) WHERE id IN (${rowPlaceholders})`,
      [memberPhotoUrl || null, managedProfilePhotoUrl || null, memberProfile ? JSON.stringify(memberProfile) : null, managedProfile ? JSON.stringify(managedProfile) : null, ...matched.map((row) => Number(row.id))],
    ) as any
    res.status(202).json({ accepted: true, matched: matched.length, updated: Number(result?.affectedRows || 0) > 0 })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Could not update conversation profiles" })
  }
})

router.post("/integrations/:siteKey/messages", async (req, res) => {
  const siteKey = String(req.params.siteKey || "")
  const payload = req.body || {}
  const senderType = payload.sender === "managed_profile" ? "managed_profile" : payload.sender === "member" ? "member" : ""
  const body = typeof payload.body === "string" ? payload.body.trim() : ""
  const mediaUrl = typeof payload.mediaUrl === "string" ? payload.mediaUrl.trim() : ""
  const requestedMediaType = typeof payload.mediaType === "string" ? payload.mediaType.trim().toLowerCase() : ""
  const mediaType = ["image", "video", "audio"].includes(requestedMediaType) ? requestedMediaType : ""
  const memberProfile = profileFromPayload(payload, "member")
  const managedProfile = profileFromPayload(payload, "managedProfile")
  if (!payload.eventId || !payload.conversationId || !payload.messageId || (!body && !mediaUrl) || !senderType || (mediaUrl && !mediaType)) {
    return res.status(400).json({ error: "Invalid message event" })
  }
  try {
    const sites = await query<any>("SELECT * FROM sites WHERE internal_name = ? AND status = 'active' LIMIT 1", [siteKey])
    const site = sites[0]
    if (!site || !signedRequestIsValid(req, secretFor(site))) return res.status(401).json({ error: "Invalid integration signature" })
    const existing = await query<any>("SELECT id FROM integration_deliveries WHERE site_id = ? AND direction = 'incoming' AND external_event_id = ? LIMIT 1", [site.id, payload.eventId])
    if (existing.length) return res.status(202).json({ accepted: true, duplicate: true })
    await withTransaction(async (connection) => {
      const conversations = await connection.execute("SELECT id FROM conversations WHERE site_id = ? AND external_conversation_id = ? LIMIT 1", [site.id, payload.conversationId]) as any
      let conversationId = Number(conversations[0][0]?.id || 0)
      if (!conversationId) {
        const created: any = await connection.execute("INSERT INTO conversations (site_id, external_conversation_id, member_alias, managed_profile_alias, member_photo_url, managed_profile_photo_url, member_profile_json, managed_profile_profile_json, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [site.id, payload.conversationId, payload.memberAlias || "Member", payload.managedProfileAlias || "Managed profile", payload.memberPhotoUrl || null, payload.managedProfilePhotoUrl || null, memberProfile ? JSON.stringify(memberProfile) : null, managedProfile ? JSON.stringify(managedProfile) : null, new Date(payload.sentAt || Date.now())])
        conversationId = Number(created[0].insertId)
      } else {
        await connection.execute("UPDATE conversations SET member_alias = ?, managed_profile_alias = ?, member_photo_url = COALESCE(?, member_photo_url), managed_profile_photo_url = COALESCE(?, managed_profile_photo_url), member_profile_json = COALESCE(?, member_profile_json), managed_profile_profile_json = COALESCE(?, managed_profile_profile_json), last_message_at = GREATEST(last_message_at, ?) WHERE id = ?", [payload.memberAlias || "Member", payload.managedProfileAlias || "Managed profile", payload.memberPhotoUrl || null, payload.managedProfilePhotoUrl || null, memberProfile ? JSON.stringify(memberProfile) : null, managedProfile ? JSON.stringify(managedProfile) : null, new Date(payload.sentAt || Date.now()), conversationId])
      }
      await connection.execute("INSERT INTO messages (conversation_id, external_message_id, sender_type, body, media_proxy_url, media_type, delivery_status, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)", [conversationId, payload.messageId, senderType, body, mediaUrl || null, mediaType || null, new Date(payload.sentAt || Date.now())])
      await connection.execute("INSERT INTO integration_deliveries (site_id, direction, external_event_id, conversation_id, status, attempt_count, payload_json) VALUES (?, 'incoming', ?, ?, 'processed', 1, ?)", [site.id, payload.eventId, conversationId, JSON.stringify(payload)])
    })
    if (senderType === "member") {
      void notifyPush("New conversation message", "A member message is waiting in the operator queue")
        .catch((error) => console.error("[Chatmodz] Push notification failed:", error))
    }
    res.status(202).json({ accepted: true })
  } catch (error: any) {
    if (failConfiguration(res, error)) return
    if (error?.code === "ER_DUP_ENTRY") return res.status(202).json({ accepted: true, duplicate: true })
    res.status(500).json({ error: "Could not process message event" })
  }
})

router.get("/earnings", requireChatmodzAuth, requireApprovedOperator, async (req, res) => {
  const operatorId = req.chatmodzOperator!.id
  const schedule = payoutSchedule()
  if (isDemoMode()) {
    const level = demoLevels.find((item) => item.id === demoOperatorLevels.get(operatorId)) || demoLevels.find((item) => item.is_default) || demoLevels[0]
    return res.json({
      level: level ? compensationLevel(level) : null,
      schedule,
      summary: { currentMonthMinor: 0, pendingMinor: 0, paidMinor: 0, lifetimeMinor: 0, totalMessages: 0 },
      recent: [],
      demo: true,
    })
  }
  try {
    const [[level], [summary], recent] = await Promise.all([
      query<any>(
        `SELECT l.id, l.name, l.description, l.rate_minor, l.currency
         FROM operator_levels l
         LEFT JOIN operator_level_assignments a ON a.level_id = l.id AND a.operator_id = ?
         WHERE l.active = 1 AND (a.operator_id IS NOT NULL OR l.is_default = 1)
         ORDER BY CASE WHEN a.operator_id IS NOT NULL THEN 0 ELSE 1 END, l.id
         LIMIT 1`,
        [operatorId],
      ),
      query<any>(
        `SELECT
           COALESCE(SUM(CASE WHEN status <> 'void' THEN rate_minor ELSE 0 END), 0) AS lifetime_minor,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN rate_minor ELSE 0 END), 0) AS pending_minor,
           COALESCE(SUM(CASE WHEN status = 'paid' THEN rate_minor ELSE 0 END), 0) AS paid_minor,
           COALESCE(SUM(CASE WHEN status <> 'void' AND created_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') THEN rate_minor ELSE 0 END), 0) AS current_month_minor,
           COUNT(CASE WHEN status <> 'void' THEN 1 END) AS total_messages
         FROM operator_earnings
         WHERE operator_id = ?`,
        [operatorId],
      ),
      query<any>(
        `SELECT e.id, e.message_id, e.level_id, l.name AS level_name, e.rate_minor, e.currency,
            e.status, e.paid_at, e.created_at
         FROM operator_earnings e
         JOIN operator_levels l ON l.id = e.level_id
         WHERE e.operator_id = ?
         ORDER BY e.created_at DESC
         LIMIT 100`,
        [operatorId],
      ),
    ])
    res.json({
      level: level ? {
        id: Number(level.id),
        name: level.name,
        description: level.description || "",
        rateMinor: Number(level.rate_minor || 0),
        currency: String(level.currency || "EUR").toUpperCase(),
      } : null,
      schedule,
      summary: {
        currentMonthMinor: Number(summary?.current_month_minor || 0),
        pendingMinor: Number(summary?.pending_minor || 0),
        paidMinor: Number(summary?.paid_minor || 0),
        lifetimeMinor: Number(summary?.lifetime_minor || 0),
        totalMessages: Number(summary?.total_messages || 0),
      },
      recent: recent.map((row) => ({
        id: Number(row.id),
        messageId: Number(row.message_id),
        levelName: row.level_name,
        rateMinor: Number(row.rate_minor || 0),
        currency: String(row.currency || "EUR").toUpperCase(),
        status: row.status,
        paidAt: row.paid_at,
        createdAt: row.created_at,
      })),
    })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Earnings unavailable" })
  }
})

router.get("/admin/applications", requireChatmodzAuth, requireChatmodzAdmin, async (_req, res) => {
  if (isDemoMode()) return res.json({ applications: demoApplications, demo: true })
  try {
    res.json({
      applications: await query(
        `SELECT a.id, a.full_name, a.email, a.location, a.experience, a.status, a.created_at, a.reviewed_at,
                o.id AS operator_id, o.role AS operator_role, o.status AS operator_status
         FROM operator_applications a
         LEFT JOIN operators o ON LOWER(o.email) = LOWER(a.email)
         ORDER BY a.created_at DESC
         LIMIT 200`,
      ),
    })
  }
  catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Applications unavailable" }) }
})

router.post("/admin/applications/:id/approve", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const applicationId = Number(req.params.id)
  try {
    const applications = await query<any>("SELECT * FROM operator_applications WHERE id = ? LIMIT 1", [applicationId])
    const application = applications[0]
    if (!application) return res.status(404).json({ error: "Application not found" })
    if (application.status !== "pending") return res.status(409).json({ error: "This application has already been reviewed. Use the activation-code action to issue a replacement." })
    const existing = await query<any>("SELECT id FROM operators WHERE email = ? LIMIT 1", [application.email])
    if (existing.length) return res.status(409).json({ error: "An operator already uses this email" })
    const operatorPublicId = crypto.randomBytes(13).toString("base64url")
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12)
    const activationCode = `cmz-${crypto.randomBytes(18).toString("base64url")}`
    await withTransaction(async (connection) => {
      const created: any = await connection.execute("INSERT INTO operators (public_id, full_name, email, password_hash, role, status) VALUES (?, ?, ?, ?, 'operator', 'training')", [operatorPublicId, application.full_name, application.email, passwordHash])
      const operatorId = Number(created[0].insertId)
      await connection.execute("INSERT INTO operator_activation_codes (operator_id, code_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 72 HOUR))", [operatorId, sha256(activationCode)])
      await connection.execute("UPDATE operator_applications SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [req.chatmodzOperator!.id, applicationId])
    })
    res.json({ approved: true, activationCode, expiresInHours: 72 })
  } catch (error: any) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Could not approve application" })
  }
})

router.post("/admin/applications/:id/activation-code", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const applicationId = Number(req.params.id)
  if (!Number.isSafeInteger(applicationId) || applicationId < 1) return res.status(400).json({ error: "Invalid application" })
  const activationCode = `cmz-${crypto.randomBytes(18).toString("base64url")}`
  const placeholderPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12)
  try {
    await withTransaction(async (connection) => {
      const [applicationRows] = await connection.execute<any[]>(
        "SELECT id, full_name, email, status FROM operator_applications WHERE id = ? FOR UPDATE",
        [applicationId],
      )
      const application = applicationRows[0]
      if (!application) throw new AdminActionError("Application not found", 404)
      if (application.status !== "approved") throw new AdminActionError("Only approved applications can receive a replacement activation code", 409)

      const [operatorRows] = await connection.execute<any[]>(
        "SELECT id, role, status FROM operators WHERE email = ? LIMIT 1 FOR UPDATE",
        [application.email],
      )
      let operatorId = Number(operatorRows[0]?.id || 0)
      if (operatorRows[0]) {
        if (operatorRows[0].role !== "operator" || operatorRows[0].status !== "training") {
          throw new AdminActionError("This account is no longer awaiting activation. Use the operator status or account-recovery process instead.", 409)
        }
        const [usedCodes] = await connection.execute<any[]>(
          "SELECT id FROM operator_activation_codes WHERE operator_id = ? AND used_at IS NOT NULL LIMIT 1",
          [operatorId],
        )
        if (usedCodes.length) throw new AdminActionError("This account has already used an activation code and cannot receive another.", 409)
      } else {
        const [created] = await connection.execute<any>(
          "INSERT INTO operators (public_id, full_name, email, password_hash, role, status) VALUES (?, ?, ?, ?, 'operator', 'training')",
          [crypto.randomBytes(13).toString("base64url"), application.full_name, application.email, placeholderPasswordHash],
        )
        operatorId = Number(created.insertId)
      }

      await connection.execute(
        "UPDATE operator_activation_codes SET revoked_at = NOW() WHERE operator_id = ? AND used_at IS NULL AND revoked_at IS NULL",
        [operatorId],
      )
      await connection.execute(
        "INSERT INTO operator_activation_codes (operator_id, code_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 72 HOUR))",
        [operatorId, sha256(activationCode)],
      )
      await connection.execute(
        "INSERT INTO audit_log (actor_operator_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'reissue_activation_code', 'operator', ?, ?)",
        [req.chatmodzOperator!.id, operatorId, JSON.stringify({ applicationId })],
      )
    })
    res.json({ activationCode, expiresInHours: 72 })
  } catch (error) {
    if (error instanceof AdminActionError) return res.status(error.statusCode).json({ error: error.message })
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not issue a replacement activation code" })
  }
})

router.delete("/admin/applications/:id", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const applicationId = Number(req.params.id)
  if (!Number.isSafeInteger(applicationId) || applicationId < 1) return res.status(400).json({ error: "Invalid application" })
  try {
    const [applicationRows] = await query<any>(
      "SELECT id, full_name, email FROM operator_applications WHERE id = ? LIMIT 1",
      [applicationId],
    )
    const application = applicationRows
    if (!application) return res.status(404).json({ error: "Application not found" })

    let accountRemoved = false
    await withTransaction(async (connection) => {
      const [lockedApplications] = await connection.execute<any[]>(
        "SELECT id, full_name, email FROM operator_applications WHERE id = ? FOR UPDATE",
        [applicationId],
      )
      const lockedApplication = lockedApplications[0]
      if (!lockedApplication) throw new AdminActionError("Application not found", 404)

      const [operatorRows] = await connection.execute<any[]>(
        "SELECT id, role, status FROM operators WHERE email = ? LIMIT 1 FOR UPDATE",
        [lockedApplication.email],
      )
      const operator = operatorRows[0]
      if (operator) {
        if (operator.role !== "operator" || operator.status !== "training") {
          throw new AdminActionError("Only an unactivated training account can be deleted with its application. Suspend an activated account instead.", 409)
        }
        const operatorId = Number(operator.id)
        const [usedCodes] = await connection.execute<any[]>(
          "SELECT id FROM operator_activation_codes WHERE operator_id = ? AND used_at IS NOT NULL LIMIT 1",
          [operatorId],
        )
        const [earnings] = await connection.execute<any[]>(
          "SELECT id FROM operator_earnings WHERE operator_id = ? LIMIT 1",
          [operatorId],
        )
        const [sentMessages] = await connection.execute<any[]>(
          "SELECT id FROM messages WHERE sent_by_operator_id = ? LIMIT 1",
          [operatorId],
        )
        const [assignments] = await connection.execute<any[]>(
          "SELECT id FROM conversation_assignments WHERE operator_id = ? LIMIT 1",
          [operatorId],
        )
        const [claimedConversations] = await connection.execute<any[]>(
          "SELECT id FROM conversations WHERE assigned_operator_id = ? LIMIT 1",
          [operatorId],
        )
        const [activities] = await connection.execute<any[]>(
          "SELECT id FROM operator_activity WHERE operator_id = ? LIMIT 1",
          [operatorId],
        )
        if (usedCodes.length || earnings.length || sentMessages.length || assignments.length || claimedConversations.length || activities.length) {
          throw new AdminActionError("This account has activation or work history and cannot be deleted. Suspend it from the Operators tab instead.", 409)
        }

        await connection.execute(
          "INSERT INTO audit_log (actor_operator_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'delete_unactivated_operator', 'operator', ?, ?)",
          [req.chatmodzOperator!.id, operatorId, JSON.stringify({ applicationId })],
        )
        await connection.execute("DELETE FROM operators WHERE id = ?", [operatorId])
        accountRemoved = true
      }

      await connection.execute(
        "INSERT INTO audit_log (actor_operator_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'delete_operator_application', 'operator_application', ?, ?)",
        [req.chatmodzOperator!.id, applicationId, JSON.stringify({ accountRemoved: Boolean(operator) })],
      )
      await connection.execute("DELETE FROM operator_applications WHERE id = ?", [applicationId])
    })
    res.json({ deleted: true, accountRemoved })
  } catch (error) {
    if (error instanceof AdminActionError) return res.status(error.statusCode).json({ error: error.message })
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not delete application" })
  }
})

router.post("/admin/applications/:id/reject", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  try {
    await query("UPDATE operator_applications SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [req.chatmodzOperator!.id, Number(req.params.id)])
    res.json({ rejected: true })
  } catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not reject application" }) }
})

router.get("/admin/operators", requireChatmodzAuth, requireChatmodzAdmin, async (_req, res) => {
  if (isDemoMode()) return res.json({
    operators: getDemoAccounts().map((operator) => ({
      ...operator,
      last_active_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })),
    demo: true,
  })
  try { res.json({ operators: await query("SELECT id, public_id, full_name, email, role, status, last_active_at, created_at FROM operators ORDER BY created_at DESC") }) }
  catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Operators unavailable" }) }
})

router.post("/admin/operators/:id/status", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const status = String(req.body?.status || "")
  if (!["training", "active", "suspended", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid operator status" })
  try {
    const operatorId = Number(req.params.id)
    if (isDemoMode()) {
      const target = getDemoAccounts().find((operator) => operator.id === operatorId)
      if (!target || target.role !== "operator") return res.status(404).json({ error: "Operator not found" })
      if (status === "active" && latestDemoAssessment(operatorId)?.status !== "approved") {
        return res.status(409).json({ error: "Operators must pass and receive approval for the assessment before becoming active." })
      }
      target.status = status
      return res.json({ updated: true, demo: true })
    }
    const target = await query<any>("SELECT id, role FROM operators WHERE id = ? LIMIT 1", [operatorId])
    if (!target[0]) return res.status(404).json({ error: "Operator not found" })
    if (target[0].role === "operator" && status === "active") {
      const assessment = await latestAssessment(operatorId)
      if (assessment?.status !== "approved") return res.status(409).json({ error: "Operators must pass and receive approval for the assessment before becoming active." })
    }
    await query("UPDATE operators SET status = ? WHERE id = ?", [status, operatorId])
    res.json({ updated: true })
  }
  catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not update operator" }) }
})

router.post("/admin/operators/:id/role", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const operatorId = Number(req.params.id)
  const role = String(req.body?.role || "")
  if (!operatorId || !["operator", "recruiter"].includes(role)) return res.status(400).json({ error: "Choose operator or recruiter" })
  if (operatorId === req.chatmodzOperator!.id) return res.status(400).json({ error: "Your administrator role cannot be changed here" })
  if (isDemoMode()) {
    const target = getDemoAccounts().find((operator) => operator.id === operatorId)
    if (!target || target.role === "admin") return res.status(404).json({ error: "Operator not found" })
    target.role = role as Operator["role"]
    const recruiterRecord = demoRecruiterOperators.find((operator) => Number(operator.id) === operatorId)
    if (role === "recruiter") {
      for (const operator of demoRecruiterOperators) {
        if (Number(operator.recruiter_id) === operatorId) {
          operator.recruiter_id = null
          operator.recruiter_name = null
        }
      }
      if (recruiterRecord) demoRecruiterOperators.splice(demoRecruiterOperators.indexOf(recruiterRecord), 1)
    } else if (!recruiterRecord) {
      demoRecruiterOperators.unshift({
        id: target.id,
        public_id: target.public_id,
        full_name: target.full_name,
        email: target.email,
        role: "operator",
        status: target.status,
        recruiter_id: 3,
        recruiter_name: "Demo Recruiter",
        last_active_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        activity_count: 0,
        replies: 0,
      })
    } else {
      recruiterRecord.role = "operator"
      recruiterRecord.status = target.status
    }
    return res.json({ updated: true, demo: true })
  }
  try {
    await withTransaction(async (connection) => {
      await connection.execute("UPDATE operators SET recruiter_id = NULL WHERE recruiter_id = ?", [operatorId])
      const result: any = await connection.execute("UPDATE operators SET role = ? WHERE id = ? AND role <> 'admin'", [role, operatorId])
      if (!Number(result[0]?.affectedRows || 0)) throw Object.assign(new Error("Operator not found"), { code: "NOT_FOUND" })
      await connection.execute("INSERT INTO audit_log (actor_operator_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'change_operator_role', 'operator', ?, ?)", [req.chatmodzOperator!.id, operatorId, JSON.stringify({ role })])
    })
    res.json({ updated: true })
  } catch (error: any) {
    if (error?.code === "NOT_FOUND") return res.status(404).json({ error: "Operator not found" })
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not update operator role" })
  }
})

function recruiterOverviewDemo(viewer: Operator) {
  const recruiters = getDemoAccounts().filter((operator) => operator.role === "recruiter")
  const operators = viewer.role === "admin"
    ? demoRecruiterOperators
    : demoRecruiterOperators.filter((operator) => Number(operator.recruiter_id) === viewer.id)
  const activities = viewer.role === "admin"
    ? demoRecruiterActivity
    : demoRecruiterActivity.filter((activity) => Number(activity.recruiter_id) === viewer.id || Number(activity.operator_id) === viewer.id)
  return {
    recruiters: recruiters.map((recruiter) => ({
      id: recruiter.id,
      full_name: recruiter.full_name,
      email: recruiter.email,
      status: recruiter.status,
      last_active_at: new Date().toISOString(),
      recruited_count: demoRecruiterOperators.filter((operator) => Number(operator.recruiter_id) === recruiter.id).length,
      activity_count: activities.filter((activity) => Number(activity.operator_id) === recruiter.id).length,
    })),
    operators,
    activities,
    summary: { recruiters: viewer.role === "admin" ? recruiters.length : 0, operators: operators.length, active: operators.filter((operator) => operator.status === "active").length, activities: activities.length },
    demo: true,
  }
}

router.get("/recruiter/overview", requireChatmodzAuth, requireChatmodzRecruiter, async (req, res) => {
  const viewer = req.chatmodzOperator!
  if (isDemoMode()) return res.json(recruiterOverviewDemo(viewer))
  try {
    const operatorFilter = viewer.role === "admin" ? "" : "WHERE o.recruiter_id = ?"
    const operatorParams = viewer.role === "admin" ? [] : [viewer.id]
    const operatorsPromise = query<any>(
      `SELECT o.id, o.public_id, o.full_name, o.email, o.role, o.status, o.recruiter_id,
          r.full_name AS recruiter_name, o.last_active_at, o.created_at,
          COUNT(DISTINCT a.id) AS activity_count,
          COUNT(DISTINCT CASE WHEN a.activity_type = 'reply' THEN a.id END) AS replies
       FROM operators o
       LEFT JOIN operators r ON r.id = o.recruiter_id
       LEFT JOIN operator_activity a ON a.operator_id = o.id
       ${operatorFilter ? `${operatorFilter} AND` : "WHERE"} o.role = 'operator'
       GROUP BY o.id, o.public_id, o.full_name, o.email, o.role, o.status, o.recruiter_id, r.full_name, o.last_active_at, o.created_at
       ORDER BY o.created_at DESC`,
      operatorParams,
    )
    const activityFilter = viewer.role === "admin" ? "" : "WHERE a.operator_id = ? OR o.recruiter_id = ?"
    const activityParams = viewer.role === "admin" ? [] : [viewer.id, viewer.id]
    const activitiesPromise = query<any>(
      `SELECT a.id, a.operator_id, o.full_name AS operator_name, o.recruiter_id,
          r.full_name AS recruiter_name, a.activity_type, a.conversation_id,
          s.display_name AS site_name, a.metadata_json, a.created_at
       FROM operator_activity a
       JOIN operators o ON o.id = a.operator_id
       LEFT JOIN operators r ON r.id = o.recruiter_id
       LEFT JOIN sites s ON s.id = a.site_id
       ${activityFilter}
       ORDER BY a.created_at DESC LIMIT 250`,
      activityParams,
    )
    const recruitersPromise = viewer.role === "admin"
      ? query<any>(
        `SELECT r.id, r.full_name, r.email, r.status, r.last_active_at,
            COUNT(DISTINCT o.id) AS recruited_count,
            COUNT(DISTINCT a.id) AS activity_count
         FROM operators r
         LEFT JOIN operators o ON o.recruiter_id = r.id
         LEFT JOIN operator_activity a ON a.operator_id = r.id
         WHERE r.role = 'recruiter'
         GROUP BY r.id, r.full_name, r.email, r.status, r.last_active_at
         ORDER BY r.created_at DESC`,
      )
      : Promise.resolve<any[]>([])
    const [operators, activities, recruiters] = await Promise.all([operatorsPromise, activitiesPromise, recruitersPromise])
    res.json({
      recruiters,
      operators,
      activities,
      summary: {
        recruiters: recruiters.length,
        operators: operators.length,
        active: operators.filter((operator) => operator.status === "active").length,
        activities: activities.length,
      },
    })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Recruiter overview unavailable" })
  }
})

router.post("/recruiter/operators", requireChatmodzAuth, requireChatmodzRecruiter, async (req, res) => {
  const fullName = String(req.body?.fullName || "").trim().slice(0, 160)
  const email = String(req.body?.email || "").trim().toLowerCase()
  if (!fullName || !email.includes("@")) return res.status(400).json({ error: "Full name and a valid email are required" })
  const recruiterId = req.chatmodzOperator!.role === "recruiter" ? req.chatmodzOperator!.id : Number(req.body?.recruiterId || 0)
  if (!recruiterId) return res.status(400).json({ error: "Choose a recruiter for this operator" })
  if (isDemoMode()) {
    const id = Math.max(0, ...demoRecruiterOperators.map((operator) => Number(operator.id))) + 1
    const activationCode = `cmz-demo-${crypto.randomBytes(10).toString("hex")}`
    demoRecruiterOperators.unshift({ id, public_id: `demo-operator-${id}`, full_name: fullName, email, role: "operator", status: "training", recruiter_id: recruiterId, recruiter_name: req.chatmodzOperator!.role === "recruiter" ? req.chatmodzOperator!.full_name : "Demo Recruiter", last_active_at: null, created_at: new Date().toISOString(), activity_count: 0, replies: 0 })
    return res.status(201).json({ recruited: true, activationCode, expiresInHours: 72, demo: true })
  }
  try {
    const recruiter = await query<any>("SELECT id FROM operators WHERE id = ? AND role = 'recruiter' LIMIT 1", [recruiterId])
    if (!recruiter[0]) return res.status(404).json({ error: "Recruiter not found" })
    const existing = await query<any>("SELECT id FROM operators WHERE email = ? LIMIT 1", [email])
    if (existing[0]) return res.status(409).json({ error: "An operator already uses this email" })
    const operatorPublicId = crypto.randomBytes(13).toString("base64url")
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12)
    const activationCode = `cmz-${crypto.randomBytes(18).toString("base64url")}`
    await withTransaction(async (connection) => {
      const created: any = await connection.execute(
        "INSERT INTO operators (public_id, full_name, email, password_hash, role, status, recruiter_id) VALUES (?, ?, ?, ?, 'operator', 'training', ?)",
        [operatorPublicId, fullName, email, passwordHash, recruiterId],
      )
      await connection.execute("INSERT INTO operator_activation_codes (operator_id, code_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 72 HOUR))", [created[0].insertId, sha256(activationCode)])
      await connection.execute("INSERT INTO operator_activity (operator_id, activity_type, metadata_json) VALUES (?, 'training', ?)", [created[0].insertId, JSON.stringify({ recruitedBy: recruiterId })])
      await connection.execute("INSERT INTO audit_log (actor_operator_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'recruit_operator', 'operator', ?, ?)", [req.chatmodzOperator!.id, created[0].insertId, JSON.stringify({ recruiterId })])
    })
    res.status(201).json({ recruited: true, activationCode, expiresInHours: 72 })
  } catch (error: any) {
    if (!failConfiguration(res, error)) res.status(error?.code === "ER_DUP_ENTRY" ? 409 : 500).json({ error: error?.code === "ER_DUP_ENTRY" ? "An operator already uses this email" : "Could not recruit operator" })
  }
})

router.post("/recruiter/operators/:id/status", requireChatmodzAuth, requireChatmodzRecruiter, async (req, res) => {
  const operatorId = Number(req.params.id)
  const status = String(req.body?.status || "")
  if (!["training", "active", "suspended", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid operator status" })
  if (isDemoMode()) {
    const operator = demoRecruiterOperators.find((item) => Number(item.id) === operatorId && (req.chatmodzOperator!.role === "admin" || Number(item.recruiter_id) === req.chatmodzOperator!.id))
    if (!operator) return res.status(404).json({ error: "Operator not found in your team" })
    if (status === "active" && latestDemoAssessment(operatorId)?.status !== "approved") {
      return res.status(409).json({ error: "Operators must pass and receive approval for the assessment before becoming active." })
    }
    operator.status = status
    return res.json({ updated: true, demo: true })
  }
  try {
    const owned = req.chatmodzOperator!.role === "admin"
      ? await query<any>("SELECT id FROM operators WHERE id = ? AND role = 'operator' LIMIT 1", [operatorId])
      : await query<any>("SELECT id FROM operators WHERE id = ? AND role = 'operator' AND recruiter_id = ? LIMIT 1", [operatorId, req.chatmodzOperator!.id])
    if (!owned[0]) return res.status(404).json({ error: "Operator not found in your team" })
    if (status === "active") {
      const assessment = await latestAssessment(operatorId)
      if (assessment?.status !== "approved") return res.status(409).json({ error: "Operators must pass and receive approval for the assessment before becoming active." })
    }
    await query("UPDATE operators SET status = ? WHERE id = ?", [status, operatorId])
    await recordActivity(operatorId, "training", undefined, undefined, { changedBy: req.chatmodzOperator!.id, status })
    await query("INSERT INTO audit_log (actor_operator_id, action, entity_type, entity_id, metadata_json) VALUES (?, 'change_operator_status', 'operator', ?, ?)", [req.chatmodzOperator!.id, operatorId, JSON.stringify({ status })])
    res.json({ updated: true })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not update operator status" })
  }
})

router.get("/admin/compensation", requireChatmodzAuth, requireChatmodzAdmin, async (_req, res) => {
  if (isDemoMode()) {
    const operators = [demoOperator("admin"), demoOperator("operator")].map((operator) => {
      const level = demoLevels.find((item) => item.id === demoOperatorLevels.get(operator.id))
      return compensationOperator({
        ...operator,
        level_id: level?.id || null,
        level_name: level?.name || null,
        rate_minor: level?.rate_minor ?? null,
        level_currency: level?.currency || null,
        earned_minor: 0,
        earned_messages: 0,
      })
    })
    return res.json({
      levels: demoLevels.map(compensationLevel),
      operators,
      summary: { totalMessages: 0, accruedMinor: 0, paidMinor: 0, pendingMinor: 0 },
      byLevel: demoLevels.map((level) => ({ id: level.id, name: level.name, messages: 0, accruedMinor: 0 })),
      recent: demoEarnings,
      demo: true,
    })
  }
  try {
    const [levels, operators, [summary], byLevel, recent] = await Promise.all([
      query<any>(
        `SELECT l.*, COUNT(DISTINCT a.operator_id) AS assigned_operators
         FROM operator_levels l
         LEFT JOIN operator_level_assignments a ON a.level_id = l.id
         GROUP BY l.id, l.name, l.slug, l.description, l.rate_minor, l.currency, l.is_default, l.active, l.created_at, l.updated_at
         ORDER BY l.rate_minor ASC, l.id ASC`,
      ),
      query<any>(
        `SELECT o.id, o.full_name, o.email, o.role, o.status,
            l.id AS level_id, l.name AS level_name, l.rate_minor, l.currency AS level_currency,
            COALESCE(SUM(CASE WHEN e.status <> 'void' THEN e.rate_minor ELSE 0 END), 0) AS earned_minor,
            COUNT(CASE WHEN e.status <> 'void' THEN e.id END) AS earned_messages
         FROM operators o
         LEFT JOIN operator_level_assignments a ON a.operator_id = o.id
         LEFT JOIN operator_levels l ON l.id = a.level_id
         LEFT JOIN operator_earnings e ON e.operator_id = o.id
         GROUP BY o.id, o.full_name, o.email, o.role, o.status, l.id, l.name, l.rate_minor, l.currency
         ORDER BY MAX(o.created_at) DESC`,
      ),
      query<any>(
        `SELECT
           COUNT(CASE WHEN status <> 'void' THEN 1 END) AS total_messages,
           COALESCE(SUM(CASE WHEN status <> 'void' THEN rate_minor ELSE 0 END), 0) AS accrued_minor,
           COALESCE(SUM(CASE WHEN status = 'paid' THEN rate_minor ELSE 0 END), 0) AS paid_minor,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN rate_minor ELSE 0 END), 0) AS pending_minor
         FROM operator_earnings`,
      ),
      query<any>(
        `SELECT l.id, l.name,
            COUNT(CASE WHEN e.status <> 'void' THEN e.id END) AS messages,
            COALESCE(SUM(CASE WHEN e.status <> 'void' THEN e.rate_minor ELSE 0 END), 0) AS accrued_minor
         FROM operator_levels l
         LEFT JOIN operator_earnings e ON e.level_id = l.id
         GROUP BY l.id, l.name
         ORDER BY l.rate_minor ASC, l.id ASC`,
      ),
      query<any>(
        `SELECT e.id, e.message_id, e.operator_id, o.full_name AS operator_name,
            e.level_id, l.name AS level_name, e.rate_minor, e.currency, e.status,
            e.paid_at, e.created_at, m.conversation_id
         FROM operator_earnings e
         JOIN operators o ON o.id = e.operator_id
         JOIN operator_levels l ON l.id = e.level_id
         JOIN messages m ON m.id = e.message_id
         ORDER BY e.created_at DESC
         LIMIT 100`,
      ),
    ])
    res.json({
      levels: levels.map(compensationLevel),
      operators: operators.map(compensationOperator),
      summary: {
        totalMessages: Number(summary?.total_messages || 0),
        accruedMinor: Number(summary?.accrued_minor || 0),
        paidMinor: Number(summary?.paid_minor || 0),
        pendingMinor: Number(summary?.pending_minor || 0),
      },
      byLevel: byLevel.map((row) => ({ id: Number(row.id), name: row.name, messages: Number(row.messages || 0), accruedMinor: Number(row.accrued_minor || 0) })),
      recent: recent.map((row) => ({
        id: Number(row.id),
        messageId: Number(row.message_id),
        operatorId: Number(row.operator_id),
        operatorName: row.operator_name,
        levelId: Number(row.level_id),
        levelName: row.level_name,
        rateMinor: Number(row.rate_minor),
        currency: row.currency,
        status: row.status,
        paidAt: row.paid_at,
        createdAt: row.created_at,
        conversationId: Number(row.conversation_id),
      })),
    })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Compensation data unavailable" })
  }
})

router.post("/admin/levels", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 120)
  const description = String(req.body?.description || "").trim().slice(0, 500) || null
  const slug = slugify(String(req.body?.slug || name))
  const rateMinor = rateToMinor(req.body?.rate)
  const currency = String(req.body?.currency || "EUR").trim().toUpperCase()
  const isDefault = Boolean(req.body?.isDefault)
  if (!name || !slug || rateMinor === null || !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: "Name, a valid non-negative rate, and a 3-letter currency are required" })
  if (isDemoMode()) {
    if (demoLevels.some((level) => level.slug === slug)) return res.status(409).json({ error: "That level already exists" })
    const id = Math.max(...demoLevels.map((level) => level.id), 0) + 1
    if (isDefault) demoLevels.forEach((level) => { level.is_default = false })
    demoLevels.push({ id, name, slug, description: description || "", rate_minor: rateMinor, currency, is_default: isDefault, active: true, assigned_operators: 0 })
    return res.status(201).json({ level: compensationLevel(demoLevels[demoLevels.length - 1]) })
  }
  try {
    const result = await withTransaction(async (connection) => {
      if (isDefault) await connection.execute("UPDATE operator_levels SET is_default = 0")
      const created: any = await connection.execute(
        "INSERT INTO operator_levels (name, slug, description, rate_minor, currency, is_default) VALUES (?, ?, ?, ?, ?, ?)",
        [name, slug, description, rateMinor, currency, isDefault ? 1 : 0],
      )
      return Number(created[0].insertId)
    })
    const [level] = await query<any>("SELECT * FROM operator_levels WHERE id = ?", [result])
    res.status(201).json({ level: compensationLevel(level) })
  } catch (error: any) {
    if (failConfiguration(res, error)) return
    res.status(error?.code === "ER_DUP_ENTRY" ? 409 : 500).json({ error: error?.code === "ER_DUP_ENTRY" ? "That level already exists" : "Could not create level" })
  }
})

router.put("/admin/levels/:id", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const name = String(req.body?.name || "").trim().slice(0, 120)
  const description = String(req.body?.description || "").trim().slice(0, 500) || null
  const rateMinor = rateToMinor(req.body?.rate)
  const currency = String(req.body?.currency || "EUR").trim().toUpperCase()
  const active = req.body?.active !== false
  const isDefault = Boolean(req.body?.isDefault)
  if (!id || !name || rateMinor === null || !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: "Name, a valid non-negative rate, and a 3-letter currency are required" })
  if (isDemoMode()) {
    const level = demoLevels.find((item) => item.id === id)
    if (!level) return res.status(404).json({ error: "Level not found" })
    if (isDefault) demoLevels.forEach((item) => { item.is_default = item.id === id })
    Object.assign(level, { name, description: description || "", rate_minor: rateMinor, currency, active, is_default: isDefault })
    return res.json({ level: compensationLevel(level) })
  }
  try {
    await withTransaction(async (connection) => {
      if (isDefault) await connection.execute("UPDATE operator_levels SET is_default = 0")
      const result: any = await connection.execute(
        "UPDATE operator_levels SET name = ?, description = ?, rate_minor = ?, currency = ?, active = ?, is_default = ? WHERE id = ?",
        [name, description, rateMinor, currency, active ? 1 : 0, isDefault ? 1 : 0, id],
      )
      if (!Number(result[0].affectedRows)) throw Object.assign(new Error("Level not found"), { code: "NOT_FOUND" })
    })
    const [level] = await query<any>("SELECT * FROM operator_levels WHERE id = ?", [id])
    res.json({ level: compensationLevel(level) })
  } catch (error: any) {
    if (error?.code === "NOT_FOUND") return res.status(404).json({ error: "Level not found" })
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not update level" })
  }
})

router.post("/admin/operators/:id/level", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const operatorId = Number(req.params.id)
  const levelId = Number(req.body?.levelId)
  if (!operatorId || !levelId) return res.status(400).json({ error: "A valid operator and level are required" })
  if (isDemoMode()) {
    if (!demoLevels.some((level) => level.id === levelId && level.active)) return res.status(404).json({ error: "Active level not found" })
    demoOperatorLevels.set(operatorId, levelId)
    return res.json({ assigned: true })
  }
  try {
    const levels = await query<any>("SELECT id FROM operator_levels WHERE id = ? AND active = 1 LIMIT 1", [levelId])
    if (!levels[0]) return res.status(404).json({ error: "Active level not found" })
    await query(
      "INSERT INTO operator_level_assignments (operator_id, level_id, assigned_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE level_id = VALUES(level_id), assigned_by = VALUES(assigned_by), updated_at = CURRENT_TIMESTAMP",
      [operatorId, levelId, req.chatmodzOperator!.id],
    )
    await recordActivity(req.chatmodzOperator!.id, "training", undefined, undefined, { operatorId, levelId, action: "level_assigned" })
    res.json({ assigned: true })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not assign operator level" })
  }
})

router.post("/admin/earnings/:id/status", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const status = String(req.body?.status || "")
  if (!id || !["pending", "paid", "void"].includes(status)) return res.status(400).json({ error: "Invalid earnings status" })
  if (isDemoMode()) {
    const earning = demoEarnings.find((item) => item.id === id)
    if (!earning) return res.status(404).json({ error: "Earning record not found" })
    earning.status = status
    earning.paidAt = status === "paid" ? new Date().toISOString() : null
    return res.json({ updated: true, earning })
  }
  try {
    const result: any = await database().execute("UPDATE operator_earnings SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN NOW() ELSE NULL END WHERE id = ?", [status, status, id])
    if (!Number(result[0]?.affectedRows || 0)) return res.status(404).json({ error: "Earning record not found" })
    res.json({ updated: true })
  } catch (error) {
    if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not update earnings status" })
  }
})

router.get("/admin/sites", requireChatmodzAuth, requireChatmodzAdmin, async (_req, res) => {
  if (isDemoMode()) return res.json({ sites: [], demo: true })
  try { res.json({ sites: await query("SELECT id, internal_name, display_name, status, integration_type, endpoint_base_url, secret_env_key, created_at, updated_at FROM sites ORDER BY created_at DESC") }) }
  catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Sites unavailable" }) }
})

router.post("/admin/sites", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const { internalName, displayName, endpointBaseUrl, secretEnvKey, integrationType = "hybrid" } = req.body || {}
  if (!/^[a-z0-9_-]{2,120}$/.test(String(internalName || "")) || !String(displayName || "").trim() || !/^[A-Z_][A-Z0-9_]*$/.test(String(secretEnvKey || ""))) return res.status(400).json({ error: "Internal name, display name, and an uppercase secret environment key are required" })
  if (!["webhook", "api", "hybrid"].includes(String(integrationType))) return res.status(400).json({ error: "Invalid integration type" })
  try {
    const configuredSecret = process.env[String(secretEnvKey)] || ""
    if (!configuredSecret) return res.status(400).json({ error: `Environment secret ${secretEnvKey} is not configured` })
    await query("INSERT INTO sites (internal_name, display_name, endpoint_base_url, secret_env_key, signing_secret_hash, integration_type) VALUES (?, ?, ?, ?, ?, ?)", [internalName, displayName.trim(), String(endpointBaseUrl || "").trim() || null, secretEnvKey, configuredSecret ? sha256(configuredSecret) : null, integrationType])
    res.status(201).json({ created: true })
  } catch (error: any) {
    if (failConfiguration(res, error)) return
    res.status(error?.code === "ER_DUP_ENTRY" ? 409 : 500).json({ error: error?.code === "ER_DUP_ENTRY" ? "Site already exists" : "Could not create site" })
  }
})

async function updateConnectedSite(req: Request, res: Response) {
  const id = Number(req.params.id)
  const { internalName, displayName, endpointBaseUrl, secretEnvKey, integrationType = "hybrid" } = req.body || {}
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid site id" })
  if (!/^[a-z0-9_-]{2,120}$/.test(String(internalName || "")) || !String(displayName || "").trim() || !/^[A-Z_][A-Z0-9_]*$/.test(String(secretEnvKey || ""))) return res.status(400).json({ error: "Internal name, display name, and an uppercase secret environment key are required" })
  if (!["webhook", "api", "hybrid"].includes(String(integrationType))) return res.status(400).json({ error: "Invalid integration type" })
  try {
    const configuredSecret = process.env[String(secretEnvKey)] || ""
    if (!configuredSecret) return res.status(400).json({ error: `Environment secret ${secretEnvKey} is not configured` })
    const result: any = await database().execute(
      "UPDATE sites SET internal_name = ?, display_name = ?, endpoint_base_url = ?, secret_env_key = ?, signing_secret_hash = ?, integration_type = ? WHERE id = ?",
      [String(internalName), String(displayName).trim(), String(endpointBaseUrl || "").trim() || null, String(secretEnvKey), sha256(configuredSecret), String(integrationType), id],
    )
    if (!Number(result[0]?.affectedRows || 0)) return res.status(404).json({ error: "Connected site not found" })
    res.json({ updated: true })
  } catch (error: any) {
    if (failConfiguration(res, error)) return
    res.status(error?.code === "ER_DUP_ENTRY" ? 409 : 500).json({ error: error?.code === "ER_DUP_ENTRY" ? "A site with that internal name already exists" : "Could not update site" })
  }
}

router.put("/admin/sites/:id", requireChatmodzAuth, requireChatmodzAdmin, updateConnectedSite)
router.post("/admin/sites/:id/settings", requireChatmodzAuth, requireChatmodzAdmin, updateConnectedSite)

router.post("/admin/sites/:id/status", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const status = String(req.body?.status || "")
  if (!["active", "paused", "disconnected"].includes(status)) return res.status(400).json({ error: "Invalid site status" })
  try { await query("UPDATE sites SET status = ? WHERE id = ?", [status, Number(req.params.id)]); res.json({ updated: true }) }
  catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not update site" }) }
})

router.get("/admin/report", requireChatmodzAuth, requireChatmodzAdmin, async (_req, res) => {
  if (isDemoMode()) return res.json({ summary: { conversations: 0, replies: 0, failed_deliveries: 0 }, byOperator: [{ id: 1, name: demoOperator().full_name, replies: 0 }], bySite: [], demo: true })
  try {
    const [[summary], byOperator, bySite] = await Promise.all([
      query<any>(
        `SELECT
           (SELECT COUNT(*) FROM conversations) AS conversations,
           (SELECT COUNT(*) FROM messages WHERE sender_type = 'managed_profile') AS replies,
           (SELECT COUNT(*) FROM integration_deliveries WHERE status = 'failed') AS failed_deliveries`,
      ),
      query(
        `SELECT o.id, o.full_name AS name, COUNT(m.id) AS replies
         FROM operators o
         LEFT JOIN messages m ON m.sent_by_operator_id = o.id
         GROUP BY o.id, o.full_name
         ORDER BY replies DESC`,
      ),
      query(
        `SELECT s.id, s.internal_name, s.display_name, s.status,
           COALESCE(c.conversations, 0) AS conversations,
           COALESCE(d.failed_deliveries, 0) AS failed_deliveries
         FROM sites s
         LEFT JOIN (
           SELECT site_id, COUNT(*) AS conversations
           FROM conversations
           GROUP BY site_id
         ) c ON c.site_id = s.id
         LEFT JOIN (
           SELECT site_id, COUNT(*) AS failed_deliveries
           FROM integration_deliveries
           WHERE status = 'failed'
           GROUP BY site_id
         ) d ON d.site_id = s.id
         ORDER BY conversations DESC`,
      ),
    ])
    res.json({ summary, byOperator, bySite })
  } catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Report unavailable" }) }
})

export default router