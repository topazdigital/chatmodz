import { Fragment, type ChangeEvent, type CSSProperties, type FormEvent, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Switch, useLocation, useParams } from "wouter";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  DollarSign,
  Inbox,
  LockKeyhole,
  LogIn,
  LogOut,
  Menu,
  MessageSquare,
  Paperclip,
  Pencil,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UnlockKeyhole,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();
const MIN_REPLY_CHARS = 20;

type AuthUser = {
  id: number;
  name: string;
  email: string;
  photo?: string;
  photoThumb?: string;
  admin?: number;
};

type AuthState = { user: AuthUser | null; token: string | null; loading: boolean };
const AuthContext = createContext<AuthState & { login: (identifier: string, password: string) => Promise<void>; logout: () => void }>({
  user: null,
  token: null,
  loading: true,
  login: async () => undefined,
  logout: () => undefined,
});

function useSession() {
  return useContext(AuthContext);
}

function storedAuth(): { user: AuthUser | null; token: string | null } {
  try {
    const value = localStorage.getItem("chatmodz_auth");
    if (!value) return { user: null, token: null };
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid stored session");
    const token = typeof parsed.token === "string" && parsed.token.trim() ? parsed.token : null;
    const candidate = parsed.user;
    const user = candidate && typeof candidate === "object" && typeof candidate.id === "number"
      ? candidate as AuthUser
      : null;
    return { user, token };
  } catch {
    localStorage.removeItem("chatmodz_auth");
  }
  return { user: null, token: null };
}

function useAuthState(): AuthState & { login: (identifier: string, password: string) => Promise<void>; logout: () => void } {
  const initial = storedAuth();
  const [user, setUser] = useState<AuthUser | null>(initial.user);
  const [token, setToken] = useState<string | null>(initial.token);
  const [loading, setLoading] = useState(Boolean(initial.token));

  useEffect(() => {
    if (!initial.token) return;
    fetch("/api/chatmodz/auth/me", { headers: { Authorization: `Bearer ${initial.token}` } })
      .then((response) => response.ok ? response.json() : null)
      .then((freshUser) => {
        if (freshUser && typeof freshUser.id === "number") {
          setUser(freshUser);
          localStorage.setItem("chatmodz_auth", JSON.stringify({ user: freshUser, token: initial.token }));
        } else {
          localStorage.removeItem("chatmodz_auth");
          setUser(null);
          setToken(null);
        }
      })
      .catch(() => {
        localStorage.removeItem("chatmodz_auth");
        setUser(null);
        setToken(null);
      })
      .finally(() => setLoading(false));
  }, [initial.token]);

  const login = async (identifier: string, password: string) => {
    const response = await fetch("/api/chatmodz/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Unable to sign in");
    if (!data.token || !data.user || typeof data.user.id !== "number") throw new Error("The login response was incomplete. Please try again.");
    setUser(data.user);
    setToken(data.token);
    localStorage.setItem("chatmodz_auth", JSON.stringify({ user: data.user, token: data.token }));
  };

  const logout = () => {
    if (token) fetch("/api/chatmodz/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    localStorage.removeItem("chatmodz_auth");
    setUser(null);
    setToken(null);
  };

  return { user, token, loading, login, logout };
}

function authFetch(token: string | null, url: string, options: RequestInit = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
    },
  });
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const result = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) result[index] = raw.charCodeAt(index);
  return result;
}

async function subscribeToPush(token: string) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Push notifications are not supported in this browser");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted");
  const keyResponse = await authFetch(token, "/api/chatmodz/push/vapid-key");
  const keyData = await keyResponse.json();
  if (!keyResponse.ok) throw new Error(keyData.error || "Push notifications are not configured");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
  });
  const response = await authFetch(token, "/api/chatmodz/push/subscribe", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) throw new Error((await response.json()).error || "Could not enable notifications");
}

async function unsubscribeFromPush(token: string) {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await authFetch(token, "/api/chatmodz/push/unsubscribe", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  });
}

type ConvUser = { id: number; name: string; photo?: string };
type ConvLock = { moderatorId: number; moderatorName: string; lockedAt: number; expiresAt: number };
type Conversation = {
  key: string;
  fakeUser: ConvUser;
  realUser: ConvUser;
  lastMessage: string;
  lastTime: number;
  msgCount: number;
  lock: ConvLock | null;
  lastSenderFake: boolean;
  lastMsgRead: boolean;
};
type Message = { id: number; senderType?: "member" | "managed_profile" | "system"; u1: number; u2: number; message: string; time: number; read: number; mediaUrl?: string; mediaType?: string };
type Stats = { activeLocks: number; totalConversations: number; messagesSent: number };
type ConversationNotes = { text: string; updatedAt: string | null; updatedByName: string | null };

function countMeaningfulChars(value: string) {
  return Array.from(value).filter((character) => !/\s/u.test(character)).length;
}

function timeAgo(timestamp: number) {
  const seconds = Date.now() / 1000 - timestamp;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function photoUrl(photo?: string) {
  if (!photo) return "";
  if (photo.startsWith("http") || photo.startsWith("/")) return photo;
  return `/api/uploads/${photo}`;
}

function Avatar({ photo, name, size = 36 }: { photo?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.32) };
  if (photo && !failed) {
    return <img className="real-avatar" src={photoUrl(photo)} alt={name} style={style} onError={() => setFailed(true)} />;
  }
  return <div className="avatar" style={style}>{initials || "?"}</div>;
}

function Logo() {
  return <Link href="/" className="brand-mark"><span className="brand-dot" /><span>chatmodz</span></Link>;
}

function StatusPill({ children, type }: { children: ReactNode; type: string }) {
  return <span className={`status-pill ${type}`}><span className="status-dot" />{children}</span>;
}

function Toast({ message }: { message: string }) {
  return message ? <div className="toast-note" role="status">{message}</div> : null;
}

function LandingPage() {
  return <div className="landing-page">
    <header className="landing-nav">
      <Logo />
      <nav className="landing-links" aria-label="Main navigation">
        <a href="#approach">How it works</a>
         <a href="#capabilities">For operators</a>
         <a href="#levels">How earning works</a>
        <a href="#contact">Join us</a>
      </nav>
      <div className="landing-nav-actions"><Link href="/apply" className="button ghost">Apply to operate</Link><Link href="/login" className="button primary"><LogIn size={14} /> Operator login</Link></div>
    </header>
    <main className="landing-main">
      <section className="landing-hero">
        <div className="eyebrow">Private chat operations workspace</div>
        <h1>Good conversations start with <em>good operators.</em></h1>
        <p>We give our chat operators a focused place to listen, respond naturally, and keep conversations moving — without the noise of a dozen browser tabs.</p>
        <div className="landing-actions"><Link href="/login" className="button amber">Enter the operator desk <ChevronRight size={15} /></Link><span className="landing-note"><ShieldCheck size={14} /> Secure access for approved operators</span></div>
      </section>
      <section className="landing-statement" id="approach">
        <div><div className="eyebrow">The work behind the conversation</div><h2>Listen well. Reply naturally. Keep it moving.</h2></div>
        <p>Every conversation deserves attention. Our operators work from one calm, accountable workspace designed to make thoughtful replies easier to deliver.</p>
      </section>
       <section className="landing-grid" id="capabilities">
        <article><div className="landing-icon"><MessageSquare size={18} /></div><h2>Focus on the person</h2><p>See the context you need to write warm, clear replies that feel personal and considered.</p></article>
        <article><div className="landing-icon teal-icon"><LockKeyhole size={18} /></div><h2>Work with confidence</h2><p>Clear assignments, protected access, and simple guardrails keep every shift focused and accountable.</p></article>
        <article><div className="landing-icon"><Activity size={18} /></div><h2>Make every reply count</h2><p>Stay on top of the conversations waiting for you and build momentum one good reply at a time.</p></article>
      </section>
       <section className="landing-earnings" id="levels">
         <div className="landing-earnings-copy"><div className="eyebrow">A clear path to grow</div><h2>Earn more as your conversation skills and consistency grow.</h2><p>Chatmodz uses transparent operator levels. Every delivered reply is recorded against the level you held at that moment, so experience and reliability can be recognised fairly. Payments are processed monthly on the 10th.</p><Link className="button ghost" href="/apply">Start your application <ChevronRight size={15} /></Link></div>
         <div className="landing-level-list">
           <div><span className="level-number">01</span><div><strong>Begin with the basics</strong><small>Learn the workflow, tone, and privacy standards.</small></div></div>
           <div><span className="level-number">02</span><div><strong>Build a trusted record</strong><small>Show quality, care, and reliable delivery over time.</small></div></div>
           <div><span className="level-number">03</span><div><strong>Progress with experience</strong><small>Move into higher operator levels as your work earns trust.</small></div></div>
         </div>
       </section>
      <section className="landing-contact" id="contact"><div><div className="eyebrow">Work with us</div><h2>Have the patience, empathy, and words to make a conversation better?</h2></div><Link className="button primary" href="/apply">Apply to operate <ChevronRight size={15} /></Link></section>
    </main>
    <footer className="landing-footer"><span>Chatmodz</span><span>People, process, and technology in conversation.</span></footer>
  </div>;
}

function LoginPage() {
  const { user, login } = useSession();
  const [, setLocation] = useLocation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (user) setLocation("/"); }, [user, setLocation]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(identifier, password);
      setLocation("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in");
    } finally {
      setSubmitting(false);
    }
  };
  return <div className="auth-page">
    <div className="auth-card">
      <Logo />
      <div className="eyebrow">Secure operator access</div>
      <h1>Welcome back.</h1>
      <p>Sign in with the credentials issued by your operations administrator.</p>
      {import.meta.env.DEV && <div className="notice" style={{ marginBottom: 18 }}><ShieldCheck size={13} /> Replit demo: use the configured administrator credentials, or sign in as <strong>operator@chatmodz.test</strong> with the same development password to preview the queue-only operator role.</div>}
      <form onSubmit={submit} className="auth-form">
        <label htmlFor="identifier">Operator email</label>
        <input id="identifier" className="form-field" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input id="password" className="form-field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        {error && <div className="auth-error"><AlertTriangle size={14} />{error}</div>}
        <button className="button primary auth-submit" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"} <ChevronRight size={15} /></button>
      </form>
      <div className="auth-links"><Link href="/apply" className="auth-back">Apply to become an operator</Link><Link href="/welcome" className="auth-back"><ChevronLeft size={14} /> Back to Chatmodz</Link></div>
    </div>
  </div>;
}

function ApplyPage() {
  const [form, setForm] = useState({ fullName: "", email: "", location: "", experience: "" });
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/chatmodz/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not submit application");
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit application");
    } finally {
      setSubmitting(false);
    }
  };
  return <div className="auth-page"><div className="auth-card application-card"><Logo /><div className="eyebrow">Join the operations team</div><h1>Apply to operate.</h1>{submitted ? <div className="application-success"><ShieldCheck size={24} /><strong>Application received.</strong><span>Our operations team will review your details and contact you if the next training cohort is a fit.</span><Link href="/welcome" className="button primary">Back to Chatmodz</Link></div> : <><p>Tell us about your communication experience. Approved operators receive a one-time activation code and training access.</p><form onSubmit={submit} className="auth-form"><label htmlFor="fullName">Full name</label><input id="fullName" className="form-field" value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required /><label htmlFor="applicationEmail">Email address</label><input id="applicationEmail" className="form-field" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required /><label htmlFor="location">Location</label><input id="location" className="form-field" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /><label htmlFor="experience">Relevant experience</label><textarea id="experience" className="form-field application-textarea" value={form.experience} onChange={(event) => setForm({ ...form, experience: event.target.value })} placeholder="Customer support, community moderation, writing, or relationship-focused work…" /><span className="tiny-text">Do not include member or source-site credentials.</span>{error && <div className="auth-error"><AlertTriangle size={14} />{error}</div>}<button className="button primary auth-submit" disabled={submitting}>{submitting ? "Submitting…" : "Submit application"} <ChevronRight size={15} /></button></form><Link href="/welcome" className="auth-back"><ChevronLeft size={14} /> Back to Chatmodz</Link></>}</div></div>;
}

const navItems = [
  { href: "/", label: "Queue", icon: Inbox },
  { href: "/earnings", label: "Earnings", icon: DollarSign },
  { href: "/reports", label: "Reports", icon: BarChart3, adminOnly: true },
  { href: "/admin", label: "Admin", icon: ShieldCheck, adminOnly: true },
];

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const current = navItems.find((item) => item.href === location)?.label ?? "Conversation";
  const initials = user?.name?.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
  return <div className="app-frame">
    <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
      <Logo />
      <div className="sidebar-label">Operations</div>
      <nav>{navItems.filter((item) => !item.adminOnly || (user?.admin ?? 0) >= 2).map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`nav-link ${location === href ? "active" : ""}`} onClick={() => setMobileOpen(false)}><Icon /><span>{label}</span></Link>)}</nav>
      <div className="sidebar-label">Workspace</div>
      <Link href="/settings" className={`nav-link ${location === "/settings" ? "active" : ""}`} onClick={() => setMobileOpen(false)}><UserRound /><span>Account</span></Link>
      <div className="sidebar-spacer" />
      <div className="operator-chip"><Avatar photo={user?.photo} name={user?.name || "Operator"} size={32} /><div><strong>{user?.name || "Operator"}</strong><small>{(user?.admin ?? 0) >= 2 ? "Administrator" : "Operator"} · active</small></div><button className="icon-button" style={{ marginLeft: "auto", color: "#9aa7b8" }} aria-label="Sign out" onClick={() => { logout(); setLocation("/login"); }}><LogOut size={15} /></button></div>
    </aside>
    {mobileOpen && <button className="mobile-backdrop" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    <main className="content-shell">
      <header className="topbar"><div style={{ display: "flex", alignItems: "center", gap: 12 }}><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={19} /></button><div className="crumb"><span>Control room</span><ChevronRight size={12} style={{ verticalAlign: "middle", margin: "0 5px" }} /><strong>{current}</strong></div></div><div className="top-actions"><StatusPill type="active">Secure session</StatusPill><Avatar photo={user?.photo} name={user?.name || "Operator"} size={30} /></div></header>
      {children}
    </main>
  </div>;
}

function Metric({ label, value, detail, color = "var(--amber)" }: { label: string; value: string; detail: string; color?: string }) {
  return <div className="metric-card" style={{ "--metric-color": color } as CSSProperties}><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div></div>;
}

function useModeratorData() {
  const { token } = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [stats, setStats] = useState<Stats>({ activeLocks: 0, totalConversations: 0, messagesSent: 0 });
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [conversationResponse, statsResponse] = await Promise.all([
        authFetch(token, "/api/chatmodz/conversations"),
        authFetch(token, "/api/chatmodz/stats"),
      ]);
      if (conversationResponse.ok) setConversations((await conversationResponse.json()).conversations || []);
      if (statsResponse.ok) setStats(await statsResponse.json());
    } finally {
      setLoading(false);
    }
  }, [token]);
  useEffect(() => { load(); const interval = window.setInterval(load, 15000); return () => window.clearInterval(interval); }, [load]);
  return { conversations, stats, loading, reload: load };
}

function QueuePage() {
  const { user } = useSession();
  const { conversations, stats, loading, reload } = useModeratorData();
  const [, setLocation] = useLocation();
  const [filter, setFilter] = useState<"all" | "mine" | "available">("all");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const filtered = useMemo(() => conversations.filter((conversation) => {
    const matchesFilter = filter === "all" || (filter === "mine" ? conversation.lock?.moderatorId === user?.id : !conversation.lock);
    const haystack = `${conversation.fakeUser.name} ${conversation.realUser.name} ${conversation.lastMessage}`.toLowerCase();
    return matchesFilter && haystack.includes(search.toLowerCase());
  }), [conversations, filter, search, user?.id]);
  const unread = conversations.filter((conversation) => !conversation.lastSenderFake).length;
  const refresh = async () => { await reload(); setNotice("Queue refreshed"); window.setTimeout(() => setNotice(""), 2200); };
  return <Shell><div className="page">
    <div className="page-head"><div><div className="eyebrow">Operator queue / live</div><h1 className="page-title">Good morning, {user?.name?.split(" ")[0] || "operator"}.</h1><p className="page-subtitle">Work the live conversation queue and keep every reply moving.</p></div><div className="queue-head-status"><StatusPill type="active">Live data</StatusPill><span className="tiny-text mono">Auto-refresh 15s</span></div></div>
    <div className="metric-grid"><Metric label="Open conversations" value={String(stats.totalConversations)} detail={`${unread} waiting for a reply`} /><Metric label="Your sent replies" value={String(stats.messagesSent)} detail="Recorded by the live activity log" color="var(--teal)" /><Metric label="Active locks" value={String(stats.activeLocks)} detail="Locks expire after 10 minutes" color="var(--ink)" /><Metric label="Queue status" value={loading ? "…" : "Live"} detail="No demo records are shown" color="var(--teal)" /></div>
     <section className="panel"><div className="panel-head"><div><div className="panel-title">Conversations</div><div className="panel-kicker" style={{ marginTop: 5 }}>Your assigned work and available conversations</div></div><button className="button ghost compact" onClick={refresh}><RefreshCw size={13} /> Refresh</button></div>
      <div className="filters">{(["all", "mine", "available"] as const).map((item) => <button key={item} className={`filter-button ${filter === item ? "selected" : ""}`} onClick={() => setFilter(item)}>{item === "all" ? "All conversations" : item === "mine" ? "Locked by me" : "Available"}</button>)}<div className="search-wrap"><Search size={15} /><input className="search-field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search names or messages" aria-label="Search conversations" /></div></div>
      <div className="queue-list">{loading ? <div className="empty-state"><RefreshCw className="spin" size={25} /><strong>Loading live conversations</strong><span>Fetching the authenticated operator queue.</span></div> : filtered.length ? filtered.map((conversation, index) => <ConversationRow key={conversation.key} conversation={conversation} userId={user?.id || 0} onOpen={() => setLocation(`/conversation/${conversation.key}`)} style={{ animationDelay: `${index * 35}ms` }} />) : <div className="empty-state"><Inbox size={27} /><strong>No conversations match this view</strong><span>The live source returned no matching conversations.</span></div>}</div>
    </section><Toast message={notice} />
  </div></Shell>;
}

type OperatorEarningsLevel = { id: number; name: string; description: string; rateMinor: number; currency: string };
type OperatorEarningsRecord = { id: number; messageId: number; levelName: string; rateMinor: number; currency: string; status: "pending" | "paid" | "void"; paidAt: string | null; createdAt: string };
type OperatorEarningsData = {
  level: OperatorEarningsLevel | null;
  schedule: { day: number; label: string; nextDate: string };
  summary: { currentMonthMinor: number; pendingMinor: number; paidMinor: number; lifetimeMinor: number; totalMessages: number };
  recent: OperatorEarningsRecord[];
};

const emptyOperatorEarnings: OperatorEarningsData = {
  level: null,
  schedule: { day: 10, label: "Paid monthly on the 10th", nextDate: "" },
  summary: { currentMonthMinor: 0, pendingMinor: 0, paidMinor: 0, lifetimeMinor: 0, totalMessages: 0 },
  recent: [],
};

function EarningsPage() {
  const { token } = useSession();
  const [data, setData] = useState<OperatorEarningsData>(emptyOperatorEarnings);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const currency = data.level?.currency || data.recent[0]?.currency || "EUR";
  const currentMonth = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date());
  const nextPayout = data.schedule.nextDate
    ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${data.schedule.nextDate}T00:00:00`))
    : "the 10th of next month";
  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const response = await authFetch(token, "/api/chatmodz/earnings");
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Earnings could not be loaded");
      setData({ ...emptyOperatorEarnings, ...result, summary: { ...emptyOperatorEarnings.summary, ...(result.summary || {}) } });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Earnings could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);
  return <Shell><div className="page">
    <div className="page-head"><div><div className="eyebrow">Workspace / earnings</div><h1 className="page-title">Your earnings</h1><p className="page-subtitle">Track delivered replies, your current level, and what is ready for payment.</p></div><button className="button ghost compact" onClick={load} disabled={loading}><RefreshCw size={13} /> Refresh</button></div>
    <section className="payout-callout"><DollarSign size={20} /><div><strong>{data.schedule.label}</strong><p>Payments are processed monthly. Your pending balance is reviewed for the next payout.</p></div><span className="tiny-text mono">Next: {nextPayout}</span></section>
    {loading ? <div className="empty-state panel"><RefreshCw className="spin" size={25} /><strong>Loading your earnings</strong><span>Fetching your delivered reply history.</span></div> : <>
      <div className="metric-grid"><Metric label={currentMonth} value={money(data.summary.currentMonthMinor, currency)} detail="Delivered replies this month" /><Metric label="Pending payment" value={money(data.summary.pendingMinor, currency)} detail="To be included in a payout" color="var(--amber)" /><Metric label="Paid to date" value={money(data.summary.paidMinor, currency)} detail="Payments marked complete" color="var(--teal)" /><Metric label="Delivered replies" value={String(data.summary.totalMessages)} detail={`Lifetime · ${money(data.summary.lifetimeMinor, currency)} earned`} color="var(--ink)" /></div>
      <div className="earnings-grid">
        <section className="panel earnings-level-card"><div className="panel-head"><div><div className="panel-title">Your current level</div><div className="panel-kicker">Your rate is captured when a reply is delivered</div></div><DollarSign size={17} color="var(--teal)" /></div>{data.level ? <div className="earnings-level-content"><div><h2>{data.level.name}</h2><p>{data.level.description || "Your assigned operator level."}</p></div><strong className="earnings-rate">{money(data.level.rateMinor, data.level.currency)}<small>per delivered reply</small></strong></div> : <div className="empty-state"><strong>No level assigned yet</strong><span>Your administrator will assign a level before you begin paid work.</span></div>}</section>
        <section className="panel"><div className="panel-head"><div><div className="panel-title">Payment schedule</div><div className="panel-kicker">Consistent monthly payout timing</div></div><Clock3 size={17} color="var(--amber)" /></div><div className="schedule-detail"><strong>Every month on the 10th</strong><span>Pending earnings stay visible here until payment is confirmed.</span></div></section>
      </div>
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Recent earnings</div><div className="panel-kicker">Each delivered reply keeps its level and rate snapshot</div></div></div><div className="table-wrap"><table className="data-table earnings-table"><thead><tr><th>Reply</th><th>Level</th><th>Amount</th><th>Recorded</th><th>Status</th></tr></thead><tbody>{data.recent.length ? data.recent.map((earning) => <tr key={earning.id}><td className="mono">#{earning.messageId}</td><td>{earning.levelName}</td><td className="money-cell">{money(earning.rateMinor, earning.currency)}</td><td>{new Date(earning.createdAt).toLocaleDateString()}</td><td><StatusPill type={earning.status === "paid" ? "active" : earning.status === "void" ? "rejected" : "pending"}>{earning.status}</StatusPill></td></tr>) : <tr><td colSpan={5}>No delivered replies have been recorded yet. Your earnings will appear here after your first delivered reply.</td></tr>}</tbody></table></div></section>
    </>}
    <Toast message={notice} />
  </div></Shell>;
}

function ConversationRow({ conversation, userId, onOpen, style }: { conversation: Conversation; userId: number; onOpen: () => void; style?: CSSProperties }) {
  const needsReply = !conversation.lastSenderFake;
  const mine = conversation.lock?.moderatorId === userId;
  const otherLock = conversation.lock && !mine;
  return <button className={`queue-row live-row ${needsReply ? "needs-reply" : ""}`} onClick={onOpen} style={style}>
    <div className="queue-person"><div className="avatar-stack"><Avatar photo={conversation.fakeUser.photo} name={conversation.fakeUser.name} size={36} /><Avatar photo={conversation.realUser.photo} name={conversation.realUser.name} size={22} /></div><div><strong>{conversation.fakeUser.name} <span className="arrow-muted">→</span> {conversation.realUser.name}</strong><small>{conversation.msgCount} messages · {timeAgo(conversation.lastTime)}</small></div></div>
     <div className="queue-snippet"><strong><span className={`priority-dot ${needsReply ? "high" : "normal"}`} />{conversation.lastMessage || "No text in the latest message"}</strong><small>{needsReply ? "Reply needed" : conversation.lastMsgRead ? "Follow-up available" : "Waiting for member"}</small></div>
    <div>{mine ? <StatusPill type="active">Locked by you</StatusPill> : otherLock ? <StatusPill type="pending">Locked</StatusPill> : <span className="button amber compact">Open</span>}</div><ChevronRight size={16} color="var(--ink-soft)" />
  </button>;
}

function MediaBubble({ message }: { message: Message }) {
  if (!message.mediaUrl || !message.mediaType) return null;
  const url = message.mediaUrl.startsWith("/") || message.mediaUrl.startsWith("http") ? message.mediaUrl : `/api/uploads/${message.mediaUrl}`;
  if (message.mediaType === "image") return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Attached media" className="message-media" /></a>;
  if (message.mediaType === "video") return <video src={url} controls className="message-media" preload="metadata" />;
  if (message.mediaType === "audio") return <div className="audio-media"><Volume2 size={15} /><audio src={url} controls preload="metadata" /></div>;
  return null;
}

function ConversationPage() {
  const params = useParams<{ id: string }>();
  const { user, token } = useSession();
  const [, setLocation] = useLocation();
  const { conversations, reload } = useModeratorData();
  const selectedFromQueue = conversations.find((conversation) => conversation.key === params.id);
  const [conversationSnapshot, setConversationSnapshot] = useState<Conversation | null>(null);
  useEffect(() => {
    if (selectedFromQueue) setConversationSnapshot(selectedFromQueue);
  }, [selectedFromQueue]);
  const selected = selectedFromQueue || conversationSnapshot;
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<Record<string, ConvUser>>({});
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [media, setMedia] = useState<{ file: File; preview: string; type: string } | null>(null);
  const [notes, setNotes] = useState<ConversationNotes>({ text: "", updatedAt: null, updatedByName: null });
  const [savedNotes, setSavedNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(Boolean(selected));
  const [sending, setSending] = useState(false);
  const [locking, setLocking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lockedByMe = selected?.lock?.moderatorId === user?.id;
  const isAdmin = (user?.admin ?? 0) >= 2;
  const meaningful = countMeaningfulChars(draft);
  const canSend = Boolean(selected && lockedByMe && (draft.trim() || media) && (isAdmin || meaningful >= MIN_REPLY_CHARS));

  const conversationKey = selected?.key;
  const loadMessages = useCallback(async () => {
    if (!conversationKey || !token) return;
    setLoading(true);
    const response = await authFetch(token, `/api/chatmodz/conversations/${conversationKey}/messages`);
    if (response.ok) {
      const data = await response.json();
      setMessages(data.messages || []);
      setUsers(data.users || {});
      const loadedNotes = data.notes || { text: "", updatedAt: null, updatedByName: null };
      setNotes(loadedNotes);
      setSavedNotes(loadedNotes.text);
    }
    setLoading(false);
  }, [conversationKey, token]);
  useEffect(() => { loadMessages(); }, [loadMessages]);
  useEffect(() => {
    if (!selected || !token) return;
    setSuggestions([]);
  }, [selected, token]);
  useEffect(() => {
    if (!selected || !lockedByMe || !token) return;
    const interval = window.setInterval(() => { authFetch(token, `/api/chatmodz/conversations/${selected.key}/keepalive`, { method: "POST" }).catch(() => undefined); }, 120000);
    return () => window.clearInterval(interval);
  }, [selected, lockedByMe, token]);

  if (!selected) return <Shell><div className="page"><div className="empty-state panel"><AlertTriangle size={28} /><strong>Conversation not found</strong><span>This live queue item may have expired or been removed.</span><Link href="/" className="button primary" style={{ marginTop: 16 }}>Back to queue</Link></div></div></Shell>;

  const notify = (value: string) => { setNotice(value); window.setTimeout(() => setNotice(""), 2400); };
  const toggleLock = async () => {
    setLocking(true);
    const endpoint = lockedByMe ? "unlock" : "lock";
    const response = await authFetch(token, `/api/chatmodz/conversations/${selected.key}/${endpoint}`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) notify(data.error || "The conversation lock could not be changed");
    else { notify(lockedByMe ? "Conversation released" : "Conversation locked to you"); await reload(); }
    setLocking(false);
  };
  const saveNotes = async () => {
    if (!selected || !token || !lockedByMe) return;
    setSavingNotes(true);
    try {
      const response = await authFetch(token, `/api/chatmodz/conversations/${selected.key}/notes`, {
        method: "PUT",
        body: JSON.stringify({ notes: notes.text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Notes could not be saved");
      const saved = data.notes || { ...notes, updatedAt: new Date().toISOString(), updatedByName: user?.name || "You" };
      setNotes(saved);
      setSavedNotes(saved.text);
      notify("Shared operator notes saved");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Notes could not be saved");
    } finally {
      setSavingNotes(false);
    }
  };
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const type = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "";
    if (!type) { notify("Choose an image, video, or audio file"); return; }
    if (file.size > 50 * 1024 * 1024) { notify("Media must be 50 MB or smaller"); return; }
    if (media) URL.revokeObjectURL(media.preview);
    setMedia({ file, preview: URL.createObjectURL(file), type });
  };
  const send = async () => {
    if (!canSend || !selected) return;
    setSending(true);
    try {
      let mediaUrl = "";
      let mediaType = "";
      if (media) {
        const form = new FormData();
        form.append("media", media.file);
        const upload = await authFetch(token, "/api/chat/upload", { method: "POST", body: form });
        const uploaded = await upload.json();
        if (!upload.ok) throw new Error(uploaded.error || "Media upload failed");
        mediaUrl = uploaded.url;
        mediaType = uploaded.type;
      }
      const response = await authFetch(token, `/api/chatmodz/conversations/${selected.key}/reply`, { method: "POST", body: JSON.stringify({ message: draft.trim(), mediaUrl, mediaType }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Reply failed");
      setMessages((current) => [...current, data.message]);
      setDraft("");
      if (media) { URL.revokeObjectURL(media.preview); setMedia(null); }
      await reload();
      notify("Reply delivered to the connected site");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Reply failed");
    } finally {
      setSending(false);
    }
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isAdmin && (event.ctrlKey || event.metaKey) && ["c", "v", "x"].includes(event.key.toLowerCase())) event.preventDefault();
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
  };
  return <Shell><div className="page">
    <div className="page-head conversation-page-head"><button className="button ghost compact" onClick={() => setLocation("/")}><ChevronLeft size={13} /> Queue</button><div className="tiny-text mono">Live conversation · {selected.key}</div></div>
    <div className="conversation-layout">
       <section className="panel conversation-main"><div className="conversation-top"><div className="conversation-identity"><div className="avatar-stack large"><Avatar photo={selected.fakeUser.photo} name={selected.fakeUser.name} size={44} /><Avatar photo={selected.realUser.photo} name={selected.realUser.name} size={26} /></div><div><h2>{selected.fakeUser.name} <span className="arrow-muted">→</span> {selected.realUser.name}</h2><small>Conversation context and message history</small></div></div><div className="conversation-actions">{selected.lock && <StatusPill type={lockedByMe ? "active" : "pending"}>{lockedByMe ? "Locked by you" : "Locked"}</StatusPill>}<button className={`button compact ${lockedByMe ? "ghost" : "amber"}`} onClick={toggleLock} disabled={locking || (selected.lock !== null && !lockedByMe)}>{lockedByMe ? <><UnlockKeyhole size={13} /> Release</> : <><LockKeyhole size={13} /> Lock to me</>}</button></div></div>
        <div className="messages">{loading ? <div className="empty-state"><RefreshCw className="spin" size={24} /><strong>Loading messages</strong></div> : messages.length ? messages.map((message, index) => { const byFake = message.senderType === "managed_profile" || message.u1 === selected.fakeUser.id; const sender = users[String(message.u1)] || (byFake ? selected.fakeUser : selected.realUser); return <div key={message.id} className={`message ${byFake ? "operator" : "member"}`}><Avatar photo={sender.photo} name={sender.name} size={27} /><div><div className="bubble">{message.mediaUrl && <MediaBubble message={message} />}{message.message && <p>{message.message}</p>}<div className="message-meta">{timeAgo(message.time)} {index === messages.length - 1 && <strong>{byFake ? "Waiting for member" : "Needs reply"}</strong>}</div></div></div></div>; }) : <div className="empty-state"><MessageSquare size={25} /><strong>No messages in this conversation</strong><span>The connected source returned an empty thread.</span></div>}</div>
        <div className="composer">{suggestions.length > 0 && <div className="canned-row">{suggestions.map((suggestion) => <button key={suggestion} className="canned" onClick={() => setDraft(suggestion)}>{suggestion}</button>)}</div>}{media && <div className="media-pending"><span>{media.type} attached</span><button className="icon-button" onClick={() => { URL.revokeObjectURL(media.preview); setMedia(null); }} aria-label="Remove attachment"><X size={14} /></button></div>}<div className="composer-row"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} onCopy={(event) => { if (!isAdmin) event.preventDefault(); }} onCut={(event) => { if (!isAdmin) event.preventDefault(); }} onPaste={(event) => { if (!isAdmin) event.preventDefault(); }} onDrop={(event) => { if (!isAdmin) event.preventDefault(); }} placeholder={lockedByMe ? "Write a thoughtful reply…" : "Lock this conversation before replying"} disabled={!lockedByMe || sending} aria-label="Reply message" /><div className="composer-tools"><input ref={inputRef} type="file" accept="image/*,video/*,audio/*" hidden onChange={handleFile} /><button className="icon-button" onClick={() => inputRef.current?.click()} disabled={!lockedByMe || sending} aria-label="Attach media"><Paperclip size={16} /></button><button className="button primary" onClick={send} disabled={!canSend || sending}><Send size={14} /> {sending ? "Sending…" : "Send"}</button></div></div><div className={`reply-counter ${!isAdmin && meaningful > 0 && meaningful < MIN_REPLY_CHARS ? "short" : ""}`}>{isAdmin ? "Administrator override enabled" : `${meaningful}/${MIN_REPLY_CHARS} non-space characters required`} · Enter to send, Shift+Enter for a new line</div></div>
      </section>
       <aside className="panel conversation-side"><div className="side-section"><div className="side-title">Conversation details</div><div className="detail-line"><span>Latest activity</span><span>{timeAgo(selected.lastTime)}</span></div><div className="detail-line"><span>Messages</span><span>{selected.msgCount}</span></div><div className="detail-line"><span>Assignment</span><span>{lockedByMe ? "You" : selected.lock ? selected.lock.moderatorName : "Available"}</span></div></div><div className="side-section shared-notes"><div className="side-title">Shared operator notes</div><p className="tiny-text notes-help">Private to operators. Record what was discussed, promised, or already provided so the next operator can continue naturally.</p><textarea className="form-field notes-field" value={notes.text} maxLength={5000} onChange={(event) => setNotes((current) => ({ ...current, text: event.target.value }))} placeholder={lockedByMe ? "What did the user ask for? What was promised or already given?" : "Lock this conversation to view and update notes"} disabled={!lockedByMe || savingNotes} aria-label="Shared operator notes" /><div className="notes-actions"><span className="tiny-text">{notes.text.length}/5000</span><button className="button amber compact" onClick={saveNotes} disabled={!lockedByMe || savingNotes || notes.text === savedNotes}>{savingNotes ? "Saving…" : "Save notes"}</button></div>{notes.updatedAt && <span className="tiny-text notes-updated">Updated by {notes.updatedByName || "an operator"} · {new Date(notes.updatedAt).toLocaleString()}</span>}</div><div className="side-section"><div className="side-title">Reply quality</div><div className="notice"><ShieldCheck size={13} /> Keep replies warm, direct, and personal.</div></div><div className="side-section"><div className="side-title">Lock policy</div><div className="tiny-text"><Clock3 size={13} style={{ verticalAlign: "middle", marginRight: 5 }} /> Locks last 10 minutes and are renewed while this conversation is open.</div></div></aside>
    </div><Toast message={notice} />
  </div></Shell>;
}

function ReportsPage() {
  const { user, token } = useSession();
  const { conversations, stats, loading, reload } = useModeratorData();
  const [notice, setNotice] = useState("");
  const needsReply = conversations.filter((conversation) => !conversation.lastSenderFake).length;
  const locked = conversations.filter((conversation) => conversation.lock).length;
  const refresh = async () => { await reload(); setNotice("Report refreshed from live activity"); window.setTimeout(() => setNotice(""), 2200); };
  if ((user?.admin ?? 0) < 2) return <Shell><div className="page"><div className="empty-state panel"><AlertTriangle size={28} /><strong>Administrator access required</strong><span>Operational reports are only available to administrators.</span><Link href="/" className="button primary" style={{ marginTop: 16 }}>Back to queue</Link></div></div></Shell>;
  if (!token) return null;
  return <Shell><div className="page"><div className="page-head"><div><div className="eyebrow">Admin / operational truth</div><h1 className="page-title">Reports</h1><p className="page-subtitle">Live moderator activity from the connected conversation source.</p></div><button className="button primary" onClick={refresh}><RefreshCw size={14} /> Refresh report</button></div>
     <div className="metric-grid"><Metric label="Total conversations" value={String(stats.totalConversations)} detail="Current conversation queue" /><Metric label="Waiting for reply" value={String(needsReply)} detail="Latest sender is a member" color="var(--teal)" /><Metric label="Active locks" value={String(locked)} detail="Current queue snapshot" color="var(--ink)" /><Metric label="Replies by you" value={String(stats.messagesSent)} detail="Recorded in the activity log" color="var(--teal)" /></div>
     <section className="panel report-panel"><div className="panel-head"><div><div className="panel-title">Queue accountability</div><div className="panel-kicker" style={{ marginTop: 5 }}>No synthetic charts or placeholder rows</div></div><CircleHelp size={17} color="var(--ink-soft)" /></div><div className="report-list"><div><span>Authenticated data source</span><strong>{loading ? "Loading…" : "Connected"}</strong></div><div><span>Conversation locks</span><strong>{stats.activeLocks} active</strong></div><div><span>Replies attributed to current operator</span><strong>{stats.messagesSent}</strong></div></div></section><Toast message={notice} /></div></Shell>;
}

function SettingsPage() {
  const { user, token, logout } = useSession();
  const [, setLocation] = useLocation();
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription()).then((subscription) => setPushEnabled(Boolean(subscription))).catch(() => undefined);
  }, []);
  const togglePush = async () => {
    if (!token) return;
    setPushLoading(true);
    try {
      if (pushEnabled) {
        await unsubscribeFromPush(token);
        setPushEnabled(false);
        setNotice("Push notifications disabled");
      } else {
        await subscribeToPush(token);
        setPushEnabled(true);
        setNotice("Push notifications enabled");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update notifications");
    } finally {
      setPushLoading(false);
      window.setTimeout(() => setNotice(""), 2600);
    }
  };
  return <Shell><div className="page"><div className="page-head"><div><div className="eyebrow">Workspace / account</div><h1 className="page-title">Account</h1><p className="page-subtitle">Your authenticated operator identity and session controls.</p></div><StatusPill type="active">Protected workspace</StatusPill></div><section className="panel settings-panel"><h2>Account details</h2><p>These details are visible to authorized administrators, not to members.</p><div className="form-grid"><div className="form-group"><label>Display name</label><input className="form-field" value={user?.name || ""} readOnly /></div><div className="form-group"><label>Email address</label><input className="form-field" value={user?.email || ""} readOnly /></div><div className="form-group full"><label>Role</label><input className="form-field" value={(user?.admin ?? 0) >= 2 ? "Administrator" : "Operator"} readOnly /></div></div><div className="setting-row" style={{ marginTop: 22 }}><div><strong>Push notifications</strong><small>Receive a browser alert when new member messages need attention.</small></div><button className={`toggle ${pushEnabled ? "on" : ""}`} onClick={togglePush} disabled={pushLoading} aria-label="Toggle push notifications"><span /></button></div><div style={{ marginTop: 22 }}><button className="button danger" onClick={() => { logout(); setLocation("/login"); }}><LogOut size={14} /> Sign out</button></div></section><Toast message={notice} /></div></Shell>;
}

type AdminData = {
  applications: any[];
  operators: any[];
  sites: any[];
  report: { summary?: any; byOperator?: any[]; bySite?: any[] };
};

type CompensationLevel = { id: number; name: string; slug: string; description: string; rateMinor: number; currency: string; isDefault: boolean; active: boolean; assignedOperators: number };
type CompensationOperator = { id: number; fullName: string; email: string; role: string; status: string; levelId: number | null; levelName: string | null; rateMinor: number | null; currency: string | null; earnedMinor: number; earnedMessages: number };
type CompensationRecord = { id: number; messageId: number; operatorName: string; levelName: string; rateMinor: number; currency: string; status: "pending" | "paid" | "void"; paidAt: string | null; createdAt: string; conversationId: number };
type CompensationData = { levels: CompensationLevel[]; operators: CompensationOperator[]; summary: { totalMessages: number; accruedMinor: number; paidMinor: number; pendingMinor: number }; byLevel: { id: number; name: string; messages: number; accruedMinor: number }[]; recent: CompensationRecord[] };

const emptyCompensation: CompensationData = { levels: [], operators: [], summary: { totalMessages: 0, accruedMinor: 0, paidMinor: 0, pendingMinor: 0 }, byLevel: [], recent: [] };

function money(minor: number | null | undefined, currency = "EUR") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(minor || 0) / 100);
}

type SiteAction = (url: string, method?: string, body?: unknown) => Promise<unknown>;

function SiteManagementPanel({ sites, action, load, setNotice }: { sites: any[]; action: SiteAction; load: () => Promise<void>; setNotice: (message: string) => void }) {
  const [draft, setDraft] = useState({ internalName: "", displayName: "", endpointBaseUrl: "", secretEnvKey: "", integrationType: "hybrid" });
  const [editingSiteId, setEditingSiteId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ internalName: "", displayName: "", endpointBaseUrl: "", secretEnvKey: "", integrationType: "hybrid" });
  const [saving, setSaving] = useState(false);
  const [editSaving, setEditSaving] = useState(false);

  const saveSite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      await action("/api/chatmodz/admin/sites", "POST", draft);
      setDraft({ internalName: "", displayName: "", endpointBaseUrl: "", secretEnvKey: "", integrationType: "hybrid" });
      setNotice("Connected site added");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Site could not be added");
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (id: number, status: string) => {
    try {
      await action(`/api/chatmodz/admin/sites/${id}/status`, "POST", { status });
      setNotice("Site status updated");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Site status could not be updated");
    }
  };

  const beginEdit = (site: any) => {
    setEditingSiteId(Number(site.id));
    setEditDraft({
      internalName: String(site.internal_name || ""),
      displayName: String(site.display_name || ""),
      endpointBaseUrl: String(site.endpoint_base_url || ""),
      secretEnvKey: String(site.secret_env_key || ""),
      integrationType: String(site.integration_type || "hybrid"),
    });
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingSiteId) return;
    setEditSaving(true);
    try {
      await action(`/api/chatmodz/admin/sites/${editingSiteId}/settings`, "POST", editDraft);
      setEditingSiteId(null);
      setNotice("Connected site updated");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Site could not be updated");
    } finally {
      setEditSaving(false);
    }
  };

  return <>
    <section className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Add connected site</div>
          <div className="panel-kicker">The signing secret must already exist in the API environment</div>
        </div>
      </div>
      <form className="form-grid" onSubmit={saveSite}>
        <div className="form-group">
          <label htmlFor="site-internal-name">Internal name</label>
          <input id="site-internal-name" className="form-field" value={draft.internalName} onChange={(event) => setDraft({ ...draft, internalName: event.target.value.toLowerCase() })} placeholder="site_one" pattern="[a-z0-9_-]{2,120}" required />
          <small>Lowercase letters, numbers, underscores, or hyphens.</small>
        </div>
        <div className="form-group">
          <label htmlFor="site-display-name">Display name</label>
          <input id="site-display-name" className="form-field" value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder="Site One" required />
        </div>
        <div className="form-group">
          <label htmlFor="site-secret-key">Secret environment key</label>
          <input id="site-secret-key" className="form-field mono" value={draft.secretEnvKey} onChange={(event) => setDraft({ ...draft, secretEnvKey: event.target.value.toUpperCase() })} placeholder="SITE_ONE_SECRET" pattern="[A-Z_][A-Z0-9_]*" required />
          <small>Add this exact key to <code>.env.production</code> before saving.</small>
        </div>
        <div className="form-group">
          <label htmlFor="site-endpoint">Reply endpoint URL</label>
          <input id="site-endpoint" className="form-field" type="url" value={draft.endpointBaseUrl} onChange={(event) => setDraft({ ...draft, endpointBaseUrl: event.target.value })} placeholder="https://site.example.com/chatmodz/replies" />
          <small>Leave blank for inbound-only integrations.</small>
        </div>
        <div className="form-group">
          <label htmlFor="site-integration-type">Integration type</label>
          <select id="site-integration-type" className="form-field" value={draft.integrationType} onChange={(event) => setDraft({ ...draft, integrationType: event.target.value })}>
            <option value="hybrid">Hybrid</option>
            <option value="webhook">Webhook</option>
            <option value="api">API</option>
          </select>
        </div>
        <div className="form-group full">
          <small>After creation, configure the site adapter to send signed messages to <code>/api/chatmodz/integrations/{`{siteKey}`}/messages</code>. The adapter is what makes live conversations appear in the queue.</small>
        </div>
        <div className="inline-actions full">
          <button className="button amber compact" type="submit" disabled={saving}>{saving ? "Adding…" : "Add connected site"}</button>
        </div>
      </form>
    </section>
    <section className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Connected sites</div>
          <div className="panel-kicker">Edit endpoints and secret key names without exposing secret values</div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Site</th><th>Endpoint</th><th>Secret env key</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{sites.length ? sites.map((site) => <Fragment key={site.id}>
            <tr>
              <td><strong>{site.display_name}</strong><br /><span className="tiny-text mono">{site.internal_name}</span></td>
              <td className="table-long">{site.endpoint_base_url || "Inbound only"}</td>
              <td className="mono">{site.secret_env_key || "—"}</td>
              <td><StatusPill type={site.status === "active" ? "active" : "pending"}>{site.status}</StatusPill></td>
              <td><div className="inline-actions"><button className="button ghost compact" type="button" onClick={() => beginEdit(site)}><Pencil size={12} /> Edit</button><select className="form-field compact-select" value={site.status} onChange={(event) => updateStatus(site.id, event.target.value)} aria-label={`Change ${site.display_name} status`}><option value="active">Active</option><option value="paused">Paused</option><option value="disconnected">Disconnected</option></select></div></td>
            </tr>
            {editingSiteId === Number(site.id) ? <tr>
              <td colSpan={5}>
                <form className="form-grid site-edit-form" onSubmit={saveEdit}>
                  <div className="form-group">
                    <label htmlFor={`edit-site-internal-name-${site.id}`}>Internal name</label>
                    <input id={`edit-site-internal-name-${site.id}`} className="form-field" value={editDraft.internalName} onChange={(event) => setEditDraft({ ...editDraft, internalName: event.target.value.toLowerCase() })} pattern="[a-z0-9_-]{2,120}" required />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`edit-site-display-name-${site.id}`}>Display name</label>
                    <input id={`edit-site-display-name-${site.id}`} className="form-field" value={editDraft.displayName} onChange={(event) => setEditDraft({ ...editDraft, displayName: event.target.value })} required />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`edit-site-secret-key-${site.id}`}>Secret environment key</label>
                    <input id={`edit-site-secret-key-${site.id}`} className="form-field mono" value={editDraft.secretEnvKey} onChange={(event) => setEditDraft({ ...editDraft, secretEnvKey: event.target.value.toUpperCase() })} pattern="[A-Z_][A-Z0-9_]*" required />
                    <small>The API checks this environment variable before saving. Its value is never shown.</small>
                  </div>
                  <div className="form-group">
                    <label htmlFor={`edit-site-endpoint-${site.id}`}>Reply endpoint URL</label>
                    <input id={`edit-site-endpoint-${site.id}`} className="form-field" type="url" value={editDraft.endpointBaseUrl} onChange={(event) => setEditDraft({ ...editDraft, endpointBaseUrl: event.target.value })} placeholder="https://site.example.com/chatmodz/replies" />
                    <small>Leave blank for inbound-only integrations.</small>
                  </div>
                  <div className="form-group">
                    <label htmlFor={`edit-site-integration-type-${site.id}`}>Integration type</label>
                    <select id={`edit-site-integration-type-${site.id}`} className="form-field" value={editDraft.integrationType} onChange={(event) => setEditDraft({ ...editDraft, integrationType: event.target.value })}>
                      <option value="hybrid">Hybrid</option>
                      <option value="webhook">Webhook</option>
                      <option value="api">API</option>
                    </select>
                  </div>
                  <div className="inline-actions full">
                    <button className="button amber compact" type="submit" disabled={editSaving}>{editSaving ? "Saving…" : "Save changes"}</button>
                    <button className="button ghost compact" type="button" onClick={() => setEditingSiteId(null)} disabled={editSaving}>Cancel</button>
                  </div>
                </form>
              </td>
            </tr> : null}
          </Fragment>) : <tr><td colSpan={5}>No connected sites have been added yet.</td></tr>}</tbody>
        </table>
      </div>
    </section>
  </>;
}

function AdminPage() {
  const { token, user } = useSession();
  const [tab, setTab] = useState<"applications" | "operators" | "sites" | "report" | "compensation">("applications");
  const [data, setData] = useState<AdminData>({ applications: [], operators: [], sites: [], report: {} });
  const [compensation, setCompensation] = useState<CompensationData>(emptyCompensation);
  const [levelDraft, setLevelDraft] = useState({ id: 0, name: "", rate: "0.05", currency: "EUR", description: "", active: true, isDefault: false });
  const [editingLevel, setEditingLevel] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    if (!token || (user?.admin ?? 0) < 2) return;
    setLoading(true);
    try {
      const [applications, operators, sites, report, compensationResponse] = await Promise.all([
        authFetch(token, "/api/chatmodz/admin/applications"),
        authFetch(token, "/api/chatmodz/admin/operators"),
        authFetch(token, "/api/chatmodz/admin/sites"),
        authFetch(token, "/api/chatmodz/admin/report"),
        authFetch(token, "/api/chatmodz/admin/compensation"),
      ]);
      setData({
        applications: applications.ok ? (await applications.json()).applications || [] : [],
        operators: operators.ok ? (await operators.json()).operators || [] : [],
        sites: sites.ok ? (await sites.json()).sites || [] : [],
        report: report.ok ? await report.json() : {},
      });
      if (compensationResponse.ok) setCompensation(await compensationResponse.json());
    } finally {
      setLoading(false);
    }
  }, [token, user?.admin]);
  useEffect(() => { load(); }, [load]);
  if ((user?.admin ?? 0) < 2) return <Shell><div className="page"><div className="empty-state panel"><AlertTriangle size={28} /><strong>Administrator access required</strong><span>This control room is restricted to Chatmodz administrators.</span></div></div></Shell>;
  const action = async (url: string, method = "POST", body?: unknown) => {
    const response = await authFetch(token, url, { method, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Action failed");
    return result;
  };
  if ((tab as string) === "sites") return <Shell><div className="page"><div className="page-head"><div><div className="eyebrow">Administrator control room</div><h1 className="page-title">Operations admin</h1><p className="page-subtitle">Applications, operators, connected sites, delivery health, attribution, and operator earnings.</p></div><button className="button ghost compact" onClick={load}><RefreshCw size={13} /> Refresh</button></div><div className="admin-tabs">{(["applications", "operators", "sites", "report", "compensation"] as const).map((item) => <button key={item} className={`filter-button ${tab === item ? "selected" : ""}`} onClick={() => setTab(item)}>{item === "applications" ? "Applications" : item === "operators" ? "Operators" : item === "sites" ? "Connected sites" : item === "report" ? "Reporting" : <><DollarSign size={13} /> Pay &amp; levels</>}</button>)}</div><SiteManagementPanel sites={data.sites} action={action} load={load} setNotice={setNotice} /><Toast message={notice} /></div></Shell>;
  const approve = async (id: number) => {
    try {
      const result = await action(`/api/chatmodz/admin/applications/${id}/approve`);
      setNotice(`Activation code: ${result.activationCode} — copy it now; it is shown once.`);
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Approval failed"); }
  };
  const reject = async (id: number) => {
    try { await action(`/api/chatmodz/admin/applications/${id}/reject`); setNotice("Application rejected"); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Rejection failed"); }
  };
  const setOperatorStatus = async (id: number, status: string) => {
    try { await action(`/api/chatmodz/admin/operators/${id}/status`, "POST", { status }); setNotice("Operator status updated"); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Status update failed"); }
  };
  const setSiteStatus = async (id: number, status: string) => {
    try { await action(`/api/chatmodz/admin/sites/${id}/status`, "POST", { status }); setNotice("Site status updated"); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Site update failed"); }
  };
  const editLevel = (level: CompensationLevel) => {
    setEditingLevel(level.id);
    setLevelDraft({ id: level.id, name: level.name, rate: (level.rateMinor / 100).toFixed(2), currency: level.currency, description: level.description, active: level.active, isDefault: level.isDefault });
  };
  const resetLevelDraft = () => {
    setEditingLevel(null);
    setLevelDraft({ id: 0, name: "", rate: "0.05", currency: "EUR", description: "", active: true, isDefault: false });
  };
  const saveLevel = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await action(editingLevel ? `/api/chatmodz/admin/levels/${editingLevel}` : "/api/chatmodz/admin/levels", editingLevel ? "PUT" : "POST", { name: levelDraft.name, rate: levelDraft.rate, currency: levelDraft.currency, description: levelDraft.description, active: levelDraft.active, isDefault: levelDraft.isDefault });
      setNotice(editingLevel ? "Operator level updated" : "Operator level created");
      resetLevelDraft();
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Level could not be saved"); }
  };
  const assignLevel = async (operatorId: number, levelId: string) => {
    try { await action(`/api/chatmodz/admin/operators/${operatorId}/level`, "POST", { levelId: Number(levelId) }); setNotice("Operator level assigned"); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Level assignment failed"); }
  };
  const updateEarningStatus = async (earningId: number, status: string) => {
    try { await action(`/api/chatmodz/admin/earnings/${earningId}/status`, "POST", { status }); setNotice("Earnings status updated"); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Earnings status failed"); }
  };
  const summary = data.report.summary || {};
  const compensationView = <div className="compensation-stack">
    <div className="metric-grid admin-metrics"><Metric label="Delivered replies" value={String(compensation.summary.totalMessages)} detail="Messages with an earnings snapshot" /><Metric label="Accrued" value={money(compensation.summary.accruedMinor)} detail="Pending plus paid" color="var(--teal)" /><Metric label="Pending payout" value={money(compensation.summary.pendingMinor)} detail="Ready for your payout process" color="var(--amber)" /><Metric label="Marked paid" value={money(compensation.summary.paidMinor)} detail="Admin-confirmed payouts" color="var(--ink)" /></div>
    <div className="compensation-grid">
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Operator levels</div><div className="panel-kicker">Rate snapshots apply to new delivered replies</div></div></div><form className="level-form" onSubmit={saveLevel}><div className="level-form-grid"><input className="form-field" placeholder="Level name" aria-label="Level name" value={levelDraft.name} onChange={(event) => setLevelDraft({ ...levelDraft, name: event.target.value })} required /><input className="form-field" type="number" min="0" step="0.01" placeholder="Rate" aria-label="Rate per message" value={levelDraft.rate} onChange={(event) => setLevelDraft({ ...levelDraft, rate: event.target.value })} required /><input className="form-field" maxLength={3} placeholder="EUR" aria-label="Currency" value={levelDraft.currency} onChange={(event) => setLevelDraft({ ...levelDraft, currency: event.target.value.toUpperCase() })} required /><input className="form-field level-description" placeholder="What qualifies this level?" aria-label="Level description" value={levelDraft.description} onChange={(event) => setLevelDraft({ ...levelDraft, description: event.target.value })} /><label className="checkbox-label"><input type="checkbox" checked={levelDraft.isDefault} onChange={(event) => setLevelDraft({ ...levelDraft, isDefault: event.target.checked })} /> Default for new replies</label></div><div className="inline-actions"><button className="button amber compact" type="submit">{editingLevel ? "Save level" : "Add level"}</button>{editingLevel && <button className="button ghost compact" type="button" onClick={resetLevelDraft}>Cancel</button>}</div></form><div className="table-wrap"><table className="data-table compensation-table"><thead><tr><th>Level</th><th>Rate / reply</th><th>Operators</th><th>State</th><th /></tr></thead><tbody>{compensation.levels.map((level) => <tr key={level.id}><td><strong>{level.name}</strong>{level.isDefault && <span className="default-label">Default</span>}<br /><span className="tiny-text">{level.description || "No description"}</span></td><td className="money-cell">{money(level.rateMinor, level.currency)}</td><td>{level.assignedOperators}</td><td><StatusPill type={level.active ? "active" : "paused"}>{level.active ? "Active" : "Paused"}</StatusPill></td><td><button className="button ghost compact" onClick={() => editLevel(level)}>Edit</button></td></tr>)}</tbody></table></div></section>
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Assign operator levels</div><div className="panel-kicker">Experience is managed per operator</div></div></div><div className="table-wrap"><table className="data-table compensation-table"><thead><tr><th>Operator</th><th>Current level</th><th>Lifetime earned</th><th /></tr></thead><tbody>{compensation.operators.map((operator) => <tr key={operator.id}><td><strong>{operator.fullName}</strong><br /><span className="tiny-text">{operator.email}</span></td><td><select className="form-field compact-select" value={operator.levelId || ""} onChange={(event) => assignLevel(operator.id, event.target.value)}><option value="" disabled>Select level</option>{compensation.levels.filter((level) => level.active).map((level) => <option key={level.id} value={level.id}>{level.name} · {money(level.rateMinor, level.currency)}</option>)}</select></td><td className="money-cell">{money(operator.earnedMinor, operator.currency || "EUR")}<small>{operator.earnedMessages} messages</small></td><td><StatusPill type={operator.status === "active" ? "active" : "pending"}>{operator.status}</StatusPill></td></tr>)}</tbody></table></div></section>
    </div>
    <section className="panel"><div className="panel-head"><div><div className="panel-title">Message earnings ledger</div><div className="panel-kicker">Every delivered reply keeps its original level and rate</div></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Message</th><th>Operator</th><th>Level</th><th>Amount</th><th>Recorded</th><th>Status</th><th>Action</th></tr></thead><tbody>{compensation.recent.length ? compensation.recent.map((earning) => <tr key={earning.id}><td className="mono">#{earning.messageId}</td><td>{earning.operatorName}</td><td>{earning.levelName}</td><td className="money-cell">{money(earning.rateMinor, earning.currency)}</td><td>{new Date(earning.createdAt).toLocaleString()}</td><td><StatusPill type={earning.status === "paid" ? "active" : earning.status === "void" ? "rejected" : "pending"}>{earning.status}</StatusPill></td><td>{earning.status !== "void" ? <select className="form-field compact-select" value={earning.status} onChange={(event) => updateEarningStatus(earning.id, event.target.value)}><option value="pending">Pending</option><option value="paid">Paid</option><option value="void">Void</option></select> : "—"}</td></tr>) : <tr><td colSpan={7}>No delivered replies have been recorded yet.</td></tr>}</tbody></table></div></section>
  </div>;
  return <Shell><div className="page"><div className="page-head"><div><div className="eyebrow">Administrator control room</div><h1 className="page-title">Operations admin</h1><p className="page-subtitle">Applications, operators, connected sites, delivery health, attribution, and operator earnings.</p></div><button className="button ghost compact" onClick={load}><RefreshCw size={13} /> Refresh</button></div><div className="admin-tabs">{(["applications", "operators", "sites", "report", "compensation"] as const).map((item) => <button key={item} className={`filter-button ${tab === item ? "selected" : ""}`} onClick={() => setTab(item)}>{item === "applications" ? "Applications" : item === "operators" ? "Operators" : item === "sites" ? "Connected sites" : item === "report" ? "Reporting" : <><DollarSign size={13} /> Pay &amp; levels</>}</button>)}</div>{loading ? <div className="empty-state panel"><RefreshCw className="spin" size={25} /><strong>Loading administrator data</strong></div> : tab === "compensation" ? compensationView : tab === "applications" ? <section className="panel"><div className="panel-head"><div><div className="panel-title">Operator applications</div><div className="panel-kicker">Approve to issue a one-time activation code</div></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Applicant</th><th>Location</th><th>Experience</th><th>Status</th><th>Actions</th></tr></thead><tbody>{data.applications.length ? data.applications.map((application) => <tr key={application.id}><td><strong>{application.full_name}</strong><br /><span className="tiny-text">{application.email}</span></td><td>{application.location || "—"}</td><td className="table-long">{application.experience || "—"}</td><td><StatusPill type={application.status === "pending" ? "pending" : "active"}>{application.status}</StatusPill></td><td>{application.status === "pending" ? <div className="inline-actions"><button className="button amber compact" onClick={() => approve(application.id)}>Approve</button><button className="button danger compact" onClick={() => reject(application.id)}>Reject</button></div> : "Reviewed"}</td></tr>) : <tr><td colSpan={5}>No applications returned from Chatmodz MySQL.</td></tr>}</tbody></table></div></section> : tab === "operators" ? <section className="panel"><div className="panel-head"><div><div className="panel-title">Operator directory</div><div className="panel-kicker">Status changes are audited server-side</div></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Operator</th><th>Role</th><th>Status</th><th>Last active</th><th>Action</th></tr></thead><tbody>{data.operators.map((operator) => <tr key={operator.id}><td><strong>{operator.full_name}</strong><br /><span className="tiny-text">{operator.email}</span></td><td>{operator.role}</td><td><StatusPill type={operator.status === "active" ? "active" : "pending"}>{operator.status}</StatusPill></td><td>{operator.last_active_at ? new Date(operator.last_active_at).toLocaleString() : "Never"}</td><td><select className="form-field compact-select" value={operator.status} onChange={(event) => setOperatorStatus(operator.id, event.target.value)}><option value="training">Training</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="rejected">Rejected</option></select></td></tr>)}</tbody></table></div></section> : tab === "sites" ? <section className="panel"><div className="panel-head"><div><div className="panel-title">Connected sites</div><div className="panel-kicker">Secrets remain in environment configuration; only the key name is shown</div></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Site</th><th>Endpoint</th><th>Secret env key</th><th>Status</th><th>Action</th></tr></thead><tbody>{data.sites.map((site) => <tr key={site.id}><td><strong>{site.display_name}</strong><br /><span className="tiny-text mono">{site.internal_name}</span></td><td className="table-long">{site.endpoint_base_url || "Inbound only"}</td><td className="mono">{site.secret_env_key || "—"}</td><td><StatusPill type={site.status === "active" ? "active" : "pending"}>{site.status}</StatusPill></td><td><select className="form-field compact-select" value={site.status} onChange={(event) => setSiteStatus(site.id, event.target.value)}><option value="active">Active</option><option value="paused">Paused</option><option value="disconnected">Disconnected</option></select></td></tr>)}</tbody></table></div></section> : <section className="panel"><div className="panel-head"><div><div className="panel-title">Delivery and attribution report</div><div className="panel-kicker">Site attribution is available only in this administrator view</div></div></div><div className="metric-grid admin-metrics"><Metric label="Conversations" value={String(summary.conversations || 0)} detail="Stored in Chatmodz" /><Metric label="Replies" value={String(summary.replies || 0)} detail="Operator-authored messages" color="var(--teal)" /><Metric label="Failed deliveries" value={String(summary.failed_deliveries || 0)} detail="Requires adapter follow-up" color="var(--red)" /></div><div className="report-columns"><div><h3>By operator</h3>{(data.report.byOperator || []).map((row) => <div className="report-line" key={row.id}><span>{row.name}</span><strong>{row.replies} replies</strong></div>)}</div><div><h3>By connected site</h3>{(data.report.bySite || []).map((row) => <div className="report-line" key={row.id}><span>{row.display_name} <small>{row.status}</small></span><strong>{row.conversations} conversations · {row.failed_deliveries || 0} failed</strong></div>)}</div></div></section>}<Toast message={notice} /></div></Shell>;
}

function AuthenticatedRouter() {
  const { user, loading } = useSession();
  const [location] = useLocation();
  if (loading) return <div className="auth-loading"><RefreshCw className="spin" size={24} /><span>Checking secure session…</span></div>;
  if (!user) return <Switch><Route path="/login" component={LoginPage} /><Route path="/apply" component={ApplyPage} /><Route path="/welcome" component={LandingPage} /><Route component={LandingPage} /></Switch>;
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={QueuePage} /><Route path="/earnings" component={EarningsPage} /><Route path="/conversation/:id" component={ConversationPage} /><Route path="/reports" component={ReportsPage} /><Route path="/admin" component={AdminPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function App() {
  const auth = useAuthState();
  return <QueryClientProvider client={queryClient}><AuthContext.Provider value={auth}><TooltipProvider><AuthenticatedRouter /><Toaster /></TooltipProvider></AuthContext.Provider></QueryClientProvider>;
}

export default App;