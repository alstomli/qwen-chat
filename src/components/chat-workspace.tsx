"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, ArrowUpRight, Check, ChevronDown, Code2, Compass, Copy, Feather, ImagePlus, LoaderCircle, LogOut, Menu, MessageSquare, PanelLeftClose, Plus, Search, Settings2, ShieldCheck, Sparkles, Square, Trash2, X, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RequestDiagnostics, exportDiagnostics } from "@/components/request-diagnostics";
import { DIAGNOSTICS_HEADER, parseDiagnosticHeader, type BrowserTimings, type DiagnosticRecord } from "@/lib/diagnostics";
import { AnswerPaint } from "@/components/answer-paint";
import { ModelSettingsPanel } from "@/components/model-settings-panel";
import { DEFAULT_SETTINGS, SETTINGS_MAX, SETTINGS_KEY, MODEL_SETTINGS_KEY, parseModelSettings, fitSettings, fitMessages, jsonBytes, type ModelSettings } from "@/lib/chat-settings";
import { consumeCompletion } from "@/lib/protocol";
import { DOCS_GATEWAY_ERROR, DOCS_MODE_HEADER, DOCS_SOURCES_HEADER, DOCS_UNAVAILABLE_ERROR, parseDocsSourcesHeader } from "@/lib/docs-sources";
import { remarkDocsCitations } from "@/lib/docs-citations";
import { IMAGE_ACCEPTED_HEADER, IMAGE_ADAPTER_ERROR, validateImageInput } from "@/lib/image-input";
import { prepareImage, type ImageAttachment } from "@/lib/prepare-image";
import { completedHistory, parseConversations, STORAGE_KEY, type Conversation, type Message } from "@/lib/storage";
import { exportHistory, HISTORY_NOTICE_KEY, type SaveState } from "@/lib/cloud-history";
import { useCloudHistory } from "@/lib/use-cloud-history";

import { browserAuth } from "@/lib/supabase/browser";
import { accountStorageKey } from "@/lib/account-storage";
import { DEFAULT_MODEL, MODELS, modelInfo, answerModelLabel, type ModelId } from "@/lib/models";
import { allModelStatusRequests, initialModelConnections, updateModelConnection } from "@/lib/model-status";
const starters = [
  { icon: Feather, label: "Find the right words", text: "Help me write a thoughtful email to reconnect with an old colleague. Keep it warm and natural.", caption: "A first draft, a fresh perspective" },
  { icon: Compass, label: "Make sense of something", text: "Explain how large language models work, using a simple everyday analogy.", caption: "Turn a big idea into a clear one" },
  { icon: Code2, label: "Build something useful", text: "Write a small Python function that reads a CSV file and summarizes its numeric columns. Explain each step.", caption: "Work through code, step by step" },
];
const uid = () => crypto.randomUUID();
const logo = <span className="qwen-symbol" aria-hidden="true">✳</span>;

export default function ChatWorkspace({ userId, email }: { userId: string; email: string }) {
  const [authenticated, setAuthenticated] = useState(true);
  const storageKey = accountStorageKey(STORAGE_KEY, userId);
  const settingsKey = accountStorageKey(SETTINGS_KEY, userId);
  const modelSettingsKey = accountStorageKey(MODEL_SETTINGS_KEY, userId);
  const [chats, setChats] = useState<Conversation[]>([]); const [loaded, setLoaded] = useState(false);
  const legacyIds = useRef(new Set<string>());
  const legacySnapshot = useRef<Conversation[] | null>(null);
  const [legacyDurable, setLegacyDurable] = useState(true);
  const [historyNotice, setHistoryNotice] = useState(false);
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null); const [draft, setDraft] = useState(""); const [search, setSearch] = useState("");
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const [docsMode, setDocsMode] = useState(false);
  const [readingImage, setReadingImage] = useState(false);
  const [retryImageId, setRetryImageId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageRead = useRef(0);
  const sentImages = useRef(new Map<string, { chatId: string; attachment: ImageAttachment }>());
  const savedDrafts = useRef(new Map<string | null, { text: string; attachment: ImageAttachment | null; retryId: string | null }>());
  const [sidebar, setSidebar] = useState(false); const [settings, setSettings] = useState(false); const [deleting, setDeleting] = useState<string | null>(null);
  const [connections, setConnections] = useState(initialModelConnections);
  const statusRequests = useRef<ReturnType<typeof allModelStatusRequests> | null>(null);
  const [draftModel, setDraftModel] = useState<ModelId>(DEFAULT_MODEL);
  const [draftAdapter, setDraftAdapter] = useState(true);
  const [streamingChats, setStreamingChats] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState(""); const [preferences, setPreferences] = useState<ModelSettings>({ "4bit": { ...DEFAULT_SETTINGS }, bf16: { ...DEFAULT_SETTINGS } }); const [temperature, setTemperature] = useState(0.7);
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
  const controllers = useRef(new Map<string, AbortController>());
  const cloud = useCloudHistory(userId, authenticated, loaded, legacyIds, chats, setChats, setToast, controllers);
  const textarea = useRef<HTMLTextAreaElement>(null); const searchInput = useRef<HTMLInputElement>(null); const bottom = useRef<HTMLDivElement>(null); const scroller = useRef<HTMLDivElement>(null); const follow = useRef(true); const dialog = useRef<HTMLDivElement>(null);
  const active = chats.find(c => c.id === activeId); const messages = active?.messages ?? [];
  const busy = activeId !== null && streamingChats.has(activeId);
  const selectedModel = active?.model ?? draftModel;
  const connection = connections[selectedModel];
  const selectedAdapter = active ? active.useAdapter ?? true : draftAdapter;
  const adapterAvailable = selectedModel === "bf16" && connection.adapterToggleAvailable === true;
  const selectedLabel = answerModelLabel(selectedModel, adapterAvailable ? selectedAdapter : undefined);
  const preview = connection.mode === "preview";
  const docsAvailable = connection.mode === "live" && connection.ready && connection.docsModeAvailable === true;
  const docsHelp = retryImageId ? "Cancel the image retry to use Runpod Docs."
    : attachment || readingImage ? "Remove the image to use Runpod Docs."
    : preview ? "Runpod Docs is unavailable in local preview."
    : connection.docsModeUnavailable === "gateway" ? DOCS_GATEWAY_ERROR
    : connection.docsModeUnavailable === "index" ? "Configure the local Runpod Docs index to enable this mode."
    : !docsAvailable ? DOCS_UNAVAILABLE_ERROR : "Search official Runpod documentation. Text only.";
  const limits = connection.limits ?? SETTINGS_MAX;
  const effectiveSettings = fitSettings(preferences[selectedModel], limits);
  const imageInput = selectedModel === "bf16" && connection.mode === "live" && connection.ready ? connection.imageInput : undefined;
  const imageUnavailable = selectedModel !== "bf16" ? "Select the BF16 model to attach an image."
    : !imageInput ? "Image attachments require a connected BF16 gateway with image input enabled."
    : adapterAvailable && selectedAdapter ? IMAGE_ADAPTER_ERROR : "";
  const attachmentUnavailable = docsMode ? "Runpod Docs supports text only." : imageUnavailable;

  useEffect(() => {
    if (!authenticated) return;
    try { const stored = parseConversations(localStorage.getItem(storageKey)); legacyIds.current = new Set(stored.map(chat => chat.id)); setChats(stored); setActiveId(stored[0]?.id ?? null); setDocsMode(false); setDiagnosticRecords([]); setDiagnosticsEnabled({ "4bit": false, bf16: false }); setHistoryNotice(localStorage.getItem(accountStorageKey(HISTORY_NOTICE_KEY, userId)) !== "dismissed"); }
    catch { setToast("Your browser couldn't load saved conversations."); }
    try {
      const raw = localStorage.getItem(settingsKey);
      setPreferences(parseModelSettings(localStorage.getItem(modelSettingsKey), raw));
      const temperature = JSON.parse(raw ?? "null")?.temperature;
      if (typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 1.5) setTemperature(temperature);
    } catch { setToast("Your browser couldn't load saved settings."); }
    setLoaded(true);
  }, [authenticated]);
  useEffect(() => {
    if (!loaded || !authenticated) return;
    const local = chats.filter(chat => legacyIds.current.has(chat.id));
    if (legacySnapshot.current?.length === local.length && local.every((chat, index) => legacySnapshot.current?.[index] === chat)) return;
    try { localStorage.setItem(storageKey, JSON.stringify(local)); legacySnapshot.current = local; setLegacyDurable(true); }
    catch { setLegacyDurable(false); setToast("Browser storage is full. This conversation will only be available in this tab."); }
  }, [chats, loaded, authenticated]);
  useEffect(() => {
    if (!loaded || !authenticated) return;
    try { localStorage.setItem(modelSettingsKey, JSON.stringify(preferences)); localStorage.setItem(settingsKey, JSON.stringify({ ...preferences["4bit"], temperature })); }
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
  useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ behavior: busy ? "instant" : "smooth" }); }, [active, busy]);
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
  useEffect(() => {
    if (!authenticated) return;
    const requests = controllers.current;
    return () => { for (const request of requests.values()) request.abort(); };
  }, [authenticated]);

  function clearDraft() {
    removeAttachment();
    setDraft(""); setRetryImageId(null);
  }
  function removeAttachment() {
    imageRead.current++;
    setReadingImage(false); setAttachment(null);
  }
  function switchConversation(id: string | null) {
    if (readingImage) { setToast("Wait for the image to finish preparing before switching conversations."); return false; }
    if (id !== activeId) {
      if (attachment || retryImageId) savedDrafts.current.set(activeId, { text: draft, attachment, retryId: retryImageId });
      const pending = savedDrafts.current.get(id);
      savedDrafts.current.delete(id);
      setActiveId(id);
      setDocsMode(false);
      setDraft(pending?.text ?? "");
      setAttachment(pending?.attachment ?? null);
      setRetryImageId(pending?.retryId ?? null);
    }
    setSidebar(false); follow.current = true;
    if (id && cloud?.entries.get(id)?.loaded === false) {
      setHistoryLoading(id);
      void cloud.load(id).catch(error => setToast(error instanceof Error ? error.message : "Couldn't load this conversation.")).finally(() => setHistoryLoading(current => current === id ? null : current));
    }
    return true;
  }
  function newChat() {
    if (!switchConversation(null)) return;
    if (activeId === null && !attachment && !retryImageId) clearDraft();
    setDocsMode(false); setDraftModel(selectedModel); setDraftAdapter(true); textarea.current?.focus();
  }
  async function chooseImage(file: File) {
    if (attachmentUnavailable || !imageInput) { setToast(attachmentUnavailable); return; }
    const version = ++imageRead.current;
    setReadingImage(true);
    try {
      const wireWithoutImageData = jsonBytes({
        model: selectedModel, useAdapter: adapterAvailable ? selectedAdapter : undefined,
        messages: [{ role: "user", content: draft.trim() || " " }],
        max_tokens: effectiveSettings.outputTokens, temperature, settings: effectiveSettings,
        image: "data:image/jpeg;base64,", stream: true,
      });
      const imageBudget = Math.floor((effectiveSettings.requestBytes - wireWithoutImageData) / 4) * 3;
      const next = await prepareImage(file, imageInput, imageBudget);
      if (version === imageRead.current) setAttachment(next);
    } catch (error) {
      if (version === imageRead.current) setToast(error instanceof Error ? error.message : "Couldn't prepare this image.");
    } finally {
      if (version === imageRead.current) setReadingImage(false);
    }
  }
  function selectAdapter(useAdapter: boolean) {
    if ((activeId && controllers.current.has(activeId)) || !adapterAvailable) return;
    if (activeId) setChats(previous => previous.map(chat => chat.id === activeId ? { ...chat, useAdapter } : chat));
    else setDraftAdapter(useAdapter);
  }
  function selectModel(model: ModelId) {
    if (activeId && controllers.current.has(activeId)) return;
    if (activeId) setChats(prev => prev.map(chat => chat.id === activeId ? { ...chat, model } : chat));
    else setDraftModel(model);
    void statusRequests.current?.refresh();
  }
  function updateMessage(chatId: string, messageId: string, patch: Partial<Message> | ((m: Message) => Partial<Message>)) {
    setChats(prev => prev.map(chat => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map(m => m.id === messageId ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m) }));
  }
  async function send(text = draft, retryId: string | null = retryImageId, image = attachment, enableDocs = docsMode) {
    const submitted = performance.now();
    text = text.trim(); if (!text || (activeId && controllers.current.has(activeId))) return;
    if (activeId && cloud?.entries.get(activeId)?.loaded === false) { setToast("Load this conversation before adding a message."); return; }
    if (!connection.ready || !connection.limits) { setToast(connection.error ?? "Wait for the server limits to be verified before sending."); return; }
    if (enableDocs && !docsAvailable) { setToast(DOCS_UNAVAILABLE_ERROR); return; }
    if (selectedModel === "bf16" && selectedAdapter === false && !adapterAvailable) { setToast("Adapter selection is unavailable. Reconnect or start a new conversation."); return; }
    const useAdapter = adapterAvailable ? selectedAdapter : undefined;
    if (text.length > effectiveSettings.inputCharacters) { setToast(`Please shorten your message to ${effectiveSettings.inputCharacters.toLocaleString()} characters or fewer.`); return; }
    const retryIndex = retryId ? messages.findIndex(message => message.id === retryId && message.role === "user") : -1;
    if (retryId && retryIndex < 0) { setToast("This earlier message is unavailable. Cancel the retry to start a new message."); return; }
    if (retryIndex >= 0 && messages[retryIndex].imageName && !image) { setToast("Reattach the image to retry this prompt."); return; }
    if (readingImage) { setToast("Wait for your image to finish preparing."); return; }
    if (image) {
      if (enableDocs) { setToast("Runpod Docs supports text only."); return; }
      if (imageUnavailable || !imageInput) { setToast(imageUnavailable); return; }
      try { validateImageInput(image.dataUrl, imageInput); }
      catch (error) { setToast(error instanceof Error ? error.message : "The image attachment is invalid."); return; }
    }
    const history = retryIndex < 0 ? messages : messages.slice(0, retryIndex);
    const id = activeId ?? uid(); const responseId = uid(); const userId = uid();
    const requestedDocs = enableDocs ? true : undefined;
    const pending: Message[] = [...history, { id: userId, role: "user", content: text, imageName: image?.name, docsMode: requestedDocs }, { id: responseId, role: "assistant", content: "", model: selectedModel, useAdapter }];
    const candidates = [...completedHistory(history), { role: "user", content: text }];
    let input;
    try { input = fitMessages(candidates, effectiveSettings, temperature, selectedModel, useAdapter, image?.dataUrl, requestedDocs); }
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
    if (retryId) sentImages.current.delete(retryId);
    if (image) {
      sentImages.current.set(userId, { chatId: id, attachment: image });
      if (sentImages.current.size > 32) {
        const oldest = sentImages.current.keys().next();
        if (!oldest.done) sentImages.current.delete(oldest.value);
      }
    }
    setChats(prev => [{ id, model: selectedModel, useAdapter: useAdapter ?? active?.useAdapter, title: active?.title ?? text.slice(0, 48), updatedAt: Date.now(), messages: pending }, ...prev.filter(c => c.id !== id)]);
    setActiveId(id); clearDraft(); setSidebar(false); follow.current = true;
    const abort = new AbortController();
    controllers.current.set(id, abort);
    setStreamingChats(previous => new Set(previous).add(id));
    textarea.current?.focus();
    let responseStarted = false;
    let contentReceived = false;
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", ...(captureDiagnostic ? { [DIAGNOSTICS_HEADER]: "1" } : {}) }, body: JSON.stringify({ model: selectedModel, useAdapter, messages: input, max_tokens: effectiveSettings.outputTokens, temperature, settings: effectiveSettings, image: image?.dataUrl, docsMode: requestedDocs }), signal: abort.signal });
      const gateway = captureDiagnostic ? parseDiagnosticHeader(response.headers.get(DIAGNOSTICS_HEADER)) : null;
      if (captureDiagnostic) patchDiagnostic(responseId, { gateway });
      if (!response.ok || !response.body) { if (response.status === 401) setAuthenticated(false); throw new Error((await response.json()).error ?? "Couldn't start a reply."); }
      if (image && response.headers.get(IMAGE_ACCEPTED_HEADER) !== "true") {
        await response.body.cancel().catch(() => {});
        throw new Error("The model did not confirm receipt of the attached image. Try again when image input is available.");
      }
      if (enableDocs) {
        const docsSources = parseDocsSourcesHeader(response.headers.get(DOCS_SOURCES_HEADER));
        if (response.headers.get(DOCS_MODE_HEADER) !== "1" || !docsSources) {
          await response.body.cancel().catch(() => {});
          throw new Error("Runpod Docs mode could not be verified. Please try again.");
        }
        updateMessage(id, responseId, { docsSources });
      }
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
      controllers.current.delete(id);
      setStreamingChats(previous => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }
  function retry() {
    const message = messages.findLast(m => m.role === "user");
    if (!message) return;
    if (attachment || readingImage || retryImageId) { setToast("Finish or clear the current image draft before retrying."); return; }
    const image = sentImages.current.get(message.id)?.attachment;
    if (message.imageName && !image) {
      setDocsMode(false); setDraft(message.content); setRetryImageId(message.id); textarea.current?.focus();
      return;
    }
    void send(message.content, message.id, image ?? null, message.docsMode === true);
  }
  function deleteConversation() {
    if (deleting && !legacyIds.current.has(deleting)) void cloud?.remove(deleting);
    if (deleting) controllers.current.get(deleting)?.abort();
    setChats(prev => prev.filter(c => c.id !== deleting));
    for (const [messageId, image] of sentImages.current) {
      if (image.chatId === deleting) sentImages.current.delete(messageId);
    }
    savedDrafts.current.delete(deleting);
    if (activeId === deleting) { setActiveId(null); clearDraft(); }
    setDeleting(null);
  }
  async function logout() {
    for (const request of controllers.current.values()) request.abort();
    const { error } = await browserAuth().auth.signOut({ scope: "local" });
    if (error) { setToast("Couldn't sign out. Please try again."); return; }
    cloud?.dispose(true);
    setAuthenticated(false);
  }
  useEffect(() => {
    const { data: { subscription } } = browserAuth().auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (event === "INITIAL_SESSION" && !session) || (session && (session.user.id !== userId || !session.user.email_confirmed_at))) { cloud?.dispose(true); setAuthenticated(false); }
    });
    return () => subscription.unsubscribe();
  }, [userId, cloud]);
  useEffect(() => {
    if (authenticated) return;
    for (const request of controllers.current.values()) request.abort();
    sentImages.current.clear(); savedDrafts.current.clear(); imageRead.current++;
    setChats([]); setLoaded(false); setDraft(""); setAttachment(null); setDiagnosticRecords([]);
    window.location.replace("/sign-in");
  }, [authenticated]);
  function trapFocus(event: React.KeyboardEvent) {
    if (event.key !== "Tab") return;
    const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]'); if (!items?.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const activeEntry = activeId ? cloud?.entries.get(activeId) : undefined;
  const localStates: SaveState[] = ["local", "oversized", "conflict", "deleted", "expired", "create_limited"];
  const isLocal = (chat: Conversation) => legacyIds.current.has(chat.id) || localStates.includes(cloud?.entries.get(chat.id)?.state ?? "saved");
  const hasPending = [...cloud?.entries.values() ?? []].some(entry => entry.state === "pending" || entry.deleting);
  const hasSaving = [...cloud?.entries.values() ?? []].some(entry => entry.state === "saving");
  const saveLabel = !cloud?.ready ? "Loading history…" : !cloud.durable || !legacyDurable ? "Not saved · Browser storage unavailable" : hasPending ? "Saved on this browser · Sync pending" : hasSaving ? "Saving…" : cloud.offline ? "Cloud history unavailable" : "Saved";
  const localChats = chats.filter(isLocal), cloudChats = chats.filter(chat => !isLocal(chat));
  function dismissHistoryNotice() {
    setHistoryNotice(false);
    try { localStorage.setItem(accountStorageKey(HISTORY_NOTICE_KEY, userId), "dismissed"); } catch {}
  }
  async function downloadHistory(format: "json" | "md", all = false) {
    setExporting(true);
    try {
      const selected = all ? chats : active ? [active] : [];
      const complete: Conversation[] = [];
      for (const chat of selected) {
        const entry = cloud?.entries.get(chat.id);
        const full = entry && !entry.loaded ? await cloud!.load(chat.id) : chat;
        if (full) complete.push(full);
      }
      exportHistory(complete, format);
    } catch (error) { setToast(error instanceof Error ? error.message : "Couldn't export history. Try again."); }
    finally { setExporting(false); }
  }
  function historyRow(chat: Conversation) {
    return <div className={`history-item ${chat.id === activeId ? "active" : ""}`} key={chat.id}><button className="history-link" onClick={() => switchConversation(chat.id)}>{streamingChats.has(chat.id) ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <MessageSquare size={15}/>}<span>{chat.title}</span>{streamingChats.has(chat.id) && <span className="sr-only">Reply in progress</span>}</button><button className="delete-chat" aria-label={`Delete ${chat.title}`} onClick={() => setDeleting(chat.id)}><Trash2 size={14}/></button></div>;
  }

  if (!authenticated) return <div className="login-page"><p>Returning to sign in...</p><a href="/sign-in">Sign in</a></div>;

  return <div className="workspace">
    {sidebar && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebar(false)}/>}
    <aside className={`sidebar ${sidebar ? "is-open" : ""}`} aria-label="Conversations">
      <div className="sidebar-brand"><button className="wordmark" onClick={newChat} aria-label="Qwen home">{logo}<span>qwen<span className="brand-dot">.</span></span></button><button className="icon-button mobile-only" onClick={() => setSidebar(false)} aria-label="Close sidebar"><PanelLeftClose size={18}/></button><span className="personal-tag">PERSONAL</span></div>
      <button className="new-chat" onClick={newChat}><Plus size={17}/> New conversation <span>↗</span></button>
      <div className="search-chats"><Search size={15}/><input ref={searchInput} aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ K</kbd></div>
      <div className="history-heading">CLOUD HISTORY<span>{cloud?.usage.count ?? 0} / 50</span></div>
      <div className="history-list">{historyNotice && <div className="history-notice"><p>New chats sync across devices. Cloud history keeps up to 50 chats or 2 MB. When full, chats with the oldest last message are removed, except the chat being saved. Images aren’t saved.</p><button onClick={dismissHistoryNotice}>Got it</button></div>}
      {cloudChats.filter(c => c.title.toLowerCase().includes(search.toLowerCase())).map(historyRow)}
        {localChats.length > 0 && <><div className="history-heading local-heading">ON THIS BROWSER<span>{localChats.length}</span></div>{localChats.filter(c => c.title.toLowerCase().includes(search.toLowerCase())).map(historyRow)}</>}
        {!chats.length && <div className="empty-history"><MessageSquare size={23} strokeWidth={1.3}/><p>Good conversations<br/>start with a little curiosity.</p><span>Your chats will appear here.</span></div>}{chats.length > 0 && !chats.some(c => c.title.toLowerCase().includes(search.toLowerCase())) && <p className="no-results">No conversations found.</p>}</div>
      <div className="sidebar-bottom"><div className="history-sync"><div className="private-note"><ShieldCheck size={15}/><span>Cloud history · {cloud?.usage.count ?? 0} / 50 chats</span></div><p>{cloud?.offline ? "Last known usage · " : ""}{((cloud?.usage.bytes ?? 0) / 1_000_000).toFixed(2)} MB / 2 MB <span className="sr-only">({cloud?.usage.bytes ?? 0} of 2,000,000 UTF-8 bytes)</span></p><p role="status">{saveLabel}</p>{hasPending && <button onClick={() => { void cloud?.retry(); }}>Retry sync</button>}{cloud?.offline && !hasPending && <button onClick={() => { void cloud.refresh(); }}>Retry loading history</button>}</div><button className="profile-button" onClick={() => setSettings(true)}><span className="avatar">{email[0]?.toUpperCase()}</span><span><strong>Your workspace</strong><small>{email}</small></span><Settings2 size={17}/></button></div>
    </aside>
    <div className="main-shell">
      <header className="workspace-header"><div className="workspace-heading"><button className="icon-button mobile-only" onClick={() => setSidebar(true)} aria-label="Open sidebar"><Menu size={20}/></button><span className="header-label">Personal workspace</span><span className="header-slash">/</span><label className="model-picker"><span className="sr-only">Model</span><select aria-label="Model" value={selectedModel} disabled={busy} onChange={e => selectModel(e.target.value as ModelId)}>{MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select><ChevronDown size={14} aria-hidden="true"/></label></div><button className={`connection-pill ${connection.mode === "live" && connection.ready ? "online" : preview ? "preview" : "offline"}`} onClick={() => setSettings(true)}><span/>{preview ? "Local preview" : connection.mode === "checking" ? "Connecting" : connection.mode === "unconfigured" ? "Setup needed" : connection.ready ? "Model online" : "Model offline"}<ArrowUpRight size={13}/></button></header>
      {adapterAvailable && <div className="adapter-controls"><label className="adapter-toggle"><input type="checkbox" role="switch" aria-label="Use trained adapter" checked={selectedAdapter} disabled={busy || !connection.ready} onChange={event => selectAdapter(event.target.checked)}/><span>Use trained adapter</span><strong>{selectedAdapter ? "On" : "Off"}</strong></label><span>{selectedAdapter ? "BF16 + adapter" : "BF16 base"}</span></div>}
      {active && isLocal(active) && <div className="history-local-note" role="status">{(legacyIds.current.has(active.id) ? !legacyDurable : !cloud?.durable) ? "Browser storage is unavailable. This copy is only in this tab; export it now to keep it." : legacyIds.current.has(active.id) ? "This older conversation stays on this browser, including new replies." : activeEntry?.state === "oversized" && !cloud?.durable ? "This chat is too large for cloud history and browser storage is unavailable. Export it now to keep a copy." : activeEntry?.state === "oversized" ? "This chat is too large for cloud history. It’s saved on this browser; export it to keep a copy." : activeEntry?.state === "conflict" ? "This chat changed on another device. Your unsynced copy stays on this browser." : activeEntry?.state === "create_limited" ? "Too many recent cloud chat changes. This chat stays on this browser; try a new chat later." : "This chat stays on this browser. Export it to keep a copy."}<button disabled={exporting} onClick={() => { void downloadHistory("json"); }}>Export JSON</button><button onClick={newChat}>Start new chat</button></div>}
      {cloud?.usage.paused && <div className="history-local-note" role="status">{cloud.durable ? "Cloud saving is temporarily paused. Your conversations stay on this browser until sync resumes. You can keep chatting, export, or delete history." : "Cloud saving is paused and browser storage is unavailable. Export your conversations now to keep a copy. You can keep chatting or delete history."}</div>}
      <main className={`chat-main ${messages.length ? "has-messages" : ""}`} ref={scroller} onScroll={() => { const el = scroller.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
        {historyLoading !== null && historyLoading === activeId ? <p className="history-loading" role="status">Loading conversation…</p> : activeId && activeEntry?.loaded === false ? <div className="history-loading"><p>Load this conversation to read or continue it.</p><button className="secondary-button" onClick={() => switchConversation(activeId)}>Try loading again</button></div> : !messages.length ? <div className="welcome"><div className="welcome-mark" aria-hidden="true"><span>✳</span><i/></div><div className="eyebrow">A FRESH CONVERSATION</div><h1>A little curiosity.<br/><em>A lot of possibility.</em></h1><p>Your space to think, write, and work things out.</p><div className="starter-grid">{starters.map(card => <button className="starter-card" key={card.label} onClick={() => { setDraft(card.text); textarea.current?.focus(); }}><div><card.icon size={20} strokeWidth={1.45}/><ArrowUpRight size={16}/></div><strong>{card.label}</strong><small>{card.caption}</small></button>)}</div></div>
        : <div className="message-list">
          {messages.map((message, index) => <article className={`message ${message.role}`} key={message.id}>
            <div className="message-avatar">{message.role === "assistant" ? logo : "Z"}</div>
            <div className="message-body">
              <div className="message-author">{message.role === "user" ? "You" : answerModelLabel(message.model ?? DEFAULT_MODEL, message.useAdapter)}{message.role === "assistant" && <span>ASSISTANT</span>}</div>
              {message.role === "user" && message.imageName && <MessageAttachment name={message.imageName} attachment={sentImages.current.get(message.id)?.attachment}/>}
              {message.content ? message.role === "user" ? <p className="user-content">{message.content}</p> : <AnswerPaint messageId={message.id} onPaint={diagnosticsById.get(message.id)?.browserTimings?.firstRenderMs === null ? markFirstRender : undefined}><MessageMarkdown message={message}/></AnswerPaint>
                : busy && index === messages.length - 1 ? <div className="thinking" aria-label="Qwen is thinking"><span/><span/><span/></div> : null}
              {diagnosticsById.has(message.id) && <RequestDiagnostics record={diagnosticsById.get(message.id)!}/>}
              {message.note && <div className={`message-note ${message.state === "error" ? "error" : ""}`} role={message.state === "error" ? "alert" : undefined}>{message.note}</div>}
              {message.role === "assistant" && !busy && <div className="message-actions">
                {message.content && <CopyButton text={message.content}/>}
                {index === messages.length - 1 && <button onClick={retry} disabled={!!busy}><RotateCcw size={14}/><span>Try again</span></button>}
                {message.state === "stopped" && <span>Stopped</span>}
              </div>}
            </div>
          </article>)}
          <div ref={bottom}/>
        </div>}
      </main>
      <div className="composer-region"><div className="composer-wrap">
        {preview && <div className="preview-note"><Sparkles size={13}/> Local preview · sample replies, no model requests</div>}
        {connection.mode === "live" && !connection.ready && <div className="offline-note">Your model may be stopped or loading. You can try again when it’s ready.</div>}
        <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
          {attachment && <div className="composer-attachment">
            <img src={attachment.dataUrl} alt="Image preview"/>
            <span title={attachment.name}>{attachment.name}</span>
            <button type="button" aria-label="Remove image" onClick={() => { removeAttachment(); textarea.current?.focus(); }}><X size={16} aria-hidden="true"/></button>
          </div>}
          <label className="sr-only" htmlFor="message">Message Qwen</label>
          <textarea ref={textarea} id="message" placeholder={docsMode ? "Ask about Runpod…" : "What’s on your mind?"} value={draft} onChange={e => setDraft(e.target.value)}
            maxLength={effectiveSettings.inputCharacters} rows={1} onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!e.repeat) void send();
              }
            }}/>
          <input ref={fileInput} type="file" aria-label="Choose image file" accept={imageInput?.mimeTypes.join(",") ?? "image/jpeg,image/png,image/webp"}
            hidden disabled={!!attachmentUnavailable || !!busy || readingImage} onChange={e => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void chooseImage(file);
            }}/>
          <div className="composer-docs">
            <label className="docs-toggle">
              <input type="checkbox" role="switch" checked={docsMode} aria-describedby="docs-mode-help"
                disabled={!!busy || (!docsMode && (!docsAvailable || !!attachment || readingImage || !!retryImageId))}
                onChange={e => setDocsMode(e.target.checked)}/>
              <span>Runpod Docs</span>
            </label>
            <span id="docs-mode-help">{docsHelp}</span>
          </div>
          <div className="composer-bottom">
            <span className="composer-model">{logo} {selectedLabel}</span>
            <div className="composer-controls">
              <span className="enter-hint">Shift + Enter for a new line</span>
              <button type="button" className="attach-image-button" aria-label="Attach image" aria-describedby="image-input-help"
                disabled={!!attachmentUnavailable || !!busy || readingImage} onClick={() => fileInput.current?.click()}>
                <ImagePlus size={17} aria-hidden="true"/>
              </button>
              {busy ? <button type="button" className="send-button stop-button" aria-label="Stop generation" onClick={() => { if (activeId) controllers.current.get(activeId)?.abort(); textarea.current?.focus(); }}><Square size={15} fill="currentColor"/></button>
                : <button className="send-button" aria-label="Send message" disabled={!draft.trim() || readingImage || activeEntry?.loaded === false || (docsMode && !docsAvailable) || (!!attachment && !!attachmentUnavailable) || (!!retryImageId && !attachment)}><ArrowUp size={20}/></button>}
            </div>
          </div>
          <div className="composer-attachment-note" id="image-input-help" aria-live="polite">
            {readingImage ? "Preparing image…" : retryImageId && !attachment ? "Reattach the original image to retry this message." : attachmentUnavailable}
            {retryImageId && !attachment && imageUnavailable && <span> {imageUnavailable}</span>}
            {retryImageId && <button type="button" onClick={clearDraft}>Cancel retry</button>}
          </div>
        </form>
        <p className="composer-footer">A helpful second perspective. Always give important details a second look.</p>
      </div></div>
    </div>
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")} aria-label="Dismiss notification"><X size={14}/></button></div>}
    {(settings || deleting) && <div className="modal-backdrop" onClick={() => { setSettings(false); setDeleting(null); }}><div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={dialog} onKeyDown={trapFocus} onClick={e => e.stopPropagation()}><button className="icon-button close-dialog" onClick={() => { setSettings(false); setDeleting(null); }} aria-label="Close dialog"><X size={20}/></button>{deleting ? <><div className="eyebrow">MAKE A LITTLE ROOM</div><h2 id="dialog-title">Delete this conversation?</h2><p>{deleting && !legacyIds.current.has(deleting) && ((cloud?.entries.get(deleting)?.revision ?? 0) > 0 || cloud?.entries.get(deleting)?.mayExistRemotely || !localStates.includes(cloud?.entries.get(deleting)?.state ?? "saved")) ? "This removes the conversation from cloud history on all your devices. It can’t be undone." : "This removes the conversation from this browser. It can’t be undone."}</p><div className="dialog-buttons"><button className="secondary-button" onClick={() => setDeleting(null)}>Keep conversation</button><button className="danger-button" onClick={deleteConversation}>Delete conversation</button></div></> : <><div className="eyebrow">MAKE YOURSELF AT HOME</div><h2 id="dialog-title">Your workspace</h2><ModelSettingsPanel connections={connections} preferences={preferences} busy={streamingChats.size > 0}
      temperature={temperature} onTemperatureChange={setTemperature}
      diagnosticsEnabled={diagnosticsEnabled} onDiagnosticsChange={(model, enabled) => setDiagnosticsEnabled(previous => ({ ...previous, [model]: enabled }))}
      onRefresh={() => { void statusRequests.current?.refresh(); }}
      onApply={(model, next) => { setPreferences(previous => ({ ...previous, [model]: next })); setToast(`${modelInfo(model).label} settings saved.`); }}/>
      {diagnosticRecords.length > 0 && <div className="diagnostic-session"><p className="settings-help">{diagnosticRecords.length} diagnostic records in this session (latest 100). Reloading or signing out clears them.</p><button type="button" className="secondary-button" onClick={() => exportDiagnostics(diagnosticRecords)}>Export session CSV</button></div>}
      <section className="history-settings" aria-label="Chat history"><h3>Chat history</h3><p className="settings-help">New chats sync across devices. Cloud history keeps up to 50 chats or 2,000,000 UTF-8 bytes of text and chat details. Chats with the oldest last message are removed when full, except the chat being saved. Older browser conversations stay local, including future replies.</p><p className="settings-help">Text and chat details only. Images aren’t included. Export a copy before deleting or reaching the limit.</p><div className="history-export-actions"><button className="secondary-button" disabled={exporting || !chats.length} onClick={() => { void downloadHistory("json", true); }}>Export JSON</button><button className="secondary-button" disabled={exporting || !chats.length} onClick={() => { void downloadHistory("md", true); }}>Export Markdown</button></div>{active && <div className="history-export-actions"><button className="secondary-button" disabled={exporting} onClick={() => { void downloadHistory("json"); }}>Export this chat as JSON</button><button className="secondary-button" disabled={exporting} onClick={() => { void downloadHistory("md"); }}>Export this chat as Markdown</button></div>}{hasPending && <p className="settings-help">A change is waiting to sync. <button className="secondary-button" onClick={() => { void cloud?.retry(); }}>Retry sync</button></p>}</section><p className="settings-footnote">In live mode, messages you send are processed by your model. Older messages may be omitted to fit its context.</p><button className="signout-button" onClick={logout}><LogOut size={16}/> Sign out</button></>}</div></div>}
  </div>;
}

function MessageMarkdown({ message }: { message: Message }) {
  const { docsSources } = message;
  return <ReactMarkdown remarkPlugins={docsSources ? [remarkGfm, [remarkDocsCitations, docsSources]] : [remarkGfm]}
    components={{
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      a: ({ children, href, node }) => {
        if (!docsSources) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        const source = docsSources.find(item => item.id === node?.properties.dataDocsCitation);
        return source ? <a className="docs-citation" href={source.url} target="_blank" rel="noopener noreferrer"
          title={source.heading} aria-label={`[${source.id}] ${source.heading}, Runpod Docs`}>{children}</a> : <>{children}</>;
      },
    }}>{message.content}</ReactMarkdown>;
}

function MessageAttachment({ name, attachment }: { name: string; attachment?: ImageAttachment }) {
  return <figure className="message-attachment">
    {attachment && <img src={attachment.dataUrl} alt="Attached image"/>}
    <figcaption><ImagePlus size={14} aria-hidden="true"/><span>{name}</span></figcaption>
  </figure>;
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
