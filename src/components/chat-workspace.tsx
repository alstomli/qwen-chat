"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, ArrowUpRight, Check, ChevronDown, Code2, Compass, Copy, Feather, LoaderCircle, LogOut, Menu, MessageSquare, PanelLeftClose, Plus, Search, Settings2, ShieldCheck, Sparkles, Square, Trash2, X, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RequestDiagnostics, exportDiagnostics } from "@/components/request-diagnostics";
import { DIAGNOSTICS_HEADER, parseDiagnosticHeader, type BrowserTimings, type DiagnosticRecord } from "@/lib/diagnostics";
import { AnswerPaint } from "@/components/answer-paint";
import { ModelSettingsPanel } from "@/components/model-settings-panel";
import { DEFAULT_SETTINGS, SETTINGS_MAX, SETTINGS_KEY, MODEL_SETTINGS_KEY, parseModelSettings, fitSettings, fitMessages, jsonBytes, type ModelSettings } from "@/lib/chat-settings";
import { consumeCompletion } from "@/lib/protocol";
import { completedHistory, parseConversations, STORAGE_KEY, type Conversation, type Message } from "@/lib/storage";

import { DEFAULT_MODEL, MODELS, modelInfo, answerModelLabel, type ModelId } from "@/lib/models";
import { allModelStatusRequests, initialModelConnections, updateModelConnection } from "@/lib/model-status";
const starters = [
  { icon: Feather, label: "Find the right words", text: "Help me write a thoughtful email to reconnect with an old colleague. Keep it warm and natural.", caption: "A first draft, a fresh perspective" },
  { icon: Compass, label: "Make sense of something", text: "Explain how large language models work, using a simple everyday analogy.", caption: "Turn a big idea into a clear one" },
  { icon: Code2, label: "Build something useful", text: "Write a small Python function that reads a CSV file and summarizes its numeric columns. Explain each step.", caption: "Work through code, step by step" },
];
const uid = () => crypto.randomUUID();
const logo = <span className="qwen-symbol" aria-hidden="true">✳</span>;

export default function ChatWorkspace({ initialAuthenticated, loginConfigured }: { initialAuthenticated: boolean; loginConfigured: boolean }) {
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [password, setPassword] = useState(""); const [loginError, setLoginError] = useState(""); const [signingIn, setSigningIn] = useState(false);
  const [chats, setChats] = useState<Conversation[]>([]); const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null); const [draft, setDraft] = useState(""); const [search, setSearch] = useState("");
  const [sidebar, setSidebar] = useState(false); const [settings, setSettings] = useState(false); const [deleting, setDeleting] = useState<string | null>(null);
  const [connections, setConnections] = useState(initialModelConnections);
  const statusRequests = useRef<ReturnType<typeof allModelStatusRequests> | null>(null);
  const [draftModel, setDraftModel] = useState<ModelId>(DEFAULT_MODEL);
  const [draftAdapter, setDraftAdapter] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); const [toast, setToast] = useState(""); const [preferences, setPreferences] = useState<ModelSettings>({ "4bit": { ...DEFAULT_SETTINGS }, bf16: { ...DEFAULT_SETTINGS } }); const [temperature, setTemperature] = useState(0.7);
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState<Record<ModelId, boolean>>({ "4bit": false, bf16: false });
  const [diagnosticRecords, setDiagnosticRecords] = useState<DiagnosticRecord[]>([]);
  const diagnosticsById = new Map(diagnosticRecords.map(record => [record.id, record]));
  function patchDiagnostic(id: string, patch: Partial<DiagnosticRecord>) {
    setDiagnosticRecords(records => records.map(record => record.id === id ? { ...record, ...patch } : record));
  }
  function patchBrowserTiming(id: string, patch: Partial<BrowserTimings>) {
    setDiagnosticRecords(records => records.map(record => record.id === id && record.browserTimings
      ? { ...record, browserTimings: { ...record.browserTimings, ...patch } } : record));
  }
  const markFirstRender = useCallback((id: string, observed: number) => {
    setDiagnosticRecords(records => records.map(record => record.id === id && record.browserStartedAt !== undefined && record.browserTimings && record.browserTimings.firstRenderMs === null
      ? { ...record, browserTimings: { ...record.browserTimings, firstRenderMs: observed - record.browserStartedAt } } : record));
  }, []);
  const controller = useRef<AbortController | null>(null); const textarea = useRef<HTMLTextAreaElement>(null); const searchInput = useRef<HTMLInputElement>(null); const bottom = useRef<HTMLDivElement>(null); const scroller = useRef<HTMLDivElement>(null); const follow = useRef(true); const dialog = useRef<HTMLDivElement>(null);
  const active = chats.find(c => c.id === activeId); const messages = active?.messages ?? [];
  const selectedModel = active?.model ?? draftModel;
  const connection = connections[selectedModel];
  const selectedAdapter = active ? active.useAdapter ?? true : draftAdapter;
  const adapterAvailable = selectedModel === "bf16" && connection.adapterToggleAvailable === true;
  const selectedLabel = answerModelLabel(selectedModel, adapterAvailable ? selectedAdapter : undefined);
  const preview = connection.mode === "preview";
  const limits = connection.limits ?? SETTINGS_MAX;
  const effectiveSettings = fitSettings(preferences[selectedModel], limits);

  useEffect(() => {
    if (!authenticated) return;
    try { const stored = parseConversations(localStorage.getItem(STORAGE_KEY)); setChats(stored); setActiveId(stored[0]?.id ?? null); setDiagnosticRecords([]); setDiagnosticsEnabled({ "4bit": false, bf16: false }); }
    catch { setToast("Your browser couldn't load saved conversations."); }
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      setPreferences(parseModelSettings(localStorage.getItem(MODEL_SETTINGS_KEY), raw));
      const temperature = JSON.parse(raw ?? "null")?.temperature;
      if (typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 1.5) setTemperature(temperature);
    } catch { setToast("Your browser couldn't load saved settings."); }
    setLoaded(true);
  }, [authenticated]);
  useEffect(() => {
    if (!loaded || !authenticated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(chats)); }
    catch { setToast("Browser storage is full. This conversation will only be available in this tab."); }
  }, [chats, loaded, authenticated]);
  useEffect(() => {
    if (!loaded || !authenticated) return;
    try { localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(preferences)); localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...preferences["4bit"], temperature })); }
    catch { setToast("Your browser couldn't save settings. They will only apply in this tab."); }
  }, [preferences, temperature, loaded, authenticated]);
  useEffect(() => {
    if (!authenticated || !loaded) return;
    setConnections(initialModelConnections());
    const requests = allModelStatusRequests(status => setConnections(current => updateModelConnection(current, status)), () => setAuthenticated(false));
    statusRequests.current = requests;
    void requests.refresh(); const timer = setInterval(() => { void requests.refresh(); }, 30_000);
    return () => { requests.dispose(); clearInterval(timer); if (statusRequests.current === requests) statusRequests.current = null; };
  }, [authenticated, loaded]);
  useEffect(() => { if (settings) void statusRequests.current?.refresh(); }, [settings]);
  useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ behavior: busy ? "instant" : "smooth" }); }, [chats, busy]);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = "auto"; textarea.current.style.height = Math.min(textarea.current.scrollHeight, 160) + "px"; } }, [draft]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 6000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") { event.preventDefault(); setSidebar(true); setTimeout(() => searchInput.current?.focus(), 20); }
      if (event.key === "Escape") { setSidebar(false); setSettings(false); setDeleting(null); }
    }
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!settings && !deleting) return;
    const previous = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLElement>("button, select, input")?.focus();
    return () => previous?.focus();
  }, [settings, deleting]);
  useEffect(() => () => controller.current?.abort(), []);

  async function login(event: FormEvent) {
    event.preventDefault(); setSigningIn(true); setLoginError("");
    try {
      const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (!response.ok) throw new Error((await response.json()).error);
      setPassword(""); setAuthenticated(true);
    } catch (error) { setLoginError(error instanceof Error ? error.message : "Couldn't sign in. Try again."); }
    finally { setSigningIn(false); }
  }
  function newChat() { controller.current?.abort(); setDraftModel(selectedModel); setDraftAdapter(true); setActiveId(null); setDraft(""); setSidebar(false); follow.current = true; textarea.current?.focus(); }
  function selectAdapter(useAdapter: boolean) {
    if (controller.current || busy || !adapterAvailable) return;
    if (activeId) setChats(previous => previous.map(chat => chat.id === activeId ? { ...chat, useAdapter } : chat));
    else setDraftAdapter(useAdapter);
  }
  function selectModel(model: ModelId) {
    if (controller.current || busy) return;
    if (activeId) setChats(prev => prev.map(chat => chat.id === activeId ? { ...chat, model } : chat));
    else setDraftModel(model);
    void statusRequests.current?.refresh();
  }
  function updateMessage(chatId: string, messageId: string, patch: Partial<Message> | ((m: Message) => Partial<Message>)) {
    setChats(prev => prev.map(chat => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map(m => m.id === messageId ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m) }));
  }
  async function send(text = draft, history = messages) {
    const submitted = performance.now();
    text = text.trim(); if (!text || controller.current) return;
    if (chats.length >= 100 && !activeId) { setToast("You have 100 saved chats. Delete one before starting another."); return; }
    if (!connection.ready || !connection.limits) { setToast(connection.error ?? "Wait for the server limits to be verified before sending."); return; }
    if (selectedModel === "bf16" && selectedAdapter === false && !adapterAvailable) { setToast("Adapter selection is unavailable. Reconnect or start a new conversation."); return; }
    const useAdapter = adapterAvailable ? selectedAdapter : undefined;
    if (text.length > effectiveSettings.inputCharacters) { setToast(`Please shorten your message to ${effectiveSettings.inputCharacters.toLocaleString()} characters or fewer.`); return; }
    const id = activeId ?? uid(); const responseId = uid();
    const pending: Message[] = [...history, { id: uid(), role: "user", content: text }, { id: responseId, role: "assistant", content: "", model: selectedModel, useAdapter }];
    const candidates = [...completedHistory(history), { role: "user", content: text }];
    let input;
    try { input = fitMessages(candidates, effectiveSettings, temperature, selectedModel, useAdapter); }
    catch (error) { setToast(error instanceof Error ? error.message : "Message exceeds your configured limits."); return; }
    const captureDiagnostic = diagnosticsEnabled[selectedModel] && connection.diagnosticsAvailable === true;
    if (captureDiagnostic) setDiagnosticRecords(records => [...records.slice(-99), {
      id: responseId, createdAt: new Date().toISOString(), status: "pending", selectedModel, useAdapter,
      browserOriginalMessages: candidates.length, browserSentMessages: input.length,
      browserOriginalBytes: jsonBytes(candidates), browserSentBytes: jsonBytes(input),
      outputBudget: effectiveSettings.outputTokens, safetyReserve: effectiveSettings.safetyTokens,
      contextBudget: effectiveSettings.contextTokens, reuseCachedPrefixes: effectiveSettings.reuseCachedPrefixes,
      settings: { ...effectiveSettings }, temperature,
      gateway: null, usage: null, finishReason: null,
      browserStartedAt: submitted,
      browserTimings: { firstContentMs: null, firstRenderMs: null, completionMs: null, elapsedMs: null },
    }]);
    const locallyTrimmed = input.length < completedHistory(history).length + 1;
    setChats(prev => [{ id, model: selectedModel, useAdapter: useAdapter ?? active?.useAdapter, title: active?.title ?? text.slice(0, 48), updatedAt: Date.now(), messages: pending }, ...prev.filter(c => c.id !== id)]);
    setActiveId(id); setDraft(""); setSidebar(false); follow.current = true;
    const abort = new AbortController(); controller.current = abort; setBusy(id);
    let responseStarted = false;
    let contentReceived = false;
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", ...(captureDiagnostic ? { [DIAGNOSTICS_HEADER]: "1" } : {}) }, body: JSON.stringify({ model: selectedModel, useAdapter, messages: input, max_tokens: effectiveSettings.outputTokens, temperature, settings: effectiveSettings }), signal: abort.signal });
      const gateway = captureDiagnostic ? parseDiagnosticHeader(response.headers.get(DIAGNOSTICS_HEADER)) : null;
      if (captureDiagnostic) patchDiagnostic(responseId, { gateway });
      if (!response.ok || !response.body) { if (response.status === 401) setAuthenticated(false); throw new Error((await response.json()).error ?? "Couldn't start a reply."); }
      responseStarted = true;
      if (captureDiagnostic) patchDiagnostic(responseId, { status: "streaming" });
      const trimmed = Number(response.headers.get("X-Context-Trimmed") ?? 0);
      if (trimmed || locallyTrimmed) updateMessage(id, responseId, { note: "Earlier messages were omitted to fit the model's context." });
      await consumeCompletion(response.body, delta => {
        if (captureDiagnostic && delta && !contentReceived) {
          contentReceived = true; patchBrowserTiming(responseId, { firstContentMs: performance.now() - submitted });
        }
        updateMessage(id, responseId, m => ({ content: m.content + delta }));
      }, reason => {
        if (captureDiagnostic) patchDiagnostic(responseId, { finishReason: reason });
        if (reason === "length") updateMessage(id, responseId, { note: "Response length reached. Ask me to continue for more." });
      }, captureDiagnostic ? usage => patchDiagnostic(responseId, { usage }) : undefined,
      captureDiagnostic ? event => { if (event.requestId === gateway?.requestId) patchDiagnostic(responseId, { gatewayTimings: event.timings }); } : undefined);
      if (captureDiagnostic) patchBrowserTiming(responseId, { completionMs: performance.now() - submitted });
      if (captureDiagnostic) patchDiagnostic(responseId, { status: "completed" });
      updateMessage(id, responseId, { state: "complete" });
    } catch (error) {
      if (captureDiagnostic) patchDiagnostic(responseId, { status: abort.signal.aborted ? "stopped" : responseStarted ? "interrupted" : "error" });
      if (abort.signal.aborted) updateMessage(id, responseId, { state: "stopped", note: "You stopped this reply." });
      else updateMessage(id, responseId, { state: "error", note: error instanceof Error ? error.message : "The connection was interrupted. Please retry." });
    } finally {
      if (captureDiagnostic) patchBrowserTiming(responseId, { elapsedMs: performance.now() - submitted });
      controller.current = null; setBusy(null); textarea.current?.focus();
    }
  }
  function retry() { const index = messages.findLastIndex(m => m.role === "user"); if (index >= 0) void send(messages[index].content, messages.slice(0, index)); }
  async function logout() {
    controller.current?.abort();
    try { const res = await fetch("/api/logout", { method: "POST" }); if (!res.ok) throw new Error(); setAuthenticated(false); setSettings(false); setLoaded(false); setChats([]); setDiagnosticRecords([]); setDiagnosticsEnabled({ "4bit": false, bf16: false }); setActiveId(null); }
    catch { setToast("Couldn't sign out. Please try again."); }
  }
  function trapFocus(event: React.KeyboardEvent) {
    if (event.key !== "Tab") return;
    const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]'); if (!items?.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  if (!authenticated) return <div className="login-page">
    <div className="login-brand">{logo}<span>qwen<span className="brand-dot">.</span></span></div>
    <main className="login-main"><div className="eyebrow"><span className="tiny-line"/> YOUR PERSONAL WORKSPACE</div><h1>A space for<br/><em>your next thought.</em></h1><p>Welcome back. Make yourself at home.</p>
      <form onSubmit={login} className="login-form"><label htmlFor="workspace-password">Workspace password</label><input id="workspace-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required autoFocus disabled={!loginConfigured}/>{loginError && <p className="form-error" role="alert">{loginError}</p>}{!loginConfigured && <p className="form-error">Workspace login needs to be configured before you can sign in.</p>}<button className="primary-button" disabled={signingIn || !loginConfigured}>{signingIn ? <LoaderCircle size={18} className="spin"/> : <>Enter workspace <ArrowUpRight size={18}/></>}</button></form>
      <div className="login-note"><ShieldCheck size={15}/> Just you and your ideas.</div>
    </main><footer className="login-footer">A little curiosity goes a long way.<span>POWERED BY QWEN</span></footer>
    <div className="login-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><span>✳</span><i className="orbit-dot"/></div>
  </div>;

  return <div className="workspace">
    {sidebar && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebar(false)}/>}
    <aside className={`sidebar ${sidebar ? "is-open" : ""}`} aria-label="Conversations">
      <div className="sidebar-brand"><button className="wordmark" onClick={newChat} aria-label="Qwen home">{logo}<span>qwen<span className="brand-dot">.</span></span></button><button className="icon-button mobile-only" onClick={() => setSidebar(false)} aria-label="Close sidebar"><PanelLeftClose size={18}/></button><span className="personal-tag">PERSONAL</span></div>
      <button className="new-chat" onClick={newChat}><Plus size={17}/> New conversation <span>↗</span></button>
      <div className="search-chats"><Search size={15}/><input ref={searchInput} aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ K</kbd></div>
      <div className="history-heading">YOUR CONVERSATIONS<span>{chats.length.toString().padStart(2, "0")}</span></div>
      <div className="history-list">{chats.filter(c => c.title.toLowerCase().includes(search.toLowerCase())).map(chat => <div className={`history-item ${chat.id === activeId ? "active" : ""}`} key={chat.id}><button className="history-link" onClick={() => { setActiveId(chat.id); setDraft(""); setSidebar(false); follow.current = true; }}><MessageSquare size={15}/><span>{chat.title}</span></button><button className="delete-chat" aria-label={`Delete ${chat.title}`} onClick={() => setDeleting(chat.id)}><Trash2 size={14}/></button></div>)}{!chats.length && <div className="empty-history"><MessageSquare size={23} strokeWidth={1.3}/><p>Good conversations<br/>start with a little curiosity.</p><span>Your chats will appear here.</span></div>}{chats.length > 0 && !chats.some(c => c.title.toLowerCase().includes(search.toLowerCase())) && <p className="no-results">No conversations found.</p>}</div>
      <div className="sidebar-bottom"><div className="private-note"><ShieldCheck size={15}/><span>Saved only in this browser</span></div><button className="profile-button" onClick={() => setSettings(true)}><span className="avatar">Z</span><span><strong>Your workspace</strong><small>Personal account</small></span><Settings2 size={17}/></button></div>
    </aside>
    <div className="main-shell">
      <header className="workspace-header"><div className="workspace-heading"><button className="icon-button mobile-only" onClick={() => setSidebar(true)} aria-label="Open sidebar"><Menu size={20}/></button><span className="header-label">Personal workspace</span><span className="header-slash">/</span><label className="model-picker"><span className="sr-only">Model</span><select aria-label="Model" value={selectedModel} disabled={!!busy} onChange={e => selectModel(e.target.value as ModelId)}>{MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select><ChevronDown size={14} aria-hidden="true"/></label></div><button className={`connection-pill ${connection.mode === "live" && connection.ready ? "online" : preview ? "preview" : "offline"}`} onClick={() => setSettings(true)}><span/>{preview ? "Local preview" : connection.mode === "checking" ? "Connecting" : connection.mode === "unconfigured" ? "Setup needed" : connection.ready ? "Model online" : "Model offline"}<ArrowUpRight size={13}/></button></header>
      {adapterAvailable && <div className="adapter-controls"><label className="adapter-toggle"><input type="checkbox" role="switch" aria-label="Use trained adapter" checked={selectedAdapter} disabled={!!busy || !connection.ready} onChange={event => selectAdapter(event.target.checked)}/><span>Use trained adapter</span><strong>{selectedAdapter ? "On" : "Off"}</strong></label><span>{selectedAdapter ? "BF16 + adapter" : "BF16 base"}</span></div>}
      <main className={`chat-main ${messages.length ? "has-messages" : ""}`} ref={scroller} onScroll={() => { const el = scroller.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
        {!messages.length ? <div className="welcome"><div className="welcome-mark" aria-hidden="true"><span>✳</span><i/></div><div className="eyebrow">A FRESH CONVERSATION</div><h1>A little curiosity.<br/><em>A lot of possibility.</em></h1><p>Your space to think, write, and work things out.</p><div className="starter-grid">{starters.map(card => <button className="starter-card" key={card.label} onClick={() => { setDraft(card.text); textarea.current?.focus(); }}><div><card.icon size={20} strokeWidth={1.45}/><ArrowUpRight size={16}/></div><strong>{card.label}</strong><small>{card.caption}</small></button>)}</div></div>
        : <div className="message-list">{messages.map((message, index) => <article className={`message ${message.role}`} key={message.id}><div className="message-avatar">{message.role === "assistant" ? logo : "Z"}</div><div className="message-body"><div className="message-author">{message.role === "user" ? "You" : answerModelLabel(message.model ?? DEFAULT_MODEL, message.useAdapter)}{message.role === "assistant" && <span>ASSISTANT</span>}</div>{message.content ? message.role === "user" ? <p className="user-content">{message.content}</p> : <AnswerPaint messageId={message.id} onPaint={diagnosticsById.get(message.id)?.browserTimings?.firstRenderMs === null ? markFirstRender : undefined}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock>, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{message.content}</ReactMarkdown></AnswerPaint> : busy === activeId && index === messages.length - 1 ? <div className="thinking" aria-label="Qwen is thinking"><span/><span/><span/></div> : null}{diagnosticsById.has(message.id) && <RequestDiagnostics record={diagnosticsById.get(message.id)!}/>} {message.note && <div className={`message-note ${message.state === "error" ? "error" : ""}`} role={message.state === "error" ? "alert" : undefined}>{message.note}</div>}{message.role === "assistant" && busy !== activeId && <div className="message-actions">{message.content && <CopyButton text={message.content}/>} {index === messages.length - 1 && <button onClick={retry} disabled={!!busy}><RotateCcw size={14}/><span>Try again</span></button>}{message.state === "stopped" && <span>Stopped</span>}</div>}</div></article>)}<div ref={bottom}/></div>}
      </main>
      <div className="composer-region"><div className="composer-wrap">{preview && <div className="preview-note"><Sparkles size={13}/> Local preview · sample replies, no model requests</div>}{connection.mode === "live" && !connection.ready && <div className="offline-note">Your model may be stopped or loading. You can try again when it’s ready.</div>}<form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}><label className="sr-only" htmlFor="message">Message Qwen</label><textarea ref={textarea} id="message" placeholder="What’s on your mind?" value={draft} onChange={e => setDraft(e.target.value)} maxLength={effectiveSettings.inputCharacters} rows={1} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="composer-bottom"><span className="composer-model">{logo} {selectedLabel}</span><div className="composer-controls"><span className="enter-hint">Shift + Enter for a new line</span>{busy ? <button type="button" className="send-button stop-button" aria-label="Stop generation" onClick={() => controller.current?.abort()}><Square size={15} fill="currentColor"/></button> : <button className="send-button" aria-label="Send message" disabled={!draft.trim()}><ArrowUp size={20}/></button>}</div></div></form><p className="composer-footer">A helpful second perspective. Always give important details a second look.</p></div></div>
    </div>
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")} aria-label="Dismiss notification"><X size={14}/></button></div>}
    {(settings || deleting) && <div className="modal-backdrop" onClick={() => { setSettings(false); setDeleting(null); }}><div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={dialog} onKeyDown={trapFocus} onClick={e => e.stopPropagation()}><button className="icon-button close-dialog" onClick={() => { setSettings(false); setDeleting(null); }} aria-label="Close dialog"><X size={20}/></button>{deleting ? <><div className="eyebrow">MAKE A LITTLE ROOM</div><h2 id="dialog-title">Delete this conversation?</h2><p>This removes the conversation from this browser. It can’t be undone.</p><div className="dialog-buttons"><button className="secondary-button" onClick={() => setDeleting(null)}>Keep conversation</button><button className="danger-button" onClick={() => { if (busy === deleting) controller.current?.abort(); setChats(prev => prev.filter(c => c.id !== deleting)); if (activeId === deleting) setActiveId(null); setDeleting(null); }}>Delete conversation</button></div></> : <><div className="eyebrow">MAKE YOURSELF AT HOME</div><h2 id="dialog-title">Your workspace</h2><ModelSettingsPanel connections={connections} preferences={preferences} busy={!!busy}
      temperature={temperature} onTemperatureChange={setTemperature}
      diagnosticsEnabled={diagnosticsEnabled} onDiagnosticsChange={(model, enabled) => setDiagnosticsEnabled(previous => ({ ...previous, [model]: enabled }))}
      onRefresh={() => { void statusRequests.current?.refresh(); }}
      onApply={(model, next) => { setPreferences(previous => ({ ...previous, [model]: next })); setToast(`${modelInfo(model).label} settings saved.`); }}/>
      {diagnosticRecords.length > 0 && <div className="diagnostic-session"><p className="settings-help">{diagnosticRecords.length} diagnostic records in this session (latest 100). Reloading or signing out clears them.</p><button type="button" className="secondary-button" onClick={() => exportDiagnostics(diagnosticRecords)}>Export session CSV</button></div>}<p className="settings-footnote">Chats stay in this browser. In live mode, messages you send are processed by your model. Older messages may be omitted to fit its context.</p><button className="signout-button" onClick={logout}><LogOut size={16}/> Sign out</button></>}</div></div>}
  </div>;
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState("idle");
  async function copy() { setState(await copyText(text) ? "copied" : "failed"); setTimeout(() => setState("idle"), 2500); }
  return <button onClick={copy} aria-label={state === "copied" ? "Copied" : "Copy response"}>{state === "copied" ? <Check size={14}/> : <Copy size={14}/>}<span>{state === "copied" ? "Copied" : state === "failed" ? "Select text to copy" : "Copy"}</span></button>;
}
function CodeBlock({ children }: { children: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null); const [state, setState] = useState("idle");
  return <div className="code-block"><div><span>Code</span><button aria-label="Copy code" onClick={async () => { setState(await copyText(pre.current?.innerText ?? "") ? "copied" : "failed"); setTimeout(() => setState("idle"), 2500); }}>{state === "copied" ? <Check size={13}/> : <Copy size={13}/>} {state === "copied" ? "Copied" : state === "failed" ? "Select code to copy" : "Copy code"}</button></div><pre ref={pre}>{children}</pre></div>;
}
async function copyText(text: string) {
  // Embedded browsers may deny the asynchronous clipboard API. Keep a user-gesture fallback.
  const field = document.createElement("textarea");
  field.value = text; field.setAttribute("readonly", ""); field.style.cssText = "position:fixed;left:-9999px;top:0";
  const previous = document.activeElement as HTMLElement;
  document.body.append(field); field.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { /* Try the modern API below. */ }
  field.remove(); previous?.focus();
  if (copied) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Clipboard unavailable")), 1500); })
    ]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timeout); }
}
