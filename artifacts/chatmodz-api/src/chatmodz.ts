import { Router, type NextFunction, type Request, type Response } from "express"
import { createPool, type Pool, type PoolConnection } from "mysql2/promise"
import crypto from "node:crypto"
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"
import webpush from "web-push"

const router = Router()
const LOCK_MINUTES = 10
const MIN_REPLY_CHARS = 20
const MAX_OPERATOR_NOTES = 5000
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000

type Operator = {
  id: number
  public_id: string
  full_name: string
  email: string
  role: "operator" | "admin"
  status: string
}

declare global {
  namespace Express {
    interface Request {
      chatmodzOperator?: Operator
    }
  }
}

let pool: Pool | null = null
const demoApplications: any[] = []
const demoConversationNotes = new Map<number, { text: string; updatedAt: string | null; updatedByName: string | null }>()
const demoLevels = [
  { id: 1, name: "Beginner", slug: "beginner", description: "New operators building consistency and learning the workflow.", rate_minor: 5, currency: "EUR", is_default: true, active: true, assigned_operators: 1 },
  { id: 2, name: "Developing", slug: "developing", description: "Operators who meet quality and reliability expectations.", rate_minor: 10, currency: "EUR", is_default: false, active: true, assigned_operators: 0 },
  { id: 3, name: "Experienced", slug: "experienced", description: "Trusted operators with a strong history of quality replies.", rate_minor: 15, currency: "EUR", is_default: false, active: true, assigned_operators: 0 },
]
const demoEarnings: any[] = []
const demoOperatorLevels = new Map<number, number>([[2, 1]])

function database() {
  const url = process.env.CHATMODZ_DATABASE_URL
  if (!url) throw new Error("Chatmodz is not configured: CHATMODZ_DATABASE_URL is required")
  if (!pool) pool = createPool({ uri: url, waitForConnections: true, connectionLimit: 10, charset: "utf8mb4" })
  return pool
}

function isDemoMode() {
  return process.env.CHATMODZ_DEMO_MODE === "true" && process.env.NODE_ENV !== "production"
}

function demoOperator(role: "admin" | "operator" = "admin"): Operator {
  const isAdmin = role === "admin"
  return {
    id: isAdmin ? 1 : 2,
    public_id: isAdmin ? "demo-admin" : "demo-operator",
    full_name: isAdmin ? String(process.env.CHATMODZ_ADMIN_NAME || "Patrick Ndungu") : "Demo Operator",
    email: isAdmin
      ? String(process.env.CHATMODZ_ADMIN_EMAIL || "").trim().toLowerCase()
      : String(process.env.CHATMODZ_DEMO_OPERATOR_EMAIL || "operator@chatmodz.test").trim().toLowerCase(),
    role,
    status: "active",
  }
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

export async function initializeChatmodz() {
  if (isDemoMode()) {
    console.log("Chatmodz development demo mode enabled; MySQL persistence is disabled")
    return
  }
  if (!process.env.CHATMODZ_ADMIN_EMAIL || !process.env.CHATMODZ_ADMIN_PASSWORD) return
  try {
    await ensureBootstrapAdmin()
  } catch (error) {
    console.error("Chatmodz bootstrap administrator was not provisioned:", error instanceof Error ? error.message : error)
  }
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
  return {
    id: operator.id,
    name: operator.full_name,
    email: operator.email,
    admin: operator.role === "admin" ? 2 : 1,
    role: operator.role,
    status: operator.status,
  }
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

function operatorMediaPath(value: unknown) {
  const path = typeof value === "string" ? value : ""
  return path.startsWith("/api/chatmodz/media/") ? path : ""
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
    "SELECT id, public_id, full_name, email, role, status FROM operators WHERE id = ? LIMIT 1",
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
      ? demoOperator(payload.role === "operator" ? "operator" : "admin")
      : await loadOperator(Number(payload.operatorId))
    if (!operator || operator.status !== "active") return res.status(401).json({ error: "Session is no longer active" })
    req.chatmodzOperator = operator
    if (!isDemoMode()) await query("UPDATE operators SET last_active_at = NOW() WHERE id = ?", [operator.id])
    next()
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(401).json({ error: "Invalid session" })
  }
}

function requireChatmodzAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.chatmodzOperator?.role !== "admin") return res.status(403).json({ error: "Administrator access required" })
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
    const operatorEmail = String(process.env.CHATMODZ_DEMO_OPERATOR_EMAIL || "operator@chatmodz.test").trim().toLowerCase()
    if (!configuredPassword || !timingSafeEqualText(password, configuredPassword)) {
      return res.status(401).json({ error: "Invalid demo credentials" })
    }
    const operator = identifier === configuredEmail
      ? demoOperator("admin")
      : identifier === operatorEmail
        ? demoOperator("operator")
        : null
    if (!operator) return res.status(401).json({ error: "Invalid demo credentials" })
    return res.json({ token: tokenFor(operator), user: publicOperator(operator), demo: true })
  }
  try {
    const rows = await query<any>("SELECT * FROM operators WHERE email = ? LIMIT 1", [identifier])
    const operator = rows[0]
    if (!operator || !(await bcrypt.compare(password, operator.password_hash))) return res.status(401).json({ error: "Invalid credentials" })
    if (operator.status !== "active") return res.status(403).json({ error: "This operator account is not active" })
    const safe = publicOperator(operator)
    await recordActivity(operator.id, "login")
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
      await connection.execute("UPDATE operators SET password_hash = ?, status = 'active' WHERE id = ?", [passwordHash, record.operator_id])
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

router.get("/conversations", requireChatmodzAuth, async (req, res) => {
  if (isDemoMode()) return res.json({ conversations: [], total: 0, page: 1, pages: 1, demo: true })
  try {
    const rows = await query<any>(`
      SELECT c.*,
        (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS last_message,
        (SELECT sender_type FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS last_sender_type,
        (SELECT delivery_status FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS last_delivery_status,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count
      FROM conversations c
      WHERE c.status <> 'closed' AND (c.lock_expires_at IS NULL OR c.lock_expires_at < NOW() OR c.assigned_operator_id = ?)
      ORDER BY CASE WHEN (SELECT sender_type FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) = 'member' THEN 0 ELSE 1 END, c.last_message_at DESC
      LIMIT 100
    `, [req.chatmodzOperator!.id])
    const conversations = rows.map((row) => ({
      key: publicKey(Number(row.id)),
      fakeUser: { id: -1, name: row.managed_profile_alias, photo: operatorMediaPath(row.managed_profile_photo_url) },
      realUser: { id: -2, name: row.member_alias, photo: operatorMediaPath(row.member_photo_url) },
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

router.get("/conversations/:key/messages", requireChatmodzAuth, async (req, res) => {
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
      "SELECT c.*, o.full_name AS operator_notes_updated_by_name FROM conversations c LEFT JOIN operators o ON o.id = c.operator_notes_updated_by WHERE c.id = ? LIMIT 1",
      [conversationId],
    )
    const conversation = conversations[0]
    if (!conversation) return res.status(404).json({ error: "Conversation not found" })
    const rows = await query<any>("SELECT id, sender_type, body, media_proxy_url, media_type, sent_at, delivery_status FROM messages WHERE conversation_id = ? ORDER BY sent_at ASC, id ASC", [conversationId])
    res.json({
      messages: rows.map((row) => ({
        id: Number(row.id),
        u1: row.sender_type === "managed_profile" ? -1 : -2,
        u2: row.sender_type === "managed_profile" ? -2 : -1,
        message: row.body,
        time: Math.floor(new Date(row.sent_at).getTime() / 1000),
        read: row.delivery_status === "delivered" ? 1 : 0,
        mediaUrl: operatorMediaPath(row.media_proxy_url),
        mediaType: row.media_type || "",
      })),
      users: {
        "-1": { id: -1, name: conversation.managed_profile_alias, photo: operatorMediaPath(conversation.managed_profile_photo_url) },
        "-2": { id: -2, name: conversation.member_alias, photo: operatorMediaPath(conversation.member_photo_url) },
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

router.put("/conversations/:key/notes", requireChatmodzAuth, async (req, res) => {
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
    await recordActivity(req.chatmodzOperator!.id, "note", conversationId)
    res.json({
      notes: {
        text,
        updatedAt: new Date().toISOString(),
        updatedByName: req.chatmodzOperator!.full_name,
      },
    })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Notes unavailable" })
  }
})

router.post("/conversations/:key/lock", requireChatmodzAuth, async (req, res) => {
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

router.post("/conversations/:key/unlock", requireChatmodzAuth, async (req, res) => {
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

router.post("/conversations/:key/keepalive", requireChatmodzAuth, async (req, res) => {
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

router.post("/conversations/:key/reply", requireChatmodzAuth, async (req, res) => {
  const conversationId = internalId(String(req.params.key))
  const body = String(req.body?.message || "").trim()
  const mediaUrl = String(req.body?.mediaUrl || "").trim() || null
  const mediaType = String(req.body?.mediaType || "").trim() || null
  if (!conversationId || (!body && !mediaUrl)) return res.status(400).json({ error: "Reply text or media is required" })
  if (req.chatmodzOperator!.role !== "admin" && meaningfulChars(body) < MIN_REPLY_CHARS) return res.status(400).json({ error: `Reply must contain at least ${MIN_REPLY_CHARS} non-whitespace characters` })
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
    } catch (error: any) {
      await query("UPDATE messages SET delivery_status = 'failed' WHERE id = ?", [messageId])
      await query("UPDATE integration_deliveries SET status = 'failed', attempt_count = attempt_count + 1, error_message = ? WHERE external_event_id = ?", [String(error?.message || "Delivery failed").slice(0, 500), externalMessageId])
      await query("UPDATE operator_earnings SET status = 'void' WHERE message_id = ?", [messageId])
      return res.status(502).json({ error: "Reply could not be delivered to the connected site" })
    }
    res.json({ message: { id: messageId, u1: -1, u2: -2, message: body, time: Math.floor(new Date(messageRows[0].sent_at).getTime() / 1000), read: 1, mediaUrl: operatorMediaPath(mediaUrl), mediaType }, deliveryStatus: "delivered" })
  } catch (error) {
    if (failConfiguration(res, error)) return
    res.status(500).json({ error: "Reply unavailable" })
  }
})

router.get("/stats", requireChatmodzAuth, async (req, res) => {
  if (isDemoMode()) return res.json({ activeLocks: 0, totalConversations: 0, messagesSent: 0, demo: true })
  try {
    const [conversation] = await query<any>("SELECT COUNT(*) AS total FROM conversations WHERE status <> 'closed'")
    const [locks] = await query<any>("SELECT COUNT(*) AS total FROM conversations WHERE assigned_operator_id IS NOT NULL AND lock_expires_at > NOW()")
    const [sent] = await query<any>("SELECT COUNT(*) AS total FROM messages WHERE sent_by_operator_id = ?", [req.chatmodzOperator!.id])
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

router.post("/integrations/:siteKey/messages", async (req, res) => {
  const siteKey = String(req.params.siteKey || "")
  const payload = req.body || {}
  if (!payload.eventId || !payload.conversationId || !payload.messageId || !payload.body || payload.sender !== "member") return res.status(400).json({ error: "Invalid message event" })
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
        const created: any = await connection.execute("INSERT INTO conversations (site_id, external_conversation_id, member_alias, managed_profile_alias, member_photo_url, managed_profile_photo_url, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [site.id, payload.conversationId, payload.memberAlias || "Member", payload.managedProfileAlias || "Managed profile", payload.memberPhotoUrl || null, payload.managedProfilePhotoUrl || null, new Date(payload.sentAt || Date.now())])
        conversationId = Number(created[0].insertId)
      } else {
        await connection.execute("UPDATE conversations SET member_alias = ?, managed_profile_alias = ?, member_photo_url = COALESCE(?, member_photo_url), managed_profile_photo_url = COALESCE(?, managed_profile_photo_url), last_message_at = ? WHERE id = ?", [payload.memberAlias || "Member", payload.managedProfileAlias || "Managed profile", payload.memberPhotoUrl || null, payload.managedProfilePhotoUrl || null, new Date(payload.sentAt || Date.now()), conversationId])
      }
      await connection.execute("INSERT INTO messages (conversation_id, external_message_id, sender_type, body, delivery_status, sent_at) VALUES (?, ?, 'member', ?, 'received', ?)", [conversationId, payload.messageId, payload.body, new Date(payload.sentAt || Date.now())])
      await connection.execute("INSERT INTO integration_deliveries (site_id, direction, external_event_id, conversation_id, status, attempt_count, payload_json) VALUES (?, 'incoming', ?, ?, 'processed', 1, ?)", [site.id, payload.eventId, conversationId, JSON.stringify(payload)])
    })
    await notifyPush("New conversation message", "A member message is waiting in the operator queue").catch(() => undefined)
    res.status(202).json({ accepted: true })
  } catch (error: any) {
    if (failConfiguration(res, error)) return
    if (error?.code === "ER_DUP_ENTRY") return res.status(202).json({ accepted: true, duplicate: true })
    res.status(500).json({ error: "Could not process message event" })
  }
})

router.get("/earnings", requireChatmodzAuth, async (req, res) => {
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
    const [level] = await query<any>(
      `SELECT l.id, l.name, l.description, l.rate_minor, l.currency
       FROM operator_levels l
       LEFT JOIN operator_level_assignments a ON a.level_id = l.id AND a.operator_id = ?
       WHERE l.active = 1 AND (a.operator_id IS NOT NULL OR l.is_default = 1)
       ORDER BY CASE WHEN a.operator_id IS NOT NULL THEN 0 ELSE 1 END, l.id
       LIMIT 1`,
      [operatorId],
    )
    const [summary] = await query<any>(
      `SELECT
         COALESCE(SUM(CASE WHEN status <> 'void' THEN rate_minor ELSE 0 END), 0) AS lifetime_minor,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN rate_minor ELSE 0 END), 0) AS pending_minor,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN rate_minor ELSE 0 END), 0) AS paid_minor,
         COALESCE(SUM(CASE WHEN status <> 'void' AND created_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') THEN rate_minor ELSE 0 END), 0) AS current_month_minor,
         COUNT(CASE WHEN status <> 'void' THEN 1 END) AS total_messages
       FROM operator_earnings
       WHERE operator_id = ?`,
      [operatorId],
    )
    const recent = await query<any>(
      `SELECT e.id, e.message_id, e.level_id, l.name AS level_name, e.rate_minor, e.currency,
          e.status, e.paid_at, e.created_at
       FROM operator_earnings e
       JOIN operator_levels l ON l.id = e.level_id
       WHERE e.operator_id = ?
       ORDER BY e.created_at DESC
       LIMIT 100`,
      [operatorId],
    )
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
  try { res.json({ applications: await query("SELECT id, full_name, email, location, experience, status, created_at, reviewed_at FROM operator_applications ORDER BY created_at DESC LIMIT 200") }) }
  catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Applications unavailable" }) }
})

router.post("/admin/applications/:id/approve", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const applicationId = Number(req.params.id)
  try {
    const applications = await query<any>("SELECT * FROM operator_applications WHERE id = ? LIMIT 1", [applicationId])
    const application = applications[0]
    if (!application) return res.status(404).json({ error: "Application not found" })
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

router.post("/admin/applications/:id/reject", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  try {
    await query("UPDATE operator_applications SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [req.chatmodzOperator!.id, Number(req.params.id)])
    res.json({ rejected: true })
  } catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not reject application" }) }
})

router.get("/admin/operators", requireChatmodzAuth, requireChatmodzAdmin, async (_req, res) => {
  if (isDemoMode()) return res.json({ operators: [{ id: 1, public_id: "demo-admin", full_name: demoOperator().full_name, email: demoOperator().email, role: "admin", status: "active", last_active_at: new Date().toISOString(), created_at: new Date().toISOString() }], demo: true })
  try { res.json({ operators: await query("SELECT id, public_id, full_name, email, role, status, last_active_at, created_at FROM operators ORDER BY created_at DESC") }) }
  catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Operators unavailable" }) }
})

router.post("/admin/operators/:id/status", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const status = String(req.body?.status || "")
  if (!["training", "active", "suspended", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid operator status" })
  try { await query("UPDATE operators SET status = ? WHERE id = ?", [status, Number(req.params.id)]); res.json({ updated: true }) }
  catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not update operator" }) }
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
    const levels = await query<any>(
      `SELECT l.*, COUNT(DISTINCT a.operator_id) AS assigned_operators
       FROM operator_levels l
       LEFT JOIN operator_level_assignments a ON a.level_id = l.id
       GROUP BY l.id, l.name, l.slug, l.description, l.rate_minor, l.currency, l.is_default, l.active, l.created_at, l.updated_at
       ORDER BY l.rate_minor ASC, l.id ASC`,
    )
    const operators = await query<any>(
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
    )
    const [summary] = await query<any>(
      `SELECT
         COUNT(CASE WHEN status <> 'void' THEN 1 END) AS total_messages,
         COALESCE(SUM(CASE WHEN status <> 'void' THEN rate_minor ELSE 0 END), 0) AS accrued_minor,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN rate_minor ELSE 0 END), 0) AS paid_minor,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN rate_minor ELSE 0 END), 0) AS pending_minor
       FROM operator_earnings`,
    )
    const byLevel = await query<any>(
      `SELECT l.id, l.name,
          COUNT(CASE WHEN e.status <> 'void' THEN e.id END) AS messages,
          COALESCE(SUM(CASE WHEN e.status <> 'void' THEN e.rate_minor ELSE 0 END), 0) AS accrued_minor
       FROM operator_levels l
       LEFT JOIN operator_earnings e ON e.level_id = l.id
       GROUP BY l.id, l.name
       ORDER BY l.rate_minor ASC, l.id ASC`,
    )
    const recent = await query<any>(
      `SELECT e.id, e.message_id, e.operator_id, o.full_name AS operator_name,
          e.level_id, l.name AS level_name, e.rate_minor, e.currency, e.status,
          e.paid_at, e.created_at, m.conversation_id
       FROM operator_earnings e
       JOIN operators o ON o.id = e.operator_id
       JOIN operator_levels l ON l.id = e.level_id
       JOIN messages m ON m.id = e.message_id
       ORDER BY e.created_at DESC
       LIMIT 100`,
    )
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

router.put("/admin/sites/:id", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
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
})

router.post("/admin/sites/:id/status", requireChatmodzAuth, requireChatmodzAdmin, async (req, res) => {
  const status = String(req.body?.status || "")
  if (!["active", "paused", "disconnected"].includes(status)) return res.status(400).json({ error: "Invalid site status" })
  try { await query("UPDATE sites SET status = ? WHERE id = ?", [status, Number(req.params.id)]); res.json({ updated: true }) }
  catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Could not update site" }) }
})

router.get("/admin/report", requireChatmodzAuth, requireChatmodzAdmin, async (_req, res) => {
  if (isDemoMode()) return res.json({ summary: { conversations: 0, replies: 0, failed_deliveries: 0 }, byOperator: [{ id: 1, name: demoOperator().full_name, replies: 0 }], bySite: [], demo: true })
  try {
    const [summary] = await query<any>("SELECT COUNT(DISTINCT c.id) AS conversations, COUNT(DISTINCT CASE WHEN m.sender_type = 'managed_profile' THEN m.id END) AS replies, SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed_deliveries FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id LEFT JOIN integration_deliveries d ON d.conversation_id = c.id")
    const byOperator = await query("SELECT o.id, o.full_name AS name, COUNT(m.id) AS replies FROM operators o LEFT JOIN messages m ON m.sent_by_operator_id = o.id GROUP BY o.id, o.full_name ORDER BY replies DESC")
    const bySite = await query("SELECT s.id, s.internal_name, s.display_name, s.status, COUNT(DISTINCT c.id) AS conversations, SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed_deliveries FROM sites s LEFT JOIN conversations c ON c.site_id = s.id LEFT JOIN integration_deliveries d ON d.site_id = s.id GROUP BY s.id, s.internal_name, s.display_name, s.status ORDER BY conversations DESC")
    res.json({ summary, byOperator, bySite })
  } catch (error) { if (!failConfiguration(res, error)) res.status(500).json({ error: "Report unavailable" }) }
})

export default router