import { type ChangeEvent, type CSSProperties, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  Inbox,
  LockKeyhole,
  LogIn,
  LogOut,
  Menu,
  MessageSquare,
  Paperclip,
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
    if (value) return JSON.parse(value);
  } catch {
    // A missing browser storage should not prevent the login page from rendering.
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
        if (freshUser) {
          setUser(freshUser);
          localStorage.setItem("chatmodz_auth", JSON.stringify({ user: freshUser, token: initial.token }));
        } else {
          localStorage.removeItem("chatmodz_auth");
          setUser(null);
          setToken(null);
        }
      })
      .catch(() => undefined)
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
type Message = { id: number; u1: number; u2: number; message: string; time: number; read: number; mediaUrl?: string; mediaType?: string };
type Stats = { activeLocks: number; totalConversations: number; messagesSent: number };

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
    <header className="landing-nav"><Logo /><div className="landing-nav-actions"><Link href="/apply" className="button ghost">Apply to operate</Link><Link href="/login" className="button primary"><LogIn size={14} /> Operator sign in</Link></div></header>
    <main className="landing-main">
      <section className="landing-hero">
        <div className="eyebrow">Private conversation operations</div>
        <h1>Better conversations.<br /><em>One focused desk.</em></h1>
        <p>Chatmodz gives trained conversation operators a secure, distraction-free workspace for thoughtful replies across connected dating communities.</p>
        <div className="landing-actions"><Link href="/login" className="button amber">Open operator desk <ChevronRight size={15} /></Link><span className="landing-note"><ShieldCheck size={14} /> Source identities stay hidden from operators</span></div>
      </section>
      <section className="landing-grid">
        <article><div className="landing-icon"><Inbox size={18} /></div><h2>One live queue</h2><p>See only the conversations that need attention, with real member and managed-profile context.</p></article>
        <article><div className="landing-icon teal-icon"><LockKeyhole size={18} /></div><h2>Protected by design</h2><p>Conversation locks, short sessions, audit trails, and role-based access keep the desk accountable.</p></article>
        <article><div className="landing-icon"><Activity size={18} /></div><h2>Delivery you can trust</h2><p>Replies, media, notifications, and delivery activity are handled through authenticated site adapters.</p></article>
      </section>
    </main>
    <footer className="landing-footer"><span>Chatmodz operations desk</span><span>Built for privacy, clarity, and consistency.</span></footer>
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
    <div className="page-head"><div><div className="eyebrow">Operator queue / live</div><h1 className="page-title">Good morning, {user?.name?.split(" ")[0] || "operator"}.</h1><p className="page-subtitle">Work the real queue without exposing partner-site identity.</p></div><div className="queue-head-status"><StatusPill type="active">Live data</StatusPill><span className="tiny-text mono">Auto-refresh 15s</span></div></div>
    <div className="metric-grid"><Metric label="Open conversations" value={String(stats.totalConversations)} detail={`${unread} waiting for a reply`} /><Metric label="Your sent replies" value={String(stats.messagesSent)} detail="Recorded by the live activity log" color="var(--teal)" /><Metric label="Active locks" value={String(stats.activeLocks)} detail="Locks expire after 10 minutes" color="var(--ink)" /><Metric label="Queue status" value={loading ? "…" : "Live"} detail="No demo records are shown" color="var(--teal)" /></div>
    <section className="panel"><div className="panel-head"><div><div className="panel-title">Anonymous conversations</div><div className="panel-kicker" style={{ marginTop: 5 }}>Operator view · site origin withheld</div></div><button className="button ghost compact" onClick={refresh}><RefreshCw size={13} /> Refresh</button></div>
      <div className="filters">{(["all", "mine", "available"] as const).map((item) => <button key={item} className={`filter-button ${filter === item ? "selected" : ""}`} onClick={() => setFilter(item)}>{item === "all" ? "All conversations" : item === "mine" ? "Locked by me" : "Available"}</button>)}<div className="search-wrap"><Search size={15} /><input className="search-field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search names or messages" aria-label="Search conversations" /></div></div>
      <div className="queue-list">{loading ? <div className="empty-state"><RefreshCw className="spin" size={25} /><strong>Loading live conversations</strong><span>Fetching the authenticated operator queue.</span></div> : filtered.length ? filtered.map((conversation, index) => <ConversationRow key={conversation.key} conversation={conversation} userId={user?.id || 0} onOpen={() => setLocation(`/conversation/${conversation.key}`)} style={{ animationDelay: `${index * 35}ms` }} />) : <div className="empty-state"><Inbox size={27} /><strong>No conversations match this view</strong><span>The live source returned no matching conversations.</span></div>}</div>
    </section><Toast message={notice} />
  </div></Shell>;
}

function ConversationRow({ conversation, userId, onOpen, style }: { conversation: Conversation; userId: number; onOpen: () => void; style?: CSSProperties }) {
  const needsReply = !conversation.lastSenderFake;
  const mine = conversation.lock?.moderatorId === userId;
  const otherLock = conversation.lock && !mine;
  return <button className={`queue-row live-row ${needsReply ? "needs-reply" : ""}`} onClick={onOpen} style={style}>
    <div className="queue-person"><div className="avatar-stack"><Avatar photo={conversation.fakeUser.photo} name={conversation.fakeUser.name} size={36} /><Avatar photo={conversation.realUser.photo} name={conversation.realUser.name} size={22} /></div><div><strong>{conversation.fakeUser.name} <span className="arrow-muted">→</span> {conversation.realUser.name}</strong><small>{conversation.msgCount} messages · {timeAgo(conversation.lastTime)}</small></div></div>
    <div className="queue-snippet"><strong><span className={`priority-dot ${needsReply ? "high" : "normal"}`} />{conversation.lastMessage || "No text in the latest message"}</strong><small>{needsReply ? "Reply needed" : conversation.lastMsgRead ? "Follow-up available" : "Waiting for member"} · source hidden</small></div>
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
  const selected = conversations.find((conversation) => conversation.key === params.id);
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<Record<string, ConvUser>>({});
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [media, setMedia] = useState<{ file: File; preview: string; type: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(Boolean(selected));
  const [sending, setSending] = useState(false);
  const [locking, setLocking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lockedByMe = selected?.lock?.moderatorId === user?.id;
  const isAdmin = (user?.admin ?? 0) >= 2;
  const meaningful = countMeaningfulChars(draft);
  const canSend = Boolean(selected && lockedByMe && (draft.trim() || media) && (isAdmin || meaningful >= MIN_REPLY_CHARS));

  const loadMessages = useCallback(async () => {
    if (!selected || !token) return;
    setLoading(true);
    const response = await authFetch(token, `/api/chatmodz/conversations/${selected.key}/messages`);
    if (response.ok) {
      const data = await response.json();
      setMessages(data.messages || []);
      setUsers(data.users || {});
    }
    setLoading(false);
  }, [selected, token]);
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
      <section className="panel conversation-main"><div className="conversation-top"><div className="conversation-identity"><div className="avatar-stack large"><Avatar photo={selected.fakeUser.photo} name={selected.fakeUser.name} size={44} /><Avatar photo={selected.realUser.photo} name={selected.realUser.name} size={26} /></div><div><h2>{selected.fakeUser.name} <span className="arrow-muted">→</span> {selected.realUser.name}</h2><small>Real participant context · connected source identity withheld</small></div></div><div className="conversation-actions">{selected.lock && <StatusPill type={lockedByMe ? "active" : "pending"}>{lockedByMe ? "Locked by you" : "Locked"}</StatusPill>}<button className={`button compact ${lockedByMe ? "ghost" : "amber"}`} onClick={toggleLock} disabled={locking || (selected.lock !== null && !lockedByMe)}>{lockedByMe ? <><UnlockKeyhole size={13} /> Release</> : <><LockKeyhole size={13} /> Lock to me</>}</button></div></div>
        <div className="messages">{loading ? <div className="empty-state"><RefreshCw className="spin" size={24} /><strong>Loading messages</strong></div> : messages.length ? messages.map((message, index) => { const byFake = message.u1 === selected.fakeUser.id; const sender = users[String(message.u1)] || (byFake ? selected.fakeUser : selected.realUser); return <div key={message.id} className={`message ${byFake ? "operator" : "member"}`}><Avatar photo={sender.photo} name={sender.name} size={27} /><div><div className="bubble">{message.mediaUrl && <MediaBubble message={message} />}{message.message && <p>{message.message}</p>}<div className="message-meta">{timeAgo(message.time)} {index === messages.length - 1 && <strong>{byFake ? "Waiting for member" : "Needs reply"}</strong>}</div></div></div></div>; }) : <div className="empty-state"><MessageSquare size={25} /><strong>No messages in this conversation</strong><span>The connected source returned an empty thread.</span></div>}</div>
        <div className="composer">{suggestions.length > 0 && <div className="canned-row">{suggestions.map((suggestion) => <button key={suggestion} className="canned" onClick={() => setDraft(suggestion)}>{suggestion}</button>)}</div>}{media && <div className="media-pending"><span>{media.type} attached</span><button className="icon-button" onClick={() => { URL.revokeObjectURL(media.preview); setMedia(null); }} aria-label="Remove attachment"><X size={14} /></button></div>}<div className="composer-row"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} onCopy={(event) => { if (!isAdmin) event.preventDefault(); }} onCut={(event) => { if (!isAdmin) event.preventDefault(); }} onPaste={(event) => { if (!isAdmin) event.preventDefault(); }} onDrop={(event) => { if (!isAdmin) event.preventDefault(); }} placeholder={lockedByMe ? "Write a thoughtful reply…" : "Lock this conversation before replying"} disabled={!lockedByMe || sending} aria-label="Reply message" /><div className="composer-tools"><input ref={inputRef} type="file" accept="image/*,video/*,audio/*" hidden onChange={handleFile} /><button className="icon-button" onClick={() => inputRef.current?.click()} disabled={!lockedByMe || sending} aria-label="Attach media"><Paperclip size={16} /></button><button className="button primary" onClick={send} disabled={!canSend || sending}><Send size={14} /> {sending ? "Sending…" : "Send"}</button></div></div><div className={`reply-counter ${!isAdmin && meaningful > 0 && meaningful < MIN_REPLY_CHARS ? "short" : ""}`}>{isAdmin ? "Administrator override enabled" : `${meaningful}/${MIN_REPLY_CHARS} non-space characters required`} · Enter to send, Shift+Enter for a new line</div></div>
      </section>
      <aside className="panel conversation-side"><div className="side-section"><div className="side-title">Conversation details</div><div className="detail-line"><span>Latest activity</span><span>{timeAgo(selected.lastTime)}</span></div><div className="detail-line"><span>Messages</span><span>{selected.msgCount}</span></div><div className="detail-line"><span>Assignment</span><span>{lockedByMe ? "You" : selected.lock ? selected.lock.moderatorName : "Available"}</span></div></div><div className="side-section"><div className="side-title">Operator guardrails</div><div className="notice"><ShieldCheck size={13} /> Partner-site identity is never shown here. Keep replies warm, direct, and personal.</div></div><div className="side-section"><div className="side-title">Lock policy</div><div className="tiny-text"><Clock3 size={13} style={{ verticalAlign: "middle", marginRight: 5 }} /> Locks last 10 minutes and are renewed while this conversation is open.</div></div></aside>
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
    <div className="metric-grid"><Metric label="Total conversations" value={String(stats.totalConversations)} detail="Real cross-user threads" /><Metric label="Waiting for reply" value={String(needsReply)} detail="Latest sender is a member" color="var(--teal)" /><Metric label="Active locks" value={String(locked)} detail="Current queue snapshot" color="var(--ink)" /><Metric label="Replies by you" value={String(stats.messagesSent)} detail="Recorded in the activity log" color="var(--teal)" /></div>
    <section className="panel report-panel"><div className="panel-head"><div><div className="panel-title">Queue accountability</div><div className="panel-kicker" style={{ marginTop: 5 }}>No synthetic charts or placeholder rows</div></div><CircleHelp size={17} color="var(--ink-soft)" /></div><div className="report-list"><div><span>Authenticated data source</span><strong>{loading ? "Loading…" : "Connected"}</strong></div><div><span>Conversation locks</span><strong>{stats.activeLocks} active</strong></div><div><span>Replies attributed to current operator</span><strong>{stats.messagesSent}</strong></div><div><span>Site attribution</span><strong>Administrator-only adapter data</strong></div></div><div className="report-callout"><ShieldCheck size={17} /><div><strong>Privacy boundary is active</strong><p>Operator responses include real participants and photos needed for the conversation, but no connected-site name, domain, or source identifier is exposed.</p></div></div></section><Toast message={notice} /></div></Shell>;
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

function AdminPage() {
  const { token, user } = useSession();
  const [tab, setTab] = useState<"applications" | "operators" | "sites" | "report">("applications");
  const [data, setData] = useState<AdminData>({ applications: [], operators: [], sites: [], report: {} });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    if (!token || (user?.admin ?? 0) < 2) return;
    setLoading(true);
    try {
      const [applications, operators, sites, report] = await Promise.all([
        authFetch(token, "/api/chatmodz/admin/applications"),
        authFetch(token, "/api/chatmodz/admin/operators"),
        authFetch(token, "/api/chatmodz/admin/sites"),
        authFetch(token, "/api/chatmodz/admin/report"),
      ]);
      setData({
        applications: applications.ok ? (await applications.json()).applications || [] : [],
        operators: operators.ok ? (await operators.json()).operators || [] : [],
        sites: sites.ok ? (await sites.json()).sites || [] : [],
        report: report.ok ? await report.json() : {},
      });
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
  const summary = data.report.summary || {};
  return <Shell><div className="page"><div className="page-head"><div><div className="eyebrow">Administrator control room</div><h1 className="page-title">Operations admin</h1><p className="page-subtitle">Applications, operators, connected sites, delivery health, and attribution.</p></div><button className="button ghost compact" onClick={load}><RefreshCw size={13} /> Refresh</button></div><div className="admin-tabs">{(["applications", "operators", "sites", "report"] as const).map((item) => <button key={item} className={`filter-button ${tab === item ? "selected" : ""}`} onClick={() => setTab(item)}>{item === "applications" ? "Applications" : item === "operators" ? "Operators" : item === "sites" ? "Connected sites" : "Reporting"}</button>)}</div>{loading ? <div className="empty-state panel"><RefreshCw className="spin" size={25} /><strong>Loading administrator data</strong></div> : tab === "applications" ? <section className="panel"><div className="panel-head"><div><div className="panel-title">Operator applications</div><div className="panel-kicker">Approve to issue a one-time activation code</div></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Applicant</th><th>Location</th><th>Experience</th><th>Status</th><th>Actions</th></tr></thead><tbody>{data.applications.length ? data.applications.map((application) => <tr key={application.id}><td><strong>{application.full_name}</strong><br /><span className="tiny-text">{application.email}</span></td><td>{application.location || "—"}</td><td className="table-long">{application.experience || "—"}</td><td><StatusPill type={application.status === "pending" ? "pending" : "active"}>{application.status}</StatusPill></td><td>{application.status === "pending" ? <div className="inline-actions"><button className="button amber compact" onClick={() => approve(application.id)}>Approve</button><button className="button danger compact" onClick={() => reject(application.id)}>Reject</button></div> : "Reviewed"}</td></tr>) : <tr><td colSpan={5}>No applications returned from Chatmodz MySQL.</td></tr>}</tbody></table></div></section> : tab === "operators" ? <section className="panel"><div className="panel-head"><div><div className="panel-title">Operator directory</div><div className="panel-kicker">Status changes are audited server-side</div></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Operator</th><th>Role</th><th>Status</th><th>Last active</th><th>Action</th></tr></thead><tbody>{data.operators.map((operator) => <tr key={operator.id}><td><strong>{operator.full_name}</strong><br /><span className="tiny-text">{operator.email}</span></td><td>{operator.role}</td><td><StatusPill type={operator.status === "active" ? "active" : "pending"}>{operator.status}</StatusPill></td><td>{operator.last_active_at ? new Date(operator.last_active_at).toLocaleString() : "Never"}</td><td><select className="form-field compact-select" value={operator.status} onChange={(event) => setOperatorStatus(operator.id, event.target.value)}><option value="training">Training</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="rejected">Rejected</option></select></td></tr>)}</tbody></table></div></section> : tab === "sites" ? <section className="panel"><div className="panel-head"><div><div className="panel-title">Connected sites</div><div className="panel-kicker">Secrets remain in environment configuration; only the key name is shown</div></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Site</th><th>Endpoint</th><th>Secret env key</th><th>Status</th><th>Action</th></tr></thead><tbody>{data.sites.map((site) => <tr key={site.id}><td><strong>{site.display_name}</strong><br /><span className="tiny-text mono">{site.internal_name}</span></td><td className="table-long">{site.endpoint_base_url || "Inbound only"}</td><td className="mono">{site.secret_env_key || "—"}</td><td><StatusPill type={site.status === "active" ? "active" : "pending"}>{site.status}</StatusPill></td><td><select className="form-field compact-select" value={site.status} onChange={(event) => setSiteStatus(site.id, event.target.value)}><option value="active">Active</option><option value="paused">Paused</option><option value="disconnected">Disconnected</option></select></td></tr>)}</tbody></table></div></section> : <section className="panel"><div className="panel-head"><div><div className="panel-title">Delivery and attribution report</div><div className="panel-kicker">Site attribution is available only in this administrator view</div></div></div><div className="metric-grid admin-metrics"><Metric label="Conversations" value={String(summary.conversations || 0)} detail="Stored in Chatmodz" /><Metric label="Replies" value={String(summary.replies || 0)} detail="Operator-authored messages" color="var(--teal)" /><Metric label="Failed deliveries" value={String(summary.failed_deliveries || 0)} detail="Requires adapter follow-up" color="var(--red)" /></div><div className="report-columns"><div><h3>By operator</h3>{(data.report.byOperator || []).map((row) => <div className="report-line" key={row.id}><span>{row.name}</span><strong>{row.replies} replies</strong></div>)}</div><div><h3>By connected site</h3>{(data.report.bySite || []).map((row) => <div className="report-line" key={row.id}><span>{row.display_name} <small>{row.status}</small></span><strong>{row.conversations} conversations · {row.failed_deliveries || 0} failed</strong></div>)}</div></div></section>}<Toast message={notice} /></div></Shell>;
}

function AuthenticatedRouter() {
  const { user, loading } = useSession();
  const [location] = useLocation();
  if (loading) return <div className="auth-loading"><RefreshCw className="spin" size={24} /><span>Checking secure session…</span></div>;
  if (!user) return <Switch><Route path="/login" component={LoginPage} /><Route path="/apply" component={ApplyPage} /><Route path="/welcome" component={LandingPage} /><Route component={LandingPage} /></Switch>;
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={QueuePage} /><Route path="/conversation/:id" component={ConversationPage} /><Route path="/reports" component={ReportsPage} /><Route path="/admin" component={AdminPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function App() {
  const auth = useAuthState();
  return <QueryClientProvider client={queryClient}><AuthContext.Provider value={auth}><TooltipProvider><AuthenticatedRouter /><Toaster /></TooltipProvider></AuthContext.Provider></QueryClientProvider>;
}

export default App;