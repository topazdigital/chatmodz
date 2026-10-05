import { Fragment, type ChangeEvent, type CSSProperties, type FormEvent, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Switch, useLocation, useParams } from "wouter";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  CalendarDays,
  ClipboardCheck,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  DollarSign,
  Inbox,
  LockKeyhole,
  MapPin,
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
  Trash2,
  UnlockKeyhole,
  UserRound,
  UserPlus,
  UsersRound,
  Eye,
  Volume2,
  X,
} from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();
const MIN_REPLY_CHARS = 75;

type AuthUser = {
  id: number;
  name: string;
  email: string;
  photo?: string;
  photoThumb?: string;
  admin?: number;
  role?: "operator" | "recruiter" | "admin";
  status?: string;
  assessmentStatus?: string;
};

type AuthState = { user: AuthUser | null; token: string | null; loading: boolean };
const AuthContext = createContext<AuthState & {
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}>({
  user: null,
  token: null,
  loading: true,
  login: async () => undefined,
  logout: () => undefined,
  refreshUser: async () => undefined,
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

function useAuthState(): AuthState & {
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
} {
  const [initial] = useState(storedAuth);
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

  const refreshUser = useCallback(async () => {
    if (!token) return;
    const response = await authFetch(token, "/api/chatmodz/auth/me");
    if (!response.ok) return;
    const freshUser = await response.json();
    if (freshUser && typeof freshUser.id === "number") {
      setUser(freshUser);
      localStorage.setItem("chatmodz_auth", JSON.stringify({ user: freshUser, token }));
    }
  }, [token]);

  return { user, token, loading, login, logout, refreshUser };
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

type ProfileDetails = { location?: string; bio?: string; age?: number; gallery?: string[]; details?: Record<string, string> };
type ConvUser = { id: number; name: string; photo?: string; profile?: ProfileDetails };
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
type OperatorNote = { id: number | string; text: string; createdAt: string; authorName: string };

function readOperatorNotes(payload: { noteHistory?: unknown; notes?: ConversationNotes } | null, conversationKey: string): OperatorNote[] {
  if (Array.isArray(payload?.noteHistory) && payload.noteHistory.length) {
    return payload.noteHistory as OperatorNote[];
  }
  const legacyNote = payload?.notes;
  if (!legacyNote?.text?.trim()) return [];
  return [{
    id: `legacy-${conversationKey}`,
    text: legacyNote.text,
    createdAt: legacyNote.updatedAt || "",
    authorName: legacyNote.updatedByName || "Previous operator",
  }];
}

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
  const value = photo?.trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (/^(https?:|data:|blob:)/i.test(value) || value.startsWith("/")) return value;
  return `/api/uploads/${encodeURIComponent(value)}`;
}

function useImageSource(url: string, token?: string | null) {
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState("");
  useEffect(() => {
    let objectUrl = "";
    const controller = new AbortController();
    setFailed(false);
    setSource("");
    if (!url) return;
    if (!url.startsWith("/api/chatmodz/profile-photo")) {
      setSource(url);
      return;
    }
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    fetch(url, { headers, signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Image unavailable");
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, token]);
  return { source, failed, markFailed: () => setFailed(true) };
}

function Avatar({ photo, name, size = 36, shape = "circle" }: { photo?: string; name: string; size?: number; shape?: "circle" | "square" }) {
  const { token } = useSession();
  const resolved = photoUrl(photo);
  const { source, failed, markFailed } = useImageSource(resolved, token);
  const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.32) };
  if (source && !failed) {
    return <img className={`real-avatar ${shape === "square" ? "avatar-square" : ""}`} src={source} alt={name} style={style} onError={markFailed} />;
  }
  return <div className={`avatar ${shape === "square" ? "avatar-square" : ""}`} style={style}>{initials || "?"}</div>;
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
      <p>Sign in with the email you used to apply and the password you created during activation.</p>
      {import.meta.env.DEV && <div className="notice" style={{ marginBottom: 18 }}><ShieldCheck size={13} /> Replit demo: administrator, recruiter, and operator accounts use their configured demo emails with the same development password.</div>}
      <form onSubmit={submit} className="auth-form">
        <label htmlFor="identifier">Operator email</label>
        <input id="identifier" className="form-field" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input id="password" className="form-field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        {error && <div className="auth-error"><AlertTriangle size={14} />{error}</div>}
        <button className="button primary auth-submit" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"} <ChevronRight size={15} /></button>
      </form>
      <div className="auth-links"><Link href="/activate" className="auth-back">Have an activation code? Set your password</Link><Link href="/apply" className="auth-back">Apply to become an operator</Link><Link href="/welcome" className="auth-back"><ChevronLeft size={14} /> Back to Chatmodz</Link></div>
    </div>
  </div>;
}

function ActivationPage() {
  const [, setLocation] = useLocation();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [activated, setActivated] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/chatmodz/auth/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not activate this operator account");
      setActivated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not activate this operator account");
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="auth-page">
    <div className="auth-card">
      <Logo />
      <div className="eyebrow">First-time operator setup</div>
      <h1>Set your password.</h1>
      {activated ? <div className="application-success">
        <ShieldCheck size={24} />
        <strong>Account activated.</strong>
        <span>Your activation code has been used. Sign in with your application email and the password you just created.</span>
        <button className="button primary" type="button" onClick={() => setLocation("/login")}>Continue to sign in <ChevronRight size={15} /></button>
      </div> : <>
        <p>Your administrator’s one-time code is used here to create your login password. The code itself is not your password.</p>
        <form onSubmit={submit} className="auth-form">
          <label htmlFor="activation-code">One-time activation code</label>
          <input id="activation-code" className="form-field mono" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" required />
          <label htmlFor="new-password">Create password</label>
          <input id="new-password" className="form-field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={10} required />
          <small>Use at least 10 characters. This is the password you will use after activation.</small>
          <label htmlFor="confirm-password">Confirm password</label>
          <input id="confirm-password" className="form-field" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={10} required />
          {error && <div className="auth-error"><AlertTriangle size={14} />{error}</div>}
          <button className="button primary auth-submit" disabled={submitting}>{submitting ? "Activating…" : "Activate account"} <ChevronRight size={15} /></button>
        </form>
        <div className="auth-links"><Link href="/login" className="auth-back">Already activated? Sign in</Link><Link href="/welcome" className="auth-back"><ChevronLeft size={14} /> Back to Chatmodz</Link></div>
      </>}
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
  { href: "/", label: "Queue", icon: Inbox, roles: ["operator", "admin"] },
  { href: "/training", label: "Operator training", icon: ClipboardCheck, roles: ["operator"] },
  { href: "/earnings", label: "Earnings", icon: DollarSign, roles: ["operator", "admin"] },
  { href: "/reports", label: "Reports", icon: BarChart3, roles: ["admin"] },
  { href: "/recruiter", label: "Recruiter desk", icon: UsersRound, roles: ["recruiter", "admin"] },
  { href: "/reviews", label: "Operator tests", icon: ClipboardCheck, roles: ["recruiter", "admin"] },
  { href: "/admin", label: "Admin", icon: ShieldCheck, roles: ["admin"] },
];

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const current = navItems.find((item) => item.href === location)?.label ?? "Conversation";
  const initials = user?.name?.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
  const liveOperatorAccess = user?.role !== "operator" || (user.status === "active" && user.assessmentStatus === "approved");
  return <div className="app-frame">
    <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
      <Logo />
      <div className="sidebar-label">Operations</div>
      <nav>{navItems.filter((item) => item.roles.includes(user?.role || ((user?.admin ?? 0) >= 2 ? "admin" : "operator")) && (item.href === "/training" ? user?.assessmentStatus !== "approved" : (item.href !== "/" && item.href !== "/earnings") || liveOperatorAccess)).map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`nav-link ${location === href ? "active" : ""}`} onClick={() => setMobileOpen(false)}><Icon /><span>{label}</span></Link>)}</nav>
      <div className="sidebar-label">Workspace</div>
      <Link href="/settings" className={`nav-link ${location === "/settings" ? "active" : ""}`} onClick={() => setMobileOpen(false)}><UserRound /><span>Account</span></Link>
      <div className="sidebar-spacer" />
      <div className="operator-chip"><Avatar photo={user?.photo} name={user?.name || "Operator"} size={32} /><div><strong>{user?.name || "Operator"}</strong><small>{user?.role === "admin" || (user?.admin ?? 0) >= 2 ? "Administrator" : user?.role === "recruiter" ? "Recruiter" : "Operator"} · active</small></div><button className="icon-button" style={{ marginLeft: "auto", color: "#9aa7b8" }} aria-label="Sign out" onClick={() => { logout(); setLocation("/login"); }}><LogOut size={15} /></button></div>
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
  const [filter, setFilter] = useState<"all" | "mine" | "available">("all");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [notice, setNotice] = useState("");
  const filtered = useMemo(() => conversations.filter((conversation) => {
    const matchesFilter = filter === "all" || (filter === "mine" ? conversation.lock?.moderatorId === user?.id : !conversation.lock);
    const haystack = `${conversation.fakeUser.name} ${conversation.realUser.name} ${conversation.lastMessage}`.toLowerCase();
    return matchesFilter && haystack.includes(search.toLowerCase());
  }), [conversations, filter, search, user?.id]);
  useEffect(() => {
    if (!filtered.some((conversation) => conversation.key === selectedKey)) setSelectedKey(filtered[0]?.key || "");
  }, [filtered, selectedKey]);
  const unread = conversations.filter((conversation) => !conversation.lastSenderFake).length;
  const refresh = async () => { await reload(); setNotice("Queue refreshed"); window.setTimeout(() => setNotice(""), 2200); };
  return <Shell><div className="page">
    <div className="page-head"><div><div className="eyebrow">Operator queue / live</div><h1 className="page-title">Good morning, {user?.name?.split(" ")[0] || "operator"}.</h1><p className="page-subtitle">Work the live conversation queue and keep every reply moving.</p></div><div className="queue-head-status"><StatusPill type="active">Live data</StatusPill><span className="tiny-text mono">Auto-refresh 15s</span></div></div>
    <div className="metric-grid"><Metric label="Open conversations" value={String(stats.totalConversations)} detail={`${unread} waiting for a reply`} /><Metric label="Your sent replies" value={String(stats.messagesSent)} detail="Recorded by the live activity log" color="var(--teal)" /><Metric label="Active locks" value={String(stats.activeLocks)} detail="Locks expire after 10 minutes" color="var(--ink)" /><Metric label="Queue status" value={loading ? "…" : "Live"} detail="No demo records are shown" color="var(--teal)" /></div>
      <div className="queue-workspace">
        <section className="panel queue-panel"><div className="panel-head"><div><div className="panel-title">Conversations</div><div className="panel-kicker" style={{ marginTop: 5 }}>Select a chat to open it beside the queue</div></div><button className="button ghost compact" onClick={refresh}><RefreshCw size={13} /> Refresh</button></div>
         <div className="filters">{(["all", "mine", "available"] as const).map((item) => <button key={item} className={`filter-button ${filter === item ? "selected" : ""}`} onClick={() => setFilter(item)}>{item === "all" ? "All" : item === "mine" ? "Mine" : "Available"}</button>)}<div className="search-wrap"><Search size={15} /><input className="search-field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></div></div>
         <div className="queue-list">{loading ? <div className="empty-state"><RefreshCw className="spin" size={25} /><strong>Loading live conversations</strong><span>Fetching the authenticated operator queue.</span></div> : filtered.length ? filtered.map((conversation, index) => <ConversationRow key={conversation.key} conversation={conversation} userId={user?.id || 0} selected={conversation.key === selectedKey} onOpen={() => setSelectedKey(conversation.key)} style={{ animationDelay: `${index * 35}ms` }} />) : <div className="empty-state"><Inbox size={27} /><strong>No conversations match this view</strong><span>The live source returned no matching conversations.</span></div>}</div>
        </section>
         <div className="queue-detail"><ConversationPage inline embeddedKey={selectedKey} /></div>
      </div>
      <Toast message={notice} />
  </div></Shell>;
}

type TrainingAssessment = {
  id: number;
  status: string;
  auto_passed?: boolean;
  typing_wpm?: number;
  typing_accuracy?: number;
  quiz_score?: number;
  submitted_at?: string;
  reviewer_note?: string;
  passage_id?: number;
};

type TrainingData = {
  thresholds: { typingWpm: number; typingAccuracy: number; quizScore: number; replyCharacters: number; testSeconds: number };
  policyVersion: string;
  policies: { title: string; detail: string }[];
  quiz: { id: string; prompt: string; options: { id: string; text: string }[] }[];
  scenarios: { id: string; memberMessage: string }[];
  assessment: TrainingAssessment | null;
};

type TypingAttempt = { id: number; passage: string; startedAt: string };

function TrainingPage() {
  const { token, user, refreshUser } = useSession();
  const [data, setData] = useState<TrainingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({});
  const [practiceResponses, setPracticeResponses] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState<TypingAttempt | null>(null);
  const [typedText, setTypedText] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(60);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const response = await authFetch(token, "/api/chatmodz/training");
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Training materials could not be loaded");
      setData(result);
      const current = result.assessment;
      if (current?.status === "in_progress" && current.passage) {
        const startedAt = current.started_at || current.startedAt || (current.startedAtMs ? new Date(Number(current.startedAtMs)).toISOString() : new Date().toISOString());
        setAttempt({ id: Number(current.id), passage: current.passage, startedAt });
        setSecondsLeft(Math.max(0, 60 - Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Training materials could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { void refreshUser(); }, 20000);
    return () => window.clearInterval(timer);
  }, [refreshUser]);
  useEffect(() => {
    if (!attempt) return;
    const update = () => {
      const elapsed = Math.max(0, (Date.now() - new Date(attempt.startedAt).getTime()) / 1000);
      setSecondsLeft(Math.max(0, Math.ceil(60 - elapsed)));
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [attempt]);

  const elapsedSeconds = attempt ? Math.max(1, 60 - secondsLeft) : 1;
  const correctChars = attempt
    ? Array.from(typedText).reduce((count, character, index) => count + (character === Array.from(attempt.passage)[index] ? 1 : 0), 0)
    : 0;
  const liveWpm = Math.round((correctChars / 5 / elapsedSeconds) * 60);
  const liveAccuracy = attempt
    ? Math.round((correctChars / Math.max(1, Array.from(typedText).length)) * 100)
    : 0;

  const startTypingTest = async () => {
    if (!token) return;
    setStarting(true);
    setNotice("");
    try {
      const response = await authFetch(token, "/api/chatmodz/training/start", { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Typing test could not be started");
      setAttempt({ id: Number(result.id), passage: result.passage, startedAt: result.startedAt });
      setTypedText("");
      setSecondsLeft(60);
      setRulesAccepted(false);
      setQuizAnswers({});
      setPracticeResponses({});
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Typing test could not be started");
    } finally {
      setStarting(false);
    }
  };

  const submitAssessment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !data || !attempt) return;
    if (secondsLeft > 0) return setNotice("Complete the 60-second typing test before submitting.");
    if (!rulesAccepted) return setNotice("Confirm that you have read and agree to follow the operator rules.");
    if (data.quiz.some((question) => !quizAnswers[question.id])) return setNotice("Answer every safety and communication question.");
    if (data.scenarios.some((scenario) => (practiceResponses[scenario.id] || "").replace(/\s/g, "").length < data.thresholds.replyCharacters)) {
      return setNotice(`Each practice reply must contain at least ${data.thresholds.replyCharacters} non-whitespace characters.`);
    }
    setSubmitting(true);
    setNotice("");
    try {
      const response = await authFetch(token, `/api/chatmodz/training/${attempt.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ typedText, answers: quizAnswers, practiceResponses, rulesAccepted }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Assessment could not be submitted");
      setNotice(result.message || "Assessment submitted.");
      setAttempt(null);
      setTypedText("");
      await load();
      await refreshUser();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Assessment could not be submitted");
    } finally {
      setSubmitting(false);
    }
  };

  const status = data?.assessment?.status || "not_started";
  const awaitingReview = status === "submitted" && Boolean(data?.assessment?.auto_passed);
  const rejected = status === "rejected";

  if (loading) return <div className="auth-loading"><RefreshCw className="spin" size={24} /><span>Loading operator training…</span></div>;
  if (!data) return <Shell><div className="page"><div className="empty-state panel"><AlertTriangle size={28} /><strong>Training is temporarily unavailable</strong><span>{notice || "The training service could not be reached."}</span><button className="button amber" onClick={load}>Try again</button></div></div></Shell>;

  return <Shell><div className="page training-page">
    <div className="page-head"><div><div className="eyebrow">Operator onboarding / required assessment</div><h1 className="page-title">Training before live chats</h1><p className="page-subtitle">Complete the typing test, safety quiz, and practice chats. A recruiter or administrator must approve your results before live conversations unlock.</p></div><StatusPill type={awaitingReview ? "pending" : status === "approved" ? "active" : "training"}>{awaitingReview ? "Awaiting human review" : status.replace("_", " ")}</StatusPill></div>
    {notice && <div className="training-notice" role="status"><AlertTriangle size={16} />{notice}</div>}
    {status === "approved" ? <section className="panel training-result success-result"><ShieldCheck size={24} /><div><strong>Training approved</strong><p>Your recruiter or administrator has approved your assessment. Your live operator access is being refreshed.</p></div></section> : awaitingReview ? <section className="panel training-result"><Clock3 size={24} /><div><strong>Automatic checks passed — review pending</strong><p>Your typing and quiz results passed. Live chats stay locked until an authorized reviewer checks your practice responses.</p></div></section> : rejected ? <section className="panel training-result"><AlertTriangle size={24} /><div><strong>Practice chats need another review</strong><p>{data.assessment?.reviewer_note || "Review the rules and try the assessments again."}</p></div></section> : null}
    {data.assessment && status !== "in_progress" && <section className="training-score-strip"><div><span>Latest typing speed</span><strong>{data.assessment.typing_wpm ?? "—"} WPM</strong></div><div><span>Typing accuracy</span><strong>{data.assessment.typing_accuracy ?? "—"}%</strong></div><div><span>Safety quiz</span><strong>{data.assessment.quiz_score ?? "—"}%</strong></div><div><span>Automatic result</span><strong>{data.assessment.auto_passed ? "Passed" : "Retake required"}</strong></div></section>}
    <form className="training-layout" onSubmit={submitAssessment}>
      <section className="panel training-section">
        <div className="training-section-head"><span className="training-step">01</span><div><h2>Communication and safety rules</h2><p>Read all rules. Your acknowledgment is saved with your test attempt and policy version.</p></div></div>
        <div className="training-rules">{data.policies.map((policy) => <article key={policy.title}><strong>{policy.title}</strong><p>{policy.detail}</p></article>)}</div>
        <label className="training-ack"><input type="checkbox" checked={rulesAccepted} onChange={(event) => setRulesAccepted(event.target.checked)} /><span>I have read and agree to follow these rules, including using Panic Room only for the listed severe safety issues.</span></label>
        <small className="tiny-text">Rules version {data.policyVersion}</small>
      </section>

      <section className="panel training-section">
        <div className="training-section-head"><span className="training-step">02</span><div><h2>Typing speed</h2><p>Type the displayed passage as accurately as you can. The minimum is {data.thresholds.typingWpm} WPM with at least {data.thresholds.typingAccuracy}% accuracy.</p></div></div>
        {!attempt ? awaitingReview ? <div className="typing-start"><p>Your automatic checks passed. Do not retake the assessment while a recruiter or administrator reviews your practice replies.</p></div> : <div className="typing-start"><p>Each attempt lasts 60 seconds. WPM and accuracy update while you type. Pasting into the test is disabled.</p><button className="button amber" type="button" onClick={startTypingTest} disabled={starting}>{starting ? "Starting…" : "Start 60-second typing test"} <ChevronRight size={14} /></button></div> : <>
          <div className="typing-live-stats"><div><span>Time left</span><strong>{secondsLeft}s</strong></div><div><span>Live speed</span><strong>{liveWpm} WPM</strong></div><div><span>Accuracy</span><strong>{liveAccuracy}%</strong></div><div><span>Typed</span><strong>{typedText.length} chars</strong></div></div>
          <div className="typing-passage">{attempt.passage}</div>
          <textarea className="form-field typing-input" value={typedText} onChange={(event) => setTypedText(event.target.value.slice(0, attempt.passage.length))} onPaste={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()} disabled={secondsLeft === 0} autoFocus placeholder="Click here and type the passage…" aria-label="Typing speed test" />
          {secondsLeft === 0 && <small className="tiny-text">Typing time is complete. Your final WPM and accuracy will be calculated when you submit.</small>}
        </>}
      </section>

      <section className="panel training-section">
        <div className="training-section-head"><span className="training-step">03</span><div><h2>Safety knowledge check</h2><p>Choose the safest response. You need {data.thresholds.quizScore}% correct; every critical safety item must be correct.</p></div></div>
        <div className="training-quiz">{data.quiz.map((question, index) => <fieldset key={question.id} className="quiz-question"><legend>{index + 1}. {question.prompt}</legend>{question.options.map((option) => <label key={option.id} className="quiz-option"><input type="radio" name={question.id} value={option.id} checked={quizAnswers[question.id] === option.id} onChange={() => setQuizAnswers((current) => ({ ...current, [question.id]: option.id }))} /><span>{option.text}</span></label>)}</fieldset>)}</div>
      </section>

      <section className="panel training-section">
        <div className="training-section-head"><span className="training-step">04</span><div><h2>Practice chats</h2><p>Reply in your own words. Each reply needs at least {data.thresholds.replyCharacters} characters; reviewers will check these before approving live access.</p></div></div>
        <div className="practice-list">{data.scenarios.map((scenario, index) => <article key={scenario.id} className="practice-chat"><div className="practice-label">Test chat {index + 1} · simulated only</div><div className="practice-member-message">{scenario.memberMessage}</div><label htmlFor={`practice-${scenario.id}`}>Your reply</label><textarea id={`practice-${scenario.id}`} className="form-field practice-input" value={practiceResponses[scenario.id] || ""} onChange={(event) => setPracticeResponses((current) => ({ ...current, [scenario.id]: event.target.value }))} maxLength={2000} minLength={data.thresholds.replyCharacters} placeholder="Write an original, safe response that answers the message and keeps the conversation on-platform." /><div className="practice-count"><span>{(practiceResponses[scenario.id] || "").replace(/\s/g, "").length}/{data.thresholds.replyCharacters} non-whitespace characters</span><span>Reviewed before live access</span></div></article>)}</div>
      </section>
      <div className="training-submit-row"><div><strong>Live chats remain locked until human approval.</strong><span>Failed automatic checks can be retaken. Passed checks still require reviewer approval.</span></div><button className="button primary" type="submit" disabled={!attempt || secondsLeft > 0 || submitting || !rulesAccepted}>{submitting ? "Submitting…" : "Submit assessment"} <ChevronRight size={15} /></button></div>
    </form>
    <Toast message={notice} />
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

function ConversationRow({ conversation, userId, selected, onOpen, style }: { conversation: Conversation; userId: number; selected?: boolean; onOpen: () => void; style?: CSSProperties }) {
  const needsReply = !conversation.lastSenderFake;
  const mine = conversation.lock?.moderatorId === userId;
  const otherLock = conversation.lock && !mine;
  return <button className={`queue-row live-row ${needsReply ? "needs-reply" : ""} ${selected ? "selected" : ""}`} onClick={onOpen} style={style}>
    <div className="queue-person"><div className="avatar-stack"><Avatar photo={conversation.fakeUser.photo} name={conversation.fakeUser.name} size={36} /><Avatar photo={conversation.realUser.photo} name={conversation.realUser.name} size={22} /></div><div><strong>{conversation.fakeUser.name} <span className="arrow-muted">→</span> {conversation.realUser.name}</strong><small>{conversation.msgCount} messages · {timeAgo(conversation.lastTime)}</small></div></div>
     <div className="queue-snippet"><strong><span className={`priority-dot ${needsReply ? "high" : "normal"}`} />{conversation.lastMessage || "No text in the latest message"}</strong><small>{needsReply ? "Reply needed" : conversation.lastMsgRead ? "Follow-up available" : "Waiting for member"}</small></div>
    <div>{mine ? <StatusPill type="active">Locked by you</StatusPill> : otherLock ? <StatusPill type="pending">Locked</StatusPill> : <span className="button amber compact">Open</span>}</div><ChevronRight size={16} color="var(--ink-soft)" />
  </button>;
}

function MediaBubble({ message }: { message: Message }) {
  if (!message.mediaUrl || !message.mediaType) return null;
  const url = message.mediaUrl.startsWith("/") || message.mediaUrl.startsWith("http") ? message.mediaUrl : `/api/uploads/${message.mediaUrl}`;
  if (message.mediaType === "image") return <MessageImage url={url} />;
  if (message.mediaType === "video") return <video src={url} controls className="message-media" preload="metadata" />;
  if (message.mediaType === "audio") return <div className="audio-media"><Volume2 size={15} /><audio src={url} controls preload="metadata" /></div>;
  return null;
}

function MessageImage({ url }: { url: string }) {
  const { token } = useSession();
  const { source, failed, markFailed } = useImageSource(url, token);
  if (failed) return <div className="message-media-state">Image unavailable</div>;
  if (!source) return <div className="message-media-state">Loading image…</div>;
  return <a className="message-media-link" href={source} target="_blank" rel="noreferrer">
    <img src={source} alt="Attached image" className="message-media" onError={markFailed} />
  </a>;
}

function ProfileCard({ profileUser, tone }: { profileUser: ConvUser; tone: "member" | "managed" }) {
  const profile = profileUser.profile || {};
  const gallery = Array.from(new Set([profileUser.photo, ...(profile.gallery || [])].filter(Boolean))) as string[];
  const hasDetails = Boolean(profile.location || profile.age || profile.bio || Object.keys(profile.details || {}).length);
  return <article className={`profile-card ${tone}`}>
    <div className="profile-card-head">
      <Avatar photo={gallery[0]} name={profileUser.name} size={64} shape="square" />
      <div><span className="profile-role">{tone === "member" ? "Member" : "Managed profile"}</span><strong>{profileUser.name}</strong>{profile.location && <span className="profile-location"><MapPin size={12} /> {profile.location}</span>}</div>
    </div>
    {gallery.length > 1 && <div className="profile-gallery" aria-label={`${profileUser.name} photo gallery`}>{gallery.slice(1).map((photo, index) => <Avatar key={`${photo}-${index}`} photo={photo} name={profileUser.name} size={46} shape="square" />)}</div>}
    {profile.bio && <p className="profile-bio">{profile.bio}</p>}
    {hasDetails ? <div className="profile-facts">{profile.age && <span><CalendarDays size={12} /> {profile.age} years</span>}{Object.entries(profile.details || {}).slice(0, 7).map(([label, value]) => <span key={label}><strong>{label}</strong>{value}</span>)}</div> : <span className="profile-empty">Profile details were not supplied by the connected site.</span>}
  </article>;
}

function ConversationPage({ inline = false, embeddedKey = "" }: { inline?: boolean; embeddedKey?: string } = {}) {
  const params = useParams<{ id: string }>();
  const { user, token } = useSession();
  const [, setLocation] = useLocation();
  const { conversations, reload } = useModeratorData();
  const selectedFromQueue = conversations.find((conversation) => conversation.key === (embeddedKey || params.id));
  const [conversationSnapshot, setConversationSnapshot] = useState<Conversation | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());
  useEffect(() => {
    if (selectedFromQueue) setConversationSnapshot(selectedFromQueue);
  }, [selectedFromQueue]);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  const selected = selectedFromQueue || conversationSnapshot;
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<Record<string, ConvUser>>({});
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [media, setMedia] = useState<{ file: File; preview: string; type: string } | null>(null);
  const [noteHistory, setNoteHistory] = useState<OperatorNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteHistorySupported, setNoteHistorySupported] = useState<boolean | null>(null);
  const [savingNotes, setSavingNotes] = useState(false);
  const [panicCategory, setPanicCategory] = useState("underage");
  const [panicDetails, setPanicDetails] = useState("");
  const [panicSubmitting, setPanicSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(Boolean(selected));
  const [sending, setSending] = useState(false);
  const [locking, setLocking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const lockedByMe = selected?.lock?.moderatorId === user?.id;
  const isAdmin = user?.role === "admin" || (user?.admin ?? 0) >= 2;
  const meaningful = countMeaningfulChars(draft);
  const minutesSinceMemberMessage = selected?.lastTime ? Math.max(0, Math.floor((clockNow - selected.lastTime * 1000) / 60000)) : 0;
  const canSend = Boolean(selected && lockedByMe && (draft.trim() || media) && meaningful >= MIN_REPLY_CHARS);

  const conversationKey = selected?.key;
  const loadMessages = useCallback(async () => {
    if (!conversationKey || !token) return;
    setLoading(true);
    const response = await authFetch(token, `/api/chatmodz/conversations/${conversationKey}/messages`);
    if (response.ok) {
      const data = await response.json();
      setMessages(data.messages || []);
      setUsers(data.users || {});
      setNoteHistory(readOperatorNotes(data, conversationKey));
      setNoteHistorySupported(Array.isArray(data.noteHistory));
    }
    setLoading(false);
  }, [conversationKey, token]);
  useEffect(() => {
    setNoteHistory([]);
    setNoteDraft("");
    setNoteHistorySupported(null);
    loadMessages();
  }, [loadMessages]);
  useEffect(() => {
    if (!conversationKey) return;
    const frame = window.requestAnimationFrame(() => {
      if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationKey, loading, messages.length]);
  useEffect(() => {
    if (!selected || !token) return;
    setSuggestions([]);
  }, [selected, token]);
  useEffect(() => {
    if (!selected || !lockedByMe || !token) return;
    const interval = window.setInterval(() => { authFetch(token, `/api/chatmodz/conversations/${selected.key}/keepalive`, { method: "POST" }).catch(() => undefined); }, 120000);
    return () => window.clearInterval(interval);
  }, [selected, lockedByMe, token]);

  if (!selected) {
    const empty = <div className="empty-state panel inline-empty"><MessageSquare size={28} /><strong>{inline ? "Select a conversation" : "Conversation not found"}</strong><span>{inline ? "Choose a chat from the queue to see the thread and profile context here." : "This live queue item may have expired or been removed."}</span>{!inline && <Link href="/" className="button primary" style={{ marginTop: 16 }}>Back to queue</Link>}</div>;
    return inline ? empty : <Shell><div className="page">{empty}</div></Shell>;
  }

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
    const text = noteDraft.trim();
    if (!selected || !token || !lockedByMe || !noteHistorySupported || !text) return;
    setSavingNotes(true);
    try {
      const response = await authFetch(token, `/api/chatmodz/conversations/${selected.key}/notes`, {
        method: "POST",
        body: JSON.stringify({ notes: text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Notes could not be saved");
      if (!data.note || typeof data.note.text !== "string") {
        throw new Error("The Chatmodz API must be updated before it can save note history");
      }
      const saved: OperatorNote = data.note;
      setNoteHistory((current) => [saved, ...current]);
      setNoteDraft("");
      notify("Handoff note added");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Notes could not be saved");
    } finally {
      setSavingNotes(false);
    }
  };
  const submitPanicRoom = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !token || !lockedByMe) return;
    setPanicSubmitting(true);
    try {
      const response = await authFetch(token, `/api/chatmodz/conversations/${selected.key}/panic-room`, {
        method: "POST",
        body: JSON.stringify({ category: panicCategory, details: panicDetails }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Safety escalation could not be recorded");
      setPanicDetails("");
      notify("Safety report sent to recruiter and administrator review");
      await reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Safety escalation could not be recorded");
    } finally {
      setPanicSubmitting(false);
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
      notify(data.late ? "Reply delivered late and recorded for review" : "Reply delivered to the connected site");
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
  const content = <div className={inline ? "inline-conversation" : "page"}>
     {!inline && <div className="page-head conversation-page-head"><button className="button ghost compact" onClick={() => setLocation("/")}><ChevronLeft size={13} /> Queue</button><div className="tiny-text mono">Live conversation · {selected.key}</div></div>}
    <details className="live-rule-reminder"><summary><ShieldCheck size={15} /> Operator rules for live replies <ChevronDown size={14} /></summary><div className="live-rule-grid"><span>Write a fresh reply; do not reuse identical text.</span><span>At least 75 non-whitespace characters.</span><span>Answer the member and ask a relevant follow-up question.</span><span>Reply within 25 minutes; late replies are recorded.</span><span>Keep contact on-platform; never share phone, email, or social accounts.</span><span>Never arrange meetings or say “I love you.”</span><span>Do not initiate sexual conversation or discuss illegal activity.</span><span>Panic Room is only for underage, illegal acts, suicidal intent with means, or persistent racism/hate.</span></div></details>
    {minutesSinceMemberMessage > 0 && <div className={`reply-time-banner ${minutesSinceMemberMessage >= 25 ? "late" : ""}`}><Clock3 size={14} />{minutesSinceMemberMessage >= 25 ? `This member message is ${minutesSinceMemberMessage} minutes old. A late reply will be recorded for review.` : `Reply within 25 minutes — about ${25 - minutesSinceMemberMessage} minutes remaining.`}</div>}
    <details className="panic-room-panel"><summary><AlertTriangle size={15} /> Panic Room — severe safety issue only <ChevronDown size={14} /></summary><form className="panic-room-form" onSubmit={submitPanicRoom}><p>Use only for a suspected underage user, illegal acts, suicidal intent with means, or persistent racism/hate. Do not use for routine disagreements.</p><label htmlFor="panicCategory">Safety category</label><select id="panicCategory" className="form-field" value={panicCategory} onChange={(event) => setPanicCategory(event.target.value)}><option value="underage">Suspected underage user</option><option value="illegal_activity">Illegal acts</option><option value="suicidal_intent_with_means">Suicidal intent with means</option><option value="persistent_racism">Persistent racism or hate</option></select><label htmlFor="panicDetails">Brief factual context (optional)</label><textarea id="panicDetails" className="form-field" value={panicDetails} onChange={(event) => setPanicDetails(event.target.value)} maxLength={1000} placeholder="Include only the minimum information needed for a reviewer."/><button className="button danger compact" type="submit" disabled={!lockedByMe || panicSubmitting}>{panicSubmitting ? "Sending report…" : "Send to recruiter and admin"}</button>{!lockedByMe && <small className="tiny-text">Lock this conversation before reporting.</small>}</form></details>
    <div className="conversation-layout">
       <section className="panel conversation-main"><div className="conversation-top"><div className="conversation-identity"><div className="avatar-stack large"><Avatar photo={selected.fakeUser.photo} name={selected.fakeUser.name} size={44} /><Avatar photo={selected.realUser.photo} name={selected.realUser.name} size={26} /></div><div><h2>{selected.fakeUser.name} <span className="arrow-muted">→</span> {selected.realUser.name}</h2><small>Conversation context and message history</small></div></div><div className="conversation-actions">{selected.lock && <StatusPill type={lockedByMe ? "active" : "pending"}>{lockedByMe ? "Locked by you" : "Locked"}</StatusPill>}<button className={`button compact ${lockedByMe ? "ghost" : "amber"}`} onClick={toggleLock} disabled={locking || (selected.lock !== null && !lockedByMe)}>{lockedByMe ? <><UnlockKeyhole size={13} /> Release</> : <><LockKeyhole size={13} /> Lock to me</>}</button></div></div>
         <div className="messages" ref={messagesRef}>{loading ? <div className="empty-state"><RefreshCw className="spin" size={24} /><strong>Loading messages</strong></div> : messages.length ? messages.map((message, index) => { const byFake = message.senderType === "managed_profile" || message.u1 === selected.fakeUser.id; const sender = users[String(message.u1)] || (byFake ? selected.fakeUser : selected.realUser); return <div key={message.id} className={`message ${byFake ? "operator" : "member"}`}><Avatar photo={sender.photo} name={sender.name} size={27} /><div><div className="bubble">{message.mediaUrl && <MediaBubble message={message} />}{message.message && <p>{message.message}</p>}<div className="message-meta">{timeAgo(message.time)} {index === messages.length - 1 && <strong>{byFake ? "Waiting for member" : "Needs reply"}</strong>}</div></div></div></div>; }) : <div className="empty-state"><MessageSquare size={25} /><strong>No messages in this conversation</strong><span>The connected source returned an empty thread.</span></div>}</div>
        <div className="composer">{suggestions.length > 0 && <div className="canned-row">{suggestions.map((suggestion) => <button key={suggestion} className="canned" onClick={() => setDraft(suggestion)}>{suggestion}</button>)}</div>}{media && <div className="media-pending"><span>{media.type} attached</span><button className="icon-button" onClick={() => { URL.revokeObjectURL(media.preview); setMedia(null); }} aria-label="Remove attachment"><X size={14} /></button></div>}<div className="composer-row"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} onCopy={(event) => { if (!isAdmin) event.preventDefault(); }} onCut={(event) => { if (!isAdmin) event.preventDefault(); }} onPaste={(event) => { if (!isAdmin) event.preventDefault(); }} onDrop={(event) => { if (!isAdmin) event.preventDefault(); }} placeholder={lockedByMe ? "Write a thoughtful reply…" : "Lock this conversation before replying"} disabled={!lockedByMe || sending} aria-label="Reply message" /><div className="composer-tools"><input ref={inputRef} type="file" accept="image/*,video/*,audio/*" hidden onChange={handleFile} /><button className="icon-button" onClick={() => inputRef.current?.click()} disabled={!lockedByMe || sending} aria-label="Attach media"><Paperclip size={16} /></button><button className="button primary" onClick={send} disabled={!canSend || sending}><Send size={14} /> {sending ? "Sending…" : "Send"}</button></div></div><div className={`reply-counter ${meaningful > 0 && meaningful < MIN_REPLY_CHARS ? "short" : ""}`}>{`${meaningful}/${MIN_REPLY_CHARS} non-space characters required`} · Include a relevant follow-up question · Enter to send, Shift+Enter for a new line</div></div>
      </section>
        <aside className="panel conversation-side">
          <div className="side-section profile-section">
            <div className="side-title">People in this chat</div>
            <div className="profile-stack">
              <ProfileCard profileUser={users["-1"] || selected.fakeUser} tone="managed" />
              <ProfileCard profileUser={users["-2"] || selected.realUser} tone="member" />
            </div>
          </div>
          <div className="side-section">
            <div className="side-title">Conversation details</div>
            <div className="detail-line"><span>Latest activity</span><span>{timeAgo(selected.lastTime)}</span></div>
            <div className="detail-line"><span>Messages</span><span>{selected.msgCount}</span></div>
            <div className="detail-line"><span>Assignment</span><span>{lockedByMe ? "You" : selected.lock ? selected.lock.moderatorName : "Available"}</span></div>
          </div>
          <div className="side-section shared-notes">
            <div className="side-title">Shared operator notes</div>
            <p className="tiny-text notes-help">Private to operators, not sent in chat. Each entry stays attached to this conversation for future handoffs.</p>
            {noteHistorySupported === null && <p className="tiny-text notes-status">Loading saved notes…</p>}
            {noteHistorySupported === false && <p className="tiny-text notes-warning">The Chatmodz API needs the note-history update before new notes can be added.</p>}
            <div className="notes-history-heading">Saved notes <span>{noteHistory.length}</span></div>
            {noteHistory.length ? (
              <div className="notes-history" aria-label="Saved operator note history">
                {noteHistory.map((note) => (
                  <article className="notes-history-entry" key={note.id}>
                    <div className="notes-history-meta">
                      <strong>{note.authorName || "Operator"}</strong>
                      <time dateTime={note.createdAt || undefined}>{note.createdAt ? new Date(note.createdAt).toLocaleString() : "Previous note"}</time>
                    </div>
                    <p>{note.text}</p>
                  </article>
                ))}
              </div>
            ) : noteHistorySupported !== null ? (
              <p className="tiny-text notes-empty">No handoff notes saved for this conversation yet.</p>
            ) : null}
            <label className="notes-compose-label" htmlFor="operator-note-draft">Add a handoff note</label>
            <textarea
              id="operator-note-draft"
              className="form-field notes-field"
              value={noteDraft}
              maxLength={5000}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="What did the user share, and what should the next operator know?"
              disabled={!lockedByMe || savingNotes || noteHistorySupported !== true}
              aria-label="New shared operator note"
            />
            <div className="notes-actions">
              <span className="tiny-text">{noteDraft.length}/5000</span>
              <button className="button amber compact" onClick={saveNotes} disabled={!lockedByMe || savingNotes || noteHistorySupported !== true || !noteDraft.trim()}>
                {savingNotes ? "Saving…" : "Add note"}
              </button>
            </div>
          </div>
          <div className="side-section">
            <div className="side-title">Reply quality</div>
            <div className="notice"><ShieldCheck size={13} /> Keep replies warm, direct, and personal.</div>
          </div>
          <div className="side-section">
            <div className="side-title">Lock policy</div>
            <div className="tiny-text"><Clock3 size={13} style={{ verticalAlign: "middle", marginRight: 5 }} /> Locks last 10 minutes and are renewed while this conversation is open.</div>
          </div>
        </aside>
    </div><Toast message={notice} />
   </div>;
  return inline ? content : <Shell>{content}</Shell>;
}

function ReportsPage() {
  const { user, token } = useSession();
  const { conversations, stats, loading, reload } = useModeratorData();
  const [notice, setNotice] = useState("");
  const needsReply = conversations.filter((conversation) => !conversation.lastSenderFake).length;
  const locked = conversations.filter((conversation) => conversation.lock).length;
  const refresh = async () => { await reload(); setNotice("Report refreshed from live activity"); window.setTimeout(() => setNotice(""), 2200); };
  if (user?.role !== "admin" && (user?.admin ?? 0) < 2) return <Shell><div className="page"><div className="empty-state panel"><AlertTriangle size={28} /><strong>Administrator access required</strong><span>Operational reports are only available to administrators.</span><Link href="/" className="button primary" style={{ marginTop: 16 }}>Back to queue</Link></div></div></Shell>;
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
  return <Shell><div className="page"><div className="page-head"><div><div className="eyebrow">Workspace / account</div><h1 className="page-title">Account</h1><p className="page-subtitle">Your authenticated operator identity and session controls.</p></div><StatusPill type="active">Protected workspace</StatusPill></div><section className="panel settings-panel"><h2>Account details</h2><p>These details are visible to authorized administrators, not to members.</p><div className="form-grid"><div className="form-group"><label>Display name</label><input className="form-field" value={user?.name || ""} readOnly /></div><div className="form-group"><label>Email address</label><input className="form-field" value={user?.email || ""} readOnly /></div><div className="form-group full"><label>Role</label><input className="form-field" value={user?.role === "admin" || (user?.admin ?? 0) >= 2 ? "Administrator" : user?.role === "recruiter" ? "Recruiter" : "Operator"} readOnly /></div></div><div className="setting-row" style={{ marginTop: 22 }}><div><strong>Push notifications</strong><small>Receive a browser alert when new member messages need attention.</small></div><button className={`toggle ${pushEnabled ? "on" : ""}`} onClick={togglePush} disabled={pushLoading} aria-label="Toggle push notifications"><span /></button></div><div style={{ marginTop: 22 }}><button className="button danger" onClick={() => { logout(); setLocation("/login"); }}><LogOut size={14} /> Sign out</button></div></section><Toast message={notice} /></div></Shell>;
}

type AdminData = {
  applications: any[];
  operators: any[];
  sites: any[];
  report: { summary?: any; byOperator?: any[]; bySite?: any[] };
};
type AdminTab = "applications" | "operators" | "sites" | "report" | "compensation";
type RecruiterOperator = {
  id: number;
  full_name: string;
  email: string;
  role: string;
  status: string;
  recruiter_id?: number | null;
  recruiter_name?: string | null;
  last_active_at?: string | null;
  created_at?: string;
  activity_count?: number;
  replies?: number;
};
type RecruiterActivity = {
  id: number;
  operator_id: number;
  operator_name: string;
  recruiter_id?: number | null;
  recruiter_name?: string | null;
  activity_type: string;
  site_name?: string | null;
  created_at: string;
};
type RecruiterOverview = {
  recruiters: { id: number; full_name: string; email: string; status: string; last_active_at?: string | null; recruited_count: number; activity_count: number }[];
  operators: RecruiterOperator[];
  activities: RecruiterActivity[];
  summary: { recruiters: number; operators: number; active: number; activities: number };
};

type CompensationLevel = { id: number; name: string; slug: string; description: string; rateMinor: number; currency: string; isDefault: boolean; active: boolean; assignedOperators: number };
type CompensationOperator = { id: number; fullName: string; email: string; role: string; status: string; levelId: number | null; levelName: string | null; rateMinor: number | null; currency: string | null; earnedMinor: number; earnedMessages: number };
type CompensationRecord = { id: number; messageId: number; operatorName: string; levelName: string; rateMinor: number; currency: string; status: "pending" | "paid" | "void"; paidAt: string | null; createdAt: string; conversationId: number };
type CompensationData = { levels: CompensationLevel[]; operators: CompensationOperator[]; summary: { totalMessages: number; accruedMinor: number; paidMinor: number; pendingMinor: number }; byLevel: { id: number; name: string; messages: number; accruedMinor: number }[]; recent: CompensationRecord[] };

const emptyCompensation: CompensationData = { levels: [], operators: [], summary: { totalMessages: 0, accruedMinor: 0, paidMinor: 0, pendingMinor: 0 }, byLevel: [], recent: [] };
const emptyRecruiterOverview: RecruiterOverview = { recruiters: [], operators: [], activities: [], summary: { recruiters: 0, operators: 0, active: 0, activities: 0 } };

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

function RecruiterPage() {
  const { token, user } = useSession();
  const [tab, setTab] = useState<"team" | "activity">("team");
  const [data, setData] = useState<RecruiterOverview>(emptyRecruiterOverview);
  const [draft, setDraft] = useState({ fullName: "", email: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const response = await authFetch(token, "/api/chatmodz/recruiter/overview");
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Recruiter data could not be loaded");
      setData({ ...emptyRecruiterOverview, ...result, summary: { ...emptyRecruiterOverview.summary, ...(result.summary || {}) } });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Recruiter data could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);
  const recruit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await authFetch(token, "/api/chatmodz/recruiter/operators", { method: "POST", body: JSON.stringify(draft) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Operator could not be recruited");
      setDraft({ fullName: "", email: "" });
      setNotice(`Operator recruited. Activation code: ${result.activationCode} — copy it now; it is shown once.`);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Operator could not be recruited");
    } finally {
      setSaving(false);
    }
  };
  const updateStatus = async (id: number, status: string) => {
    try {
      const response = await authFetch(token, `/api/chatmodz/recruiter/operators/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Status could not be updated");
      setNotice("Operator status updated");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Status could not be updated");
    }
  };
  if (user?.role !== "recruiter" && user?.role !== "admin" && (user?.admin ?? 0) < 2) return <Shell><div className="page"><div className="empty-state panel"><AlertTriangle size={28} /><strong>Recruiter access required</strong><span>This workspace is restricted to recruiters and administrators.</span></div></div></Shell>;
  return <Shell><div className="page">
    <div className="page-head"><div><div className="eyebrow">{user?.role === "admin" ? "Administrator / recruiter oversight" : "Recruiter workspace / live"}</div><h1 className="page-title">{user?.role === "admin" ? "Recruiter oversight" : "Recruiter desk"}</h1><p className="page-subtitle">{user?.role === "admin" ? "Monitor recruiter performance and every operator activity across the organization." : "Recruit operators, follow their progress, and review every recorded action in your team."}</p></div><button className="button ghost compact" onClick={load} disabled={loading}><RefreshCw size={13} /> Refresh</button></div>
    <div className="metric-grid"><Metric label="Recruiters" value={String(data.summary.recruiters)} detail={user?.role === "admin" ? "Visible to administrators" : "Your recruiter account"} color="var(--ink)" /><Metric label="Operators" value={String(data.summary.operators)} detail="Assigned to this view" /><Metric label="Active operators" value={String(data.summary.active)} detail="Ready for queue work" color="var(--teal)" /><Metric label="Tracked activities" value={String(data.summary.activities)} detail="Live accountability trail" color="var(--amber)" /></div>
    <div className="admin-tabs"><button className={`filter-button ${tab === "team" ? "selected" : ""}`} onClick={() => setTab("team")}><UsersRound size={13} /> Team</button><button className={`filter-button ${tab === "activity" ? "selected" : ""}`} onClick={() => setTab("activity")}><Activity size={13} /> Activity monitor</button></div>
    {tab === "team" ? <div className="recruiter-layout">
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Recruit an operator</div><div className="panel-kicker">The activation code is shown once</div></div><UserPlus size={17} color="var(--teal)" /></div><form className="settings-panel recruiter-form" onSubmit={recruit}><div className="form-group"><label htmlFor="recruiter-operator-name">Full name</label><input id="recruiter-operator-name" className="form-field" value={draft.fullName} onChange={(event) => setDraft({ ...draft, fullName: event.target.value })} required /></div><div className="form-group"><label htmlFor="recruiter-operator-email">Email address</label><input id="recruiter-operator-email" className="form-field" type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} required /></div><p className="tiny-text">New operators start in training and receive a one-time activation code to set their password.</p><button className="button amber" disabled={saving}>{saving ? "Recruiting…" : "Recruit operator"} <ChevronRight size={14} /></button></form></section>
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Operator team</div><div className="panel-kicker">Status and activity at a glance</div></div><Eye size={17} color="var(--teal)" /></div><div className="table-wrap"><table className="data-table recruiter-table"><thead><tr><th>Operator</th>{user?.role === "admin" && <th>Recruiter</th>}<th>Status</th><th>Activity</th><th>Last active</th><th>Action</th></tr></thead><tbody>{loading ? <tr><td colSpan={6}>Loading recruiter team…</td></tr> : data.operators.length ? data.operators.map((operator) => <tr key={operator.id}><td><div className="name-cell"><Avatar name={operator.full_name} size={28} /><span><strong>{operator.full_name}</strong><small>{operator.email}</small></span></div></td>{user?.role === "admin" && <td>{operator.recruiter_name || "Unassigned"}</td>}<td><StatusPill type={operator.status === "active" ? "active" : operator.status === "training" ? "training" : "urgent"}>{operator.status}</StatusPill></td><td>{operator.activity_count || 0} events<br /><span className="tiny-text">{operator.replies || 0} replies</span></td><td>{operator.last_active_at ? new Date(operator.last_active_at).toLocaleString() : "Never"}</td><td><select className="form-field compact-select" value={operator.status} onChange={(event) => updateStatus(operator.id, event.target.value)}><option value="training">Training</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="rejected">Rejected</option></select></td></tr>) : <tr><td colSpan={6}>No operators have been recruited into this team yet.</td></tr>}</tbody></table></div></section>
    </div> : <section className="panel"><div className="panel-head"><div><div className="panel-title">Activity monitor</div><div className="panel-kicker">Every login, claim, note, reply, release, and training change is recorded</div></div><StatusPill type="active">Live audit trail</StatusPill></div><div className="activity-list">{loading ? <div className="empty-state">Loading activity…</div> : data.activities.length ? data.activities.map((activity) => <div className="activity-row" key={activity.id}><div className="activity-icon"><Activity size={14} /></div><div><strong>{activity.operator_name}</strong><span>{activity.activity_type.replace("_", " ")}{activity.site_name ? ` · ${activity.site_name}` : ""}{user?.role === "admin" && activity.recruiter_name ? ` · recruited by ${activity.recruiter_name}` : ""}</span></div><time>{new Date(activity.created_at).toLocaleString()}</time></div>) : <div className="empty-state"><Activity size={25} /><strong>No activity recorded yet</strong><span>Activity will appear as the team signs in and works.</span></div>}</div></section>}
    <Toast message={notice} />
  </div></Shell>;
}

function AdminPage() {
  const { token, user } = useSession();
  const isAdministrator = user?.role === "admin" || (user?.admin ?? 0) >= 2;
  const [tab, setTab] = useState<AdminTab>("applications");
  const [data, setData] = useState<AdminData>({ applications: [], operators: [], sites: [], report: {} });
  const [compensation, setCompensation] = useState<CompensationData>(emptyCompensation);
  const [levelDraft, setLevelDraft] = useState({ id: 0, name: "", rate: "0.05", currency: "EUR", description: "", active: true, isDefault: false });
  const [editingLevel, setEditingLevel] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [issuedActivation, setIssuedActivation] = useState<{ name: string; code: string; expiresInHours: number } | null>(null);
  const load = useCallback(async (requestedTab: AdminTab = tab) => {
    if (!token || !isAdministrator) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const endpoint: Record<AdminTab, string> = {
        applications: "/api/chatmodz/admin/applications",
        operators: "/api/chatmodz/admin/operators",
        sites: "/api/chatmodz/admin/sites",
        report: "/api/chatmodz/admin/report",
        compensation: "/api/chatmodz/admin/compensation",
      };
      const response = await authFetch(token, endpoint[requestedTab]);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Administrator data could not be loaded");
      if (requestedTab === "applications") setData((current) => ({ ...current, applications: result.applications || [] }));
      if (requestedTab === "operators") setData((current) => ({ ...current, operators: result.operators || [] }));
      if (requestedTab === "sites") setData((current) => ({ ...current, sites: result.sites || [] }));
      if (requestedTab === "report") setData((current) => ({ ...current, report: result }));
      if (requestedTab === "compensation") setCompensation(result);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Administrator data could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [token, isAdministrator, tab]);
  useEffect(() => { load(tab); }, [load, tab]);
  if (!isAdministrator) return <Shell><div className="page"><div className="empty-state panel"><AlertTriangle size={28} /><strong>Administrator access required</strong><span>This control room is restricted to Chatmodz administrators.</span></div></div></Shell>;
  const action = async (url: string, method = "POST", body?: unknown) => {
    const response = await authFetch(token, url, { method, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Action failed");
    return result;
  };
  if ((tab as string) === "sites") return <Shell><div className="page"><div className="page-head"><div><div className="eyebrow">Administrator control room</div><h1 className="page-title">Operations admin</h1><p className="page-subtitle">Applications, operators, connected sites, delivery health, attribution, and operator earnings.</p></div><button className="button ghost compact" onClick={() => load()}><RefreshCw size={13} /> Refresh</button></div><div className="admin-tabs">{(["applications", "operators", "sites", "report", "compensation"] as const).map((item) => <button key={item} className={`filter-button ${tab === item ? "selected" : ""}`} onClick={() => setTab(item)}>{item === "applications" ? "Applications" : item === "operators" ? "Operators" : item === "sites" ? "Connected sites" : item === "report" ? "Reporting" : <><DollarSign size={13} /> Pay &amp; levels</>}</button>)}</div><SiteManagementPanel sites={data.sites} action={action} load={load} setNotice={setNotice} /><Toast message={notice} /></div></Shell>;
  const approve = async (application: any) => {
    try {
      const result = await action(`/api/chatmodz/admin/applications/${application.id}/approve`);
      setIssuedActivation({ name: application.full_name, code: result.activationCode, expiresInHours: result.expiresInHours });
      setNotice("Application approved. Copy the activation code and send it to the operator.");
      await load("applications");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Approval failed"); }
  };
  const issueActivationCode = async (application: any) => {
    try {
      const result = await action(`/api/chatmodz/admin/applications/${application.id}/activation-code`);
      setIssuedActivation({ name: application.full_name, code: result.activationCode, expiresInHours: result.expiresInHours });
      setNotice("A new activation code is ready. The previous unused code has been invalidated.");
      await load("applications");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not issue activation code"); }
  };
  const deleteApplication = async (application: any) => {
    const removesAccount = application.operator_role === "operator" && application.operator_status === "training";
    const accountText = removesAccount ? " The unactivated operator account will also be permanently deleted." : "";
    if (!window.confirm(`Permanently delete ${application.full_name}'s application?${accountText} This cannot be undone. Accounts that have been activated or have work history cannot be deleted here.`)) return;
    try {
      const result = await action(`/api/chatmodz/admin/applications/${application.id}`, "DELETE");
      setIssuedActivation(null);
      setNotice(result.accountRemoved ? "Application and unactivated operator account deleted." : "Application deleted.");
      await load("applications");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not delete application"); }
  };
  const copyActivationCode = async () => {
    if (!issuedActivation) return;
    try {
      await navigator.clipboard.writeText(issuedActivation.code);
      setNotice("Activation code copied.");
    } catch {
      setNotice("Clipboard unavailable. Select and copy the activation code shown above.");
    }
  };
  const reject = async (id: number) => {
    try { await action(`/api/chatmodz/admin/applications/${id}/reject`); setNotice("Application rejected"); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Rejection failed"); }
  };
  const setOperatorStatus = async (id: number, status: string) => {
    try { await action(`/api/chatmodz/admin/operators/${id}/status`, "POST", { status }); setNotice("Operator status updated"); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Status update failed"); }
  };
  const setOperatorRole = async (id: number, role: string) => {
    try { await action(`/api/chatmodz/admin/operators/${id}/role`, "POST", { role }); setNotice("Team role updated"); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Role update failed"); }
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
  return <Shell>
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Administrator control room</div>
          <h1 className="page-title">Operations admin</h1>
          <p className="page-subtitle">Applications, operators, connected sites, delivery health, attribution, and operator earnings.</p>
        </div>
        <button className="button ghost compact" onClick={() => load()}><RefreshCw size={13} /> Refresh</button>
      </div>
      <div className="admin-tabs">
        {(["applications", "operators", "sites", "report", "compensation"] as const).map((item) => (
          <button key={item} className={`filter-button ${tab === item ? "selected" : ""}`} onClick={() => setTab(item)}>
            {item === "applications" ? "Applications" : item === "operators" ? "Operators" : item === "sites" ? "Connected sites" : item === "report" ? "Reporting" : <><DollarSign size={13} /> Pay &amp; levels</>}
          </button>
        ))}
      </div>
      {issuedActivation && <section className="activation-code-panel" aria-label="New one-time activation code">
        <div className="activation-code-copy">
          <strong>One-time activation code for {issuedActivation.name}</strong>
          <span>Expires in {issuedActivation.expiresInHours} hours. Copy and send it to the operator; this code is shown only here.</span>
          <code>{issuedActivation.code}</code>
        </div>
        <div className="inline-actions">
          <button className="button amber compact" onClick={copyActivationCode}><Copy size={13} /> Copy code</button>
          <button className="icon-button" aria-label="Dismiss activation code" onClick={() => setIssuedActivation(null)}><X size={15} /></button>
        </div>
      </section>}
      {loading ? <div className="empty-state panel"><RefreshCw className="spin" size={25} /><strong>Loading administrator data</strong></div>
        : tab === "compensation" ? compensationView
        : tab === "applications" ? <section className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">Operator applications</div>
              <div className="panel-kicker">Approved operators who missed their code can receive a replacement here.</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Applicant</th><th>Location</th><th>Experience</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>{data.applications.length ? data.applications.map((application) => {
                const hasUnactivatedOperator = application.operator_role === "operator" && application.operator_status === "training";
                const canDelete = !application.operator_id || hasUnactivatedOperator;
                return <tr key={application.id}>
                  <td><strong>{application.full_name}</strong><br /><span className="tiny-text">{application.email}</span></td>
                  <td>{application.location || "—"}</td>
                  <td className="table-long">{application.experience || "—"}</td>
                  <td><StatusPill type={application.status === "pending" ? "pending" : application.status === "rejected" ? "rejected" : "active"}>{application.status}</StatusPill></td>
                  <td><div className="inline-actions">
                    {application.status === "pending" ? <>
                      <button className="button amber compact" onClick={() => approve(application)}>Approve</button>
                      <button className="button danger compact" onClick={() => reject(application.id)}>Reject</button>
                    </> : application.status === "approved" && (!application.operator_id || hasUnactivatedOperator) ? (
                      <button className="button amber compact" onClick={() => issueActivationCode(application)}>
                        {hasUnactivatedOperator ? "Reissue code" : "Issue code"}
                      </button>
                    ) : application.operator_status === "active" ? <span className="tiny-text">Account activated</span> : <span className="tiny-text">Reviewed</span>}
                    {canDelete && <button className="button danger compact" onClick={() => deleteApplication(application)}><Trash2 size={13} /> Delete</button>}
                  </div></td>
                </tr>;
              }) : <tr><td colSpan={5}>No applications returned from Chatmodz MySQL.</td></tr>}</tbody>
            </table>
          </div>
        </section>
        : tab === "operators" ? <section className="panel">
          <div className="panel-head"><div><div className="panel-title">Operator directory</div><div className="panel-kicker">Status and recruiter roles are audited server-side</div></div></div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Operator</th><th>Role</th><th>Status</th><th>Last active</th><th>Action</th></tr></thead>
              <tbody>{data.operators.map((operator) => <tr key={operator.id}>
                <td><strong>{operator.full_name}</strong><br /><span className="tiny-text">{operator.email}</span></td>
                <td><select className="form-field compact-select" value={operator.role === "recruiter" ? "recruiter" : "operator"} onChange={(event) => setOperatorRole(operator.id, event.target.value)} disabled={operator.role === "admin"}><option value="operator">Operator</option><option value="recruiter">Recruiter</option></select></td>
                <td><StatusPill type={operator.status === "active" ? "active" : "pending"}>{operator.status}</StatusPill></td>
                <td>{operator.last_active_at ? new Date(operator.last_active_at).toLocaleString() : "Never"}</td>
                <td><select className="form-field compact-select" value={operator.status} onChange={(event) => setOperatorStatus(operator.id, event.target.value)}><option value="training">Training</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="rejected">Rejected</option></select></td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>
        : tab === "sites" ? <section className="panel">
          <div className="panel-head"><div><div className="panel-title">Connected sites</div><div className="panel-kicker">Secrets remain in environment configuration; only the key name is shown</div></div></div>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>Site</th><th>Endpoint</th><th>Secret env key</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>{data.sites.map((site) => <tr key={site.id}>
              <td><strong>{site.display_name}</strong><br /><span className="tiny-text mono">{site.internal_name}</span></td>
              <td className="table-long">{site.endpoint_base_url || "Inbound only"}</td>
              <td className="mono">{site.secret_env_key || "—"}</td>
              <td><StatusPill type={site.status === "active" ? "active" : "pending"}>{site.status}</StatusPill></td>
              <td><select className="form-field compact-select" value={site.status} onChange={(event) => setSiteStatus(site.id, event.target.value)}><option value="active">Active</option><option value="paused">Paused</option><option value="disconnected">Disconnected</option></select></td>
            </tr>)}</tbody>
          </table></div>
        </section>
        : <section className="panel">
          <div className="panel-head"><div><div className="panel-title">Delivery and attribution report</div><div className="panel-kicker">Site attribution is available only in this administrator view</div></div></div>
          <div className="metric-grid admin-metrics">
            <Metric label="Conversations" value={String(summary.conversations || 0)} detail="Stored in Chatmodz" />
            <Metric label="Replies" value={String(summary.replies || 0)} detail="Operator-authored messages" color="var(--teal)" />
            <Metric label="Failed deliveries" value={String(summary.failed_deliveries || 0)} detail="Requires adapter follow-up" color="var(--red)" />
          </div>
          <div className="report-columns">
            <div><h3>By operator</h3>{(data.report.byOperator || []).map((row) => <div className="report-line" key={row.id}><span>{row.name}</span><strong>{row.replies} replies</strong></div>)}</div>
            <div><h3>By connected site</h3>{(data.report.bySite || []).map((row) => <div className="report-line" key={row.id}><span>{row.display_name} <small>{row.status}</small></span><strong>{row.conversations} conversations · {row.failed_deliveries || 0} failed</strong></div>)}</div>
          </div>
        </section>}
      <Toast message={notice} />
    </div>
  </Shell>;
}

type AssessmentReviewRow = {
  id?: number;
  operator_id: number;
  operator_name: string;
  operator_email: string;
  operator_status: string;
  recruiter_name?: string | null;
  status: string;
  auto_passed?: boolean;
  typing_wpm?: number | null;
  typing_accuracy?: number | null;
  quiz_score?: number | null;
  practice_responses_json?: Record<string, string> | null;
  policy_version?: string | null;
  rules_acknowledged_at?: string | null;
  reviewer_note?: string | null;
  reviewed_by_name?: string | null;
  reviewed_at?: string | null;
  submitted_at?: string | null;
};

type SafetyEscalationRow = {
  id: number;
  operator_name: string;
  member_alias?: string;
  managed_profile_alias?: string;
  category: string;
  details?: string | null;
  status: string;
  created_at: string;
  reviewed_by_name?: string | null;
  reviewed_at?: string | null;
};

type LateReplyRow = {
  id: number;
  operator_id: number;
  operator_name: string;
  member_alias?: string;
  managed_profile_alias?: string;
  conversation_id: number;
  minutes_waited: number;
  created_at: string;
};

function OperatorReviewsPage() {
  const { token, user } = useSession();
  const [tab, setTab] = useState<"assessments" | "safety">("assessments");
  const [assessments, setAssessments] = useState<AssessmentReviewRow[]>([]);
  const [escalations, setEscalations] = useState<SafetyEscalationRow[]>([]);
  const [lateReplies, setLateReplies] = useState<LateReplyRow[]>([]);
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const isReviewer = user?.role === "admin" || user?.role === "recruiter";

  const load = useCallback(async () => {
    if (!token || !isReviewer) return;
    setLoading(true);
    try {
      if (tab === "assessments") {
        const response = await authFetch(token, "/api/chatmodz/assessments");
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Assessment results could not be loaded");
        setAssessments(result.assessments || []);
      } else {
        const [safetyResponse, lateResponse] = await Promise.all([
          authFetch(token, "/api/chatmodz/safety-escalations"),
          authFetch(token, "/api/chatmodz/late-replies"),
        ]);
        const [safetyData, lateData] = await Promise.all([
          safetyResponse.json().catch(() => ({})),
          lateResponse.json().catch(() => ({})),
        ]);
        if (!safetyResponse.ok || !lateResponse.ok) throw new Error(safetyData.error || lateData.error || "Safety review data could not be loaded");
        setEscalations(safetyData.escalations || []);
        setLateReplies(lateData.lateReplies || []);
      }
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Review data could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [token, tab, isReviewer]);

  useEffect(() => { void load(); }, [load]);

  const decide = async (assessmentId: number, decision: "approve" | "reject") => {
    if (!token) return;
    try {
      const response = await authFetch(token, `/api/chatmodz/assessments/${assessmentId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision, reviewerNote: reviewNotes[assessmentId] || "" }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Assessment decision could not be saved");
      setNotice(decision === "approve" ? "Operator approved and live access enabled." : "Assessment declined. The operator can retake training.");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Assessment decision could not be saved");
    }
  };

  const updateEscalation = async (id: number, status: "reviewed" | "resolved") => {
    if (!token) return;
    try {
      const response = await authFetch(token, `/api/chatmodz/safety-escalations/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Safety report could not be updated");
      setNotice(`Safety report marked ${status}.`);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Safety report could not be updated");
    }
  };

  if (!isReviewer) return <Shell><div className="page"><div className="empty-state panel"><AlertTriangle size={28} /><strong>Reviewer access required</strong><span>Only recruiters and administrators can review tests or safety reports.</span></div></div></Shell>;
  return <Shell><div className="page review-page">
    <div className="page-head"><div><div className="eyebrow">Recruiter and administrator review</div><h1 className="page-title">Operator tests and safety</h1><p className="page-subtitle">Review practice chats before granting live access. Safety reports are restricted to severe incidents.</p></div><button className="button ghost compact" onClick={() => void load()} disabled={loading}><RefreshCw size={13} /> Refresh</button></div>
    <div className="admin-tabs">
      <button className={`filter-button ${tab === "assessments" ? "selected" : ""}`} onClick={() => setTab("assessments")}><ClipboardCheck size={13} /> Operator assessments</button>
      <button className={`filter-button ${tab === "safety" ? "selected" : ""}`} onClick={() => setTab("safety")}><ShieldCheck size={13} /> Safety and late replies</button>
    </div>
    {notice && <div className="training-notice" role="status"><AlertTriangle size={16} />{notice}</div>}
    {loading ? <div className="empty-state panel"><RefreshCw className="spin" size={24} /><strong>Loading review queue</strong></div> : tab === "assessments" ? <div className="review-list">
      {assessments.length ? assessments.map((assessment) => {
        const responses = assessment.practice_responses_json || {};
        const canReview = assessment.status === "submitted" && Boolean(assessment.auto_passed) && Boolean(assessment.id);
        return <article className="panel review-card" key={`${assessment.operator_id}-${assessment.id || "none"}`}>
          <div className="review-card-head"><div><strong>{assessment.operator_name}</strong><span>{assessment.operator_email}{assessment.recruiter_name ? ` · Recruiter: ${assessment.recruiter_name}` : ""}</span></div><StatusPill type={assessment.status === "approved" ? "active" : assessment.status === "rejected" ? "rejected" : assessment.status === "submitted" ? "pending" : "training"}>{assessment.status.replace("_", " ")}</StatusPill></div>
          <div className="review-score-grid"><div><span>Typing</span><strong>{assessment.typing_wpm ?? "—"} WPM</strong><small>{assessment.typing_wpm != null && assessment.typing_wpm >= 40 ? "Pass" : "Needs 40 WPM"}</small></div><div><span>Accuracy</span><strong>{assessment.typing_accuracy ?? "—"}%</strong><small>{assessment.typing_accuracy != null && assessment.typing_accuracy >= 90 ? "Pass" : "Needs 90%"}</small></div><div><span>Safety quiz</span><strong>{assessment.quiz_score ?? "—"}%</strong><small>{assessment.quiz_score != null && assessment.quiz_score >= 80 ? "Score passed; critical answer also checked" : "Needs 80%"}</small></div><div><span>Rule acknowledgment</span><strong>{assessment.policy_version || "Not recorded"}</strong><small>{assessment.rules_acknowledged_at ? new Date(assessment.rules_acknowledged_at).toLocaleString() : "Not acknowledged"}</small></div></div>
          <div className="review-practice-list"><strong>Practice chat replies</strong>{Object.keys(responses).length ? Object.entries(responses).map(([scenario, response]) => <div className="review-response" key={scenario}><span>{scenario.replace("_", " ")}</span><p>{response}</p></div>) : <p className="tiny-text">No practice responses submitted.</p>}</div>
          {assessment.reviewer_note && <p className="reviewer-feedback"><strong>Previous reviewer note:</strong> {assessment.reviewer_note}</p>}
          {assessment.reviewed_by_name && <small className="tiny-text">Reviewed by {assessment.reviewed_by_name}{assessment.reviewed_at ? ` · ${new Date(assessment.reviewed_at).toLocaleString()}` : ""}</small>}
          {assessment.status === "submitted" && <div className="review-action-row"><textarea className="form-field reviewer-note-input" value={assessment.id ? reviewNotes[assessment.id] || "" : ""} onChange={(event) => assessment.id && setReviewNotes((current) => ({ ...current, [assessment.id!]: event.target.value }))} maxLength={1000} placeholder="Optional reviewer feedback for the operator" /><div className="inline-actions"><button className="button danger compact" onClick={() => assessment.id && void decide(assessment.id, "reject")}>Decline / retest</button><button className="button amber compact" onClick={() => assessment.id && void decide(assessment.id, "approve")} disabled={!canReview}>Approve live access</button></div>{!assessment.auto_passed && <small className="tiny-text">Automatic checks did not pass. Approval is disabled; the operator can retake the test.</small>}</div>}
        </article>;
      }) : <div className="empty-state panel"><ClipboardCheck size={26} /><strong>No operators are assigned to this review view</strong><span>Assessment results will appear here when your operators submit training.</span></div>}
    </div> : <div className="review-list">
      <section className="panel safety-summary"><ShieldCheck size={20} /><div><strong>Panic Room is for severe safety incidents only.</strong><span>Review underage concerns, illegal acts, suicidal intent with means, and persistent racism or hate. Routine disagreements do not qualify.</span></div></section>
      {escalations.length ? escalations.map((escalation) => <article className="panel review-card safety-report" key={escalation.id}>
        <div className="review-card-head"><div><strong>{escalation.category.replaceAll("_", " ")}</strong><span>Reported by {escalation.operator_name}{escalation.member_alias ? ` · Chat: ${escalation.member_alias}` : ""} · {new Date(escalation.created_at).toLocaleString()}</span></div><StatusPill type={escalation.status === "open" ? "urgent" : "active"}>{escalation.status}</StatusPill></div>
        {escalation.details && <p className="review-response">{escalation.details}</p>}
        {escalation.reviewed_by_name && <small className="tiny-text">Reviewed by {escalation.reviewed_by_name}</small>}
        {escalation.status === "open" && <div className="inline-actions"><button className="button ghost compact" onClick={() => void updateEscalation(escalation.id, "reviewed")}>Mark reviewed</button><button className="button amber compact" onClick={() => void updateEscalation(escalation.id, "resolved")}>Resolve report</button></div>}
      </article>) : <div className="empty-state panel"><ShieldCheck size={26} /><strong>No safety reports are waiting</strong><span>Only the approved severe categories can be sent to Panic Room.</span></div>}
      <section className="late-reply-section"><div className="panel-head"><div><div className="panel-title">Replies outside the 25-minute window</div><div className="panel-kicker">Late replies from the last 90 days, recorded for follow-up.</div></div><Clock3 size={17} /></div>
        {lateReplies.length ? lateReplies.map((reply) => <article className="panel late-reply-card" key={reply.id}><div><strong>{reply.operator_name}</strong><span>{reply.member_alias || "Conversation"}{reply.managed_profile_alias ? ` · ${reply.managed_profile_alias}` : ""}</span></div><div className="late-reply-meta"><StatusPill type="urgent">{reply.minutes_waited} min</StatusPill><span>{new Date(reply.created_at).toLocaleString()}</span></div></article>) : <div className="empty-state panel"><Clock3 size={23} /><strong>No late replies are recorded</strong><span>Replies sent after 25 minutes appear here for review.</span></div>}
      </section>
    </div>}
    <Toast message={notice} />
  </div></Shell>;
}

function HomePage() {
  const { user } = useSession();
  return user?.role === "recruiter" ? <RecruiterPage /> : <QueuePage />;
}

function ConversationRoute() {
  return <ConversationPage />;
}

function AuthenticatedRouter() {
  const { user, loading } = useSession();
  const [location] = useLocation();
  if (loading) return <div className="auth-loading"><RefreshCw className="spin" size={24} /><span>Checking secure session…</span></div>;
  if (!user) return <Switch><Route path="/login" component={LoginPage} /><Route path="/activate" component={ActivationPage} /><Route path="/apply" component={ApplyPage} /><Route path="/welcome" component={LandingPage} /><Route component={LandingPage} /></Switch>;
  if (user.role === "operator" && (user.status !== "active" || user.assessmentStatus !== "approved")) return <ErrorBoundary resetKey={location}><TrainingPage /></ErrorBoundary>;
  if (user.role === "operator" && location === "/training") return <QueuePage />;
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={HomePage} /><Route path="/earnings" component={EarningsPage} /><Route path="/conversation/:id" component={ConversationRoute} /><Route path="/reports" component={ReportsPage} /><Route path="/recruiter" component={RecruiterPage} /><Route path="/reviews" component={OperatorReviewsPage} /><Route path="/admin" component={AdminPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function App() {
  const auth = useAuthState();
  return <QueryClientProvider client={queryClient}><AuthContext.Provider value={auth}><TooltipProvider><AuthenticatedRouter /><Toaster /></TooltipProvider></AuthContext.Provider></QueryClientProvider>;
}

export default App;