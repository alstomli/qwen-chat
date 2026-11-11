"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, ArrowUpRight, Check, Code2, Compass, Copy, Feather, ImagePlus, LoaderCircle, LogOut, Menu, MessageSquare, PanelLeftClose, Plus, Search, Settings2, ShieldCheck, Sparkles, Square, Trash2, X, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RequestDiagnostics, exportDiagnostics } from "@/components/request-diagnostics";
import { DIAGNOSTICS_HEADER, parseDiagnosticHeader, type BrowserTimings, type DiagnosticRecord } from "@/lib/diagnostics";
import { ImageJobCard } from "@/components/image-job-card";
import { useImageJobs } from "@/lib/use-image-jobs";
import { ownsImageRequest, rememberImageRequest } from "@/lib/image-origin";
import { imagePending, type GeneratedImage } from "@/lib/generated-image";
import { AnswerPaint } from "@/components/answer-paint";
import { ModelSettingsPanel } from "@/components/model-settings-panel";
import { citationPlugin, WebSources } from "@/components/web-sources";
import { DEFAULT_SETTINGS, SETTINGS_MAX, SETTINGS_KEY, MODEL_SETTINGS_KEY, parseModelSettings, fitMessages, jsonBytes, type ModelSettings } from "@/lib/chat-settings";
import { adapterForAccess, settingsForAccess } from "@/lib/settings-access";
import { consumeCompletion } from "@/lib/protocol";
import { WEB_SEARCH_HEADER, WEB_SEARCH_UNAVAILABLE, parseWebMetadata, webSearchForProfile, type WebStatus } from "@/lib/web-search";
import { IMAGE_ACCEPTED_HEADER, IMAGE_ADAPTER_ERROR, validateImageInput } from "@/lib/image-input";
import { prepareImage, type ImageAttachment } from "@/lib/prepare-image";
import { completedHistory, parseConversations, STORAGE_KEY, type Conversation, type Message } from "@/lib/storage";
import { exportHistory, HISTORY_NOTICE_KEY, type SaveState } from "@/lib/cloud-history";
import { useCloudHistory } from "@/lib/use-cloud-history";

import { browserAuth } from "@/lib/supabase/browser";
import { accountStorageKey } from "@/lib/account-storage";
import { DEFAULT_MODEL, modelInfo, answerModelLabel, type ModelId } from "@/lib/models";
import { allModelStatusRequests, initialModelConnections, updateModelConnection } from "@/lib/model-status";
const starters = [
  { icon: Feather, label: "Find the right words", text: "Help me write a thoughtful email to reconnect with an old colleague. Keep it warm and natural.", caption: "A first draft, a fresh perspective" },
  { icon: Compass, label: "Make sense of something", text: "Explain how large language models work, using a simple everyday analogy.", caption: "Turn a big idea into a clear one" },
  { icon: Code2, label: "Build something useful", text: "Write a small Python function that reads a CSV file and summarizes its numeric columns. Explain each step.", caption: "Work through code, step by step" },
];
const uid = () => crypto.randomUUID();
const logo = <span className="qwen-symbol" aria-hidden="true">✳</span>;

export default function ChatWorkspace({ userId, email, canUseAdvancedSettings }: { userId: string; email: string; canUseAdvancedSettings: boolean }) {
  const [authenticated, setAuthenticated] = useState(true);
  const [imageMode, setImageMode] = useState(false);
  const [imageDraft, setImageDraft] = useState("");
  const imageDrafts = useRef(new Map<string | null, string>());
  const storageKey = accountStorageKey(STORAGE_KEY, userId);
  const settingsKey = accountStorageKey(SETTINGS_KEY, userId);
  const modelSettingsKey = accountStorageKey(MODEL_SETTINGS_KEY, userId);
  const [chats, setChats] = useState<Conversation[]>([]); const [loaded, setLoaded] = useState(false);
  const imageJobs = useImageJobs(userId, authenticated && canUseAdvancedSettings, chats, setChats);
  const legacyIds = useRef(new Set<string>());
  const legacySnapshot = useRef<Conversation[] | null>(null);
  const [legacyDurable, setLegacyDurable] = useState(true);
  const [historyNotice, setHistoryNotice] = useState(false);
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null); const [draft, setDraft] = useState(""); const [search, setSearch] = useState("");
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const [readingImage, setReadingImage] = useState(false);
  const [searchWeb, setSearchWeb] = useState(false);
  const [webStatuses, setWebStatuses] = useState<Record<string, WebStatus>>({});
  const [retryImageId, setRetryImageId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageRead = useRef(0);
  const sentImages = useRef(new Map<string, { chatId: string; attachment: ImageAttachment }>());
  const savedDrafts = useRef(new Map<string | null, { text: string; attachment: ImageAttachment | null; retryId: string | null }>());
  const [sidebar, setSidebar] = useState(false); const [settings, setSettings] = useState(false); const [deleting, setDeleting] = useState<string | null>(null);
  const [connections, setConnections] = useState(initialModelConnections);
  const statusRequests = useRef<ReturnType<typeof allModelStatusRequests> | null>(null);
  const [draftAdapter, setDraftAdapter] = useState(true);
  const [streamingChats, setStreamingChats] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState(""); const [preferences, setPreferences] = useState<ModelSettings>({ bf16: { ...DEFAULT_SETTINGS } }); const [temperature, setTemperature] = useState(0.7);
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState<Record<ModelId, boolean>>({ bf16: false });
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
  const selectedModel = active?.model ?? DEFAULT_MODEL;
  const connection = connections[selectedModel];
  const selectedAdapter = canUseAdvancedSettings ? active ? active.useAdapter ?? true : draftAdapter : false;
  const adapterAvailable = selectedModel === "bf16" && connection.adapterToggleAvailable === true;
  const effectiveAdapter = adapterForAccess(selectedModel, adapterAvailable ? selectedAdapter : undefined, canUseAdvancedSettings);
  const selectedLabel = answerModelLabel(selectedModel, effectiveAdapter);
  const preview = connection.mode === "preview";
  const limits = connection.limits ?? SETTINGS_MAX;
  const effectiveSettings = settingsForAccess(preferences[selectedModel], canUseAdvancedSettings, limits);
  const imageInput = selectedModel === "bf16" && connection.mode === "live" && connection.ready ? connection.imageInput : undefined;
  const imageUnavailable = !imageInput ? "Image attachments require a connected BF16 gateway with image input enabled."
    : !canUseAdvancedSettings && !adapterAvailable ? "Reconnect BF16 to a gateway that can verify base model mode before attaching an image."
    : adapterAvailable && selectedAdapter ? IMAGE_ADAPTER_ERROR : "";
  const attachmentUnavailable = searchWeb ? "Turn off Search web before attaching an image." : imageUnavailable;
  const webAvailable = webSearchForProfile(connection, selectedModel, effectiveAdapter);
  const webUnavailable = !webAvailable ? WEB_SEARCH_UNAVAILABLE : attachment ? "Remove the image to search the web." : "";

  useEffect(() => {
    if (!authenticated) return;
    try { const stored = parseConversations(localStorage.getItem(storageKey)); legacyIds.current = new Set(stored.map(chat => chat.id)); setChats(stored); setActiveId(stored[0]?.id ?? null); setDiagnosticRecords([]); setDiagnosticsEnabled({ bf16: false }); setHistoryNotice(localStorage.getItem(accountStorageKey(HISTORY_NOTICE_KEY, userId)) !== "dismissed"); }
    catch { setToast("Your browser couldn't load saved conversations."); }
    try {
      const raw = localStorage.getItem(settingsKey);
      setPreferences(canUseAdvancedSettings ? parseModelSettings(localStorage.getItem(modelSettingsKey))
        : { bf16: { ...DEFAULT_SETTINGS } });
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
    try {
      if (canUseAdvancedSettings) localStorage.setItem(modelSettingsKey, JSON.stringify(preferences));
      localStorage.setItem(settingsKey, JSON.stringify({ temperature }));
    }
    catch { setToast("Your browser couldn't save settings. They will only apply in this tab."); }
  }, [preferences, temperature, loaded, authenticated, canUseAdvancedSettings]);
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
    setDraft(""); setRetryImageId(null); setSearchWeb(false);
  }
  function removeAttachment() {
    imageRead.current++;
    setReadingImage(false); setAttachment(null);
  }
  function switchConversation(id: string | null) {
    if (readingImage) { setToast("Wait for the image to finish preparing before switching conversations."); return false; }
    if (id !== activeId) {
      imageDrafts.current.set(activeId, imageDraft); setImageDraft(imageDrafts.current.get(id) ?? "");
      if (attachment || retryImageId) savedDrafts.current.set(activeId, { text: draft, attachment, retryId: retryImageId });
      const pending = savedDrafts.current.get(id);
      savedDrafts.current.delete(id);
      setActiveId(id);
      setSearchWeb(false);
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
    setDraftAdapter(true); textarea.current?.focus();
  }
  async function chooseImage(file: File) {
    if (attachmentUnavailable || !imageInput) { setToast(attachmentUnavailable); return; }
    const version = ++imageRead.current;
    setReadingImage(true);
    try {
      const wireWithoutImageData = jsonBytes({
        model: selectedModel, useAdapter: effectiveAdapter,
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
    if (!canUseAdvancedSettings || (activeId && controllers.current.has(activeId)) || !adapterAvailable || !connection.ready) return;
    if (activeId) setChats(previous => previous.map(chat => chat.id === activeId ? { ...chat, useAdapter } : chat));
    else setDraftAdapter(useAdapter);
  }
  function updateMessage(chatId: string, messageId: string, patch: Partial<Message> | ((m: Message) => Partial<Message>)) {
    setChats(prev => prev.map(chat => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map(m => m.id === messageId ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m) }));
  }
  async function send(text = draft, retryId: string | null = retryImageId, image = attachment, searchRequested = searchWeb) {
    const submitted = performance.now();
    text = text.trim(); if (!text || (activeId && controllers.current.has(activeId))) return;
    if (activeId && cloud?.entries.get(activeId)?.loaded === false) { setToast("Load this conversation before adding a message."); return; }
    if (!connection.ready || !connection.limits) { setToast(connection.error ?? "Wait for the server limits to be verified before sending."); return; }
    if (searchRequested && (!webAvailable || image)) { setToast(image ? "Use web search and image attachments in separate messages." : WEB_SEARCH_UNAVAILABLE); return; }
    if (selectedModel === "bf16" && selectedAdapter === false && !adapterAvailable && !preview) { setToast("Adapter selection is unavailable. Reconnect or start a new conversation."); return; }
    const useAdapter = effectiveAdapter;
    if (text.length > effectiveSettings.inputCharacters) { setToast(`Please shorten your message to ${effectiveSettings.inputCharacters.toLocaleString()} characters or fewer.`); return; }
    const retryIndex = retryId ? messages.findIndex(message => message.id === retryId && message.role === "user") : -1;
    if (retryId && retryIndex < 0) { setToast("This earlier message is unavailable. Cancel the retry to start a new message."); return; }
    if (retryIndex >= 0 && messages[retryIndex].imageName && !image) { setToast("Reattach the image to retry this prompt."); return; }
    if (readingImage) { setToast("Wait for your image to finish preparing."); return; }
    if (image) {
      if (imageUnavailable || !imageInput) { setToast(imageUnavailable); return; }
      try { validateImageInput(image.dataUrl, imageInput); }
      catch (error) { setToast(error instanceof Error ? error.message : "The image attachment is invalid."); return; }
    }
    const history = retryIndex < 0 ? messages : messages.slice(0, retryIndex);
    const id = activeId ?? uid(); const responseId = uid(); const userId = uid();
    const retainedImages = retryIndex < 0 ? [] : messages.slice(retryIndex).filter(message => message.generatedImage);
    const pending: Message[] = [...history, ...retainedImages, { id: userId, role: "user", content: text, imageName: image?.name, searchRequested: searchRequested ? true : undefined }, { id: responseId, role: "assistant", content: "", model: selectedModel, useAdapter }];
    const candidates = [...completedHistory(history), { role: "user", content: text }];
    let input;
    try { input = fitMessages(candidates, effectiveSettings, temperature, selectedModel, useAdapter, image?.dataUrl); }
    catch (error) { setToast(error instanceof Error ? error.message : "Message exceeds your configured limits."); return; }
    const captureDiagnostic = canUseAdvancedSettings && diagnosticsEnabled[selectedModel] && connection.diagnosticsAvailable === true;
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
    if (searchRequested) setWebStatuses(previous => ({ ...previous, [responseId]: "planning" }));
    textarea.current?.focus();
    let responseStarted = false;
    let contentReceived = false;
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", ...(captureDiagnostic ? { [DIAGNOSTICS_HEADER]: "1" } : {}) }, body: JSON.stringify({ model: selectedModel, useAdapter, messages: input, max_tokens: effectiveSettings.outputTokens, temperature, settings: effectiveSettings, image: image?.dataUrl, ...(searchRequested ? { webSearch: { version: 1, mode: "required" } } : {}) }), signal: abort.signal });
      const gateway = captureDiagnostic ? parseDiagnosticHeader(response.headers.get(DIAGNOSTICS_HEADER)) : null;
      if (captureDiagnostic) patchDiagnostic(responseId, { gateway });
      if (!response.ok || !response.body) { if (response.status === 401) setAuthenticated(false); throw new Error((await response.json()).error ?? "Couldn't start a reply."); }
      if (searchRequested && response.headers.get(WEB_SEARCH_HEADER) !== "1") {
        await response.body.cancel().catch(() => {});
        throw new Error("The model did not confirm web search. No web-backed answer was produced.");
      }
      if (image && response.headers.get(IMAGE_ACCEPTED_HEADER) !== "true") {
        await response.body.cancel().catch(() => {});
        throw new Error("The model did not confirm receipt of the attached image. Try again when image input is available.");
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
      captureDiagnostic ? event => { if (event.requestId === gateway?.requestId) patchDiagnostic(responseId, { gatewayTimings: event.timings }); } : undefined,
      searchRequested ? event => {
        if (event.type === "web-status") setWebStatuses(previous => ({ ...previous, [responseId]: event.status }));
        updateMessage(id, responseId, m => ({ webSearch: {
          version: 1, runId: event.runId,
          outcome: event.type === "web-complete" ? event.outcome : m.webSearch?.outcome ?? "interrupted",
          sources: event.type === "web-sources" ? event.sources : m.webSearch?.sources ?? [],
        } }));
        if (event.type === "web-complete" && event.outcome === "failed") throw new Error("Web search could not finish. No web-backed answer was produced. Please retry.");
      } : undefined);
      if (captureDiagnostic) patchBrowserTiming(responseId, { completionMs: performance.now() - submitted });
      if (captureDiagnostic) patchDiagnostic(responseId, { status: "completed" });
      updateMessage(id, responseId, { state: "complete" });
    } catch (error) {
      if (searchRequested) updateMessage(id, responseId, m => ({ webSearch: m.webSearch
        ? { ...m.webSearch, outcome: abort.signal.aborted ? "stopped" : "failed" } : undefined }));
      if (captureDiagnostic) patchDiagnostic(responseId, { status: abort.signal.aborted ? "stopped" : responseStarted ? "interrupted" : "error" });
      if (abort.signal.aborted) updateMessage(id, responseId, { state: "stopped", note: "You stopped this reply." });
      else updateMessage(id, responseId, { state: "error", note: searchRequested && responseStarted
        ? "Web search was interrupted. No complete web-backed answer was produced. Please retry."
        : error instanceof Error ? error.message : "The connection was interrupted. Please retry." });
    } finally {
      setWebStatuses(previous => { const next = { ...previous }; delete next[responseId]; return next; });
      if (captureDiagnostic) patchBrowserTiming(responseId, { elapsedMs: performance.now() - submitted });
      controllers.current.delete(id);
      setStreamingChats(previous => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }
  function generateImage(prompt = imageDraft) {
    prompt = prompt.trim();
    if (!canUseAdvancedSettings || !imageJobs.available || !prompt || prompt.length > 2000) return;
    if (activeId && cloud?.entries.get(activeId)?.loaded === false) { setToast("Load this conversation first."); return; }
    if (chats.some(chat => chat.messages.some(message => message.generatedImage && ownsImageRequest(userId, message.generatedImage.requestId) && imagePending(message.generatedImage)))) { setToast("Your account already has an image in progress. Wait for it or cancel it first."); return; }
    const id = activeId ?? uid(); const messageId = uid();
    try { rememberImageRequest(userId, messageId); } catch (error) { setToast(error instanceof Error ? error.message : "Browser storage is unavailable."); return; }
    const generatedImage: GeneratedImage = { version: 1, prompt, requestId: messageId, status: "submitting" };
    setChats(current => [{ id, model: selectedModel, title: active?.title ?? prompt.slice(0, 48), updatedAt: Date.now(), messages: [...(current.find(chat => chat.id === id)?.messages ?? []), { id: messageId, role: "assistant", content: "", state: "complete", generatedImage }] }, ...current.filter(chat => chat.id !== id)]);
    setActiveId(id); setImageDraft(""); imageDrafts.current.delete(activeId); follow.current = true;
    void imageJobs.track(id, messageId, generatedImage, true);
  }
  function retry() {
    const message = messages.findLast(m => m.role === "user");
    if (!message) return;
    if (draft || attachment || readingImage || retryImageId) { setToast("Finish or clear your current draft before retrying."); return; }
    const image = sentImages.current.get(message.id)?.attachment;
    if (message.imageName && !image) {
      setDraft(message.content); setRetryImageId(message.id); textarea.current?.focus();
      return;
    }
    void send(message.content, message.id, image ?? null, message.searchRequested === true);
  }
  function deleteConversation() {
    const removed = chats.find(chat => chat.id === deleting); if (removed) imageJobs.cleanup(removed);
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
  const historyChats = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const visibleChats = historyChats.filter(chat => chat.title.toLowerCase().includes(search.toLowerCase()));
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
      <div className="sidebar-brand"><button className="wordmark" onClick={newChat} aria-label="Kiddo home">{logo}<span>kiddo<span className="brand-dot">.</span></span></button><button className="icon-button mobile-only" onClick={() => setSidebar(false)} aria-label="Close sidebar"><PanelLeftClose size={18}/></button><span className="personal-tag">PERSONAL</span></div>
      <button className="new-chat" onClick={newChat}><Plus size={17}/> New conversation <span>↗</span></button>
      <div className="search-chats"><Search size={15}/><input ref={searchInput} aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ K</kbd></div>
      <div className="history-heading">HISTORY<span>{chats.length}</span></div>
      <div className="history-list">{historyNotice && <div className="history-notice"><p>New chats sync across devices. Cloud history keeps up to 50 chats or 2 MB. When full, chats with the oldest last message are removed, except the chat being saved. Generated image files stay on the browser that created them; prompts and job details sync.</p><button onClick={dismissHistoryNotice}>Got it</button></div>}
      {visibleChats.map(historyRow)}
        {!chats.length && <div className="empty-history"><MessageSquare size={23} strokeWidth={1.3}/><p>Good conversations<br/>start with a little curiosity.</p><span>Your chats will appear here.</span></div>}{chats.length > 0 && !visibleChats.length && <p className="no-results">No conversations found.</p>}</div>
      <div className="sidebar-bottom"><div className="history-sync"><div className="private-note"><ShieldCheck size={15}/><span>Cloud history · {cloud?.usage.count ?? 0} / 50 chats</span></div><p>{cloud?.offline ? "Last known usage · " : ""}{((cloud?.usage.bytes ?? 0) / 1_000_000).toFixed(2)} MB / 2 MB <span className="sr-only">({cloud?.usage.bytes ?? 0} of 2,000,000 UTF-8 bytes)</span></p><p role="status">{saveLabel}</p>{hasPending && <button onClick={() => { void cloud?.retry(); }}>Retry sync</button>}{cloud?.offline && !hasPending && <button onClick={() => { void cloud.refresh(); }}>Retry loading history</button>}</div><button className="profile-button" onClick={() => setSettings(true)}><span className="avatar">{email[0]?.toUpperCase()}</span><span><strong>Your workspace</strong><small>{email}</small></span><Settings2 size={17}/></button></div>
    </aside>
    <div className="main-shell">
      <header className="workspace-header"><div className="workspace-heading"><button className="icon-button mobile-only" onClick={() => setSidebar(true)} aria-label="Open sidebar"><Menu size={20}/></button><span className="header-label">Personal workspace</span><span className="header-slash">/</span><span className="workspace-model">{modelInfo(DEFAULT_MODEL).label}</span></div><button className={`connection-pill ${connection.mode === "live" && connection.ready ? "online" : preview ? "preview" : "offline"}`} onClick={() => setSettings(true)}><span/>{preview ? "Local preview" : connection.mode === "checking" ? "Connecting" : connection.mode === "unconfigured" ? "Setup needed" : connection.ready ? "Model online" : "Model offline"}<ArrowUpRight size={13}/></button></header>
      {active && isLocal(active) && <div className="history-local-note" role="status">{(legacyIds.current.has(active.id) ? !legacyDurable : !cloud?.durable) ? "Browser storage is unavailable. This copy is only in this tab; export it now to keep it." : legacyIds.current.has(active.id) ? "This older conversation stays on this browser, including new replies." : activeEntry?.state === "oversized" && !cloud?.durable ? "This chat is too large for cloud history and browser storage is unavailable. Export it now to keep a copy." : activeEntry?.state === "oversized" ? "This chat is too large for cloud history. It’s saved on this browser; export it to keep a copy." : activeEntry?.state === "conflict" ? "This chat changed on another device. Your unsynced copy stays on this browser." : activeEntry?.state === "create_limited" ? "Too many recent cloud chat changes. This chat stays on this browser; try a new chat later." : "This chat stays on this browser. Export it to keep a copy."}<button disabled={exporting} onClick={() => { void downloadHistory("json"); }}>Export JSON</button><button onClick={newChat}>Start new chat</button></div>}
      {cloud?.usage.paused && <div className="history-local-note" role="status">{cloud.durable ? "Cloud saving is temporarily paused. Your conversations stay on this browser until sync resumes. You can keep chatting, export, or delete history." : "Cloud saving is paused and browser storage is unavailable. Export your conversations now to keep a copy. You can keep chatting or delete history."}</div>}
      <main className={`chat-main ${messages.length ? "has-messages" : ""}`} ref={scroller} onScroll={() => { const el = scroller.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
        {historyLoading !== null && historyLoading === activeId ? <p className="history-loading" role="status">Loading conversation…</p> : activeId && activeEntry?.loaded === false ? <div className="history-loading"><p>Load this conversation to read or continue it.</p><button className="secondary-button" onClick={() => switchConversation(activeId)}>Try loading again</button></div> : !messages.length ? <div className="welcome"><div className="welcome-mark" aria-hidden="true"><span>✳</span><i/></div><div className="eyebrow">A FRESH CONVERSATION</div><h1>A little curiosity.<br/><em>A lot of possibility.</em></h1><p>Your space to think, write, and work things out.</p><div className="starter-grid">{starters.map(card => <button className="starter-card" key={card.label} onClick={() => { setDraft(card.text); textarea.current?.focus(); }}><div><card.icon size={20} strokeWidth={1.45}/><ArrowUpRight size={16}/></div><strong>{card.label}</strong><small>{card.caption}</small></button>)}</div></div>
        : <div className="message-list">
          {messages.map((message, index) => message.generatedImage ? <ImageJobCard key={message.id} userId={userId} id={message.id} image={message.generatedImage} note={imageJobs.notes[message.id]} allowed={canUseAdvancedSettings}
            onCheck={() => { if (activeId) void imageJobs.track(activeId, message.id, message.generatedImage!, true); }}
            onCancel={() => { if (activeId) void imageJobs.cancel(activeId, message.id, message.generatedImage!); }}
            onEdit={() => { setImageMode(true); setImageDraft(message.generatedImage!.prompt); textarea.current?.focus(); }}
            onGenerate={() => generateImage(message.generatedImage!.prompt)}/> : <article className={`message ${message.role}`} key={message.id}>
            <div className="message-avatar">{message.role === "assistant" ? logo : "Z"}</div>
            <div className="message-body">
              <div className="message-author">{message.role === "user" ? "You" : answerModelLabel(message.model ?? DEFAULT_MODEL, message.useAdapter)}{message.role === "assistant" && <span>ASSISTANT</span>}</div>
              {message.role === "user" && message.searchRequested && <div className="web-search-label">Web search requested</div>}
              {webStatuses[message.id] && <p className="web-search-progress" role="status">{({ planning: "Planning web search…", searching: "Searching the web…", reading: "Reading sources…", answering: "Writing answer…" })[webStatuses[message.id]]}</p>}
              {message.role === "user" && message.imageName && <MessageAttachment name={message.imageName} attachment={sentImages.current.get(message.id)?.attachment}/>}
              {message.content ? message.role === "user" ? <p className="user-content">{message.content}</p> : <AnswerPaint messageId={message.id} onPaint={diagnosticsById.get(message.id)?.browserTimings?.firstRenderMs === null ? markFirstRender : undefined}><MessageMarkdown message={message}/></AnswerPaint>
                : busy && index === messages.length - 1 ? <div className="thinking" aria-label="Qwen is thinking"><span/><span/><span/></div> : null}
              {canUseAdvancedSettings && diagnosticsById.has(message.id) && <RequestDiagnostics record={diagnosticsById.get(message.id)!}/>}
              {message.role === "assistant" && message.webSearch && <WebSources message={message}/>}
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
        {!imageMode && preview && <div className="preview-note"><Sparkles size={13}/> Local preview · sample replies, no model requests</div>}
        {!imageMode && connection.mode === "live" && !connection.ready && <div className="offline-note">Your model may be stopped or loading. You can try again when it’s ready.</div>}
        <form className="composer" onSubmit={e => { e.preventDefault(); if (imageMode) generateImage(); else void send(); }}>
          {canUseAdvancedSettings && <div className="composer-modes" role="group" aria-label="Composer mode"><button type="button" aria-pressed={!imageMode} onClick={() => setImageMode(false)}>Chat</button><button type="button" aria-pressed={imageMode} onClick={() => setImageMode(true)}>Create image</button></div>}
          {imageMode && <div className="image-mode-info"><strong>FLUX.2 dev · 1024 × 1024 PNG</strong><p>Describe a new image. Only this prompt is used; chat history and attachments are excluded. The service creates one image at a time, with no waiting queue.</p>{!imageJobs.available && <p role="status">{imageJobs.reason} <button type="button" onClick={() => { void imageJobs.refresh(); }}>Check again</button></p>}</div>}
          {!imageMode && attachment && <div className="composer-attachment">
            <img src={attachment.dataUrl} alt="Image preview"/>
            <span title={attachment.name}>{attachment.name}</span>
            <button type="button" aria-label="Remove image" onClick={() => { removeAttachment(); textarea.current?.focus(); }}><X size={16} aria-hidden="true"/></button>
          </div>}
          <label className="sr-only" htmlFor="message">{imageMode ? "Describe your image" : "Message Kiddo"}</label>
          <textarea ref={textarea} id="message" placeholder={imageMode ? "Describe the image you want to create…" : "What’s on your mind?"} value={imageMode ? imageDraft : draft} onChange={e => imageMode ? setImageDraft(e.target.value) : setDraft(e.target.value)}
            maxLength={imageMode ? 2000 : effectiveSettings.inputCharacters} rows={1} onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!e.repeat) { if (imageMode) generateImage(); else void send(); }
              }
            }}/>
          <input ref={fileInput} type="file" aria-label="Choose image file" accept={imageInput?.mimeTypes.join(",") ?? "image/jpeg,image/png,image/webp"}
            hidden disabled={!!attachmentUnavailable || !!busy || readingImage} onChange={e => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void chooseImage(file);
            }}/>
          <div className="composer-bottom">
            <span className="composer-model">{logo} {imageMode ? "FLUX.2 dev" : selectedLabel}</span>
            <div className="composer-controls">
              <span className="enter-hint">Shift + Enter for a new line</span>
              {!imageMode && <><button type="button" className="web-search-toggle" aria-pressed={searchWeb} aria-describedby="web-search-help"
                disabled={!!busy || (!searchWeb && !!webUnavailable)} onClick={() => setSearchWeb(value => !value)}><Search size={15} aria-hidden="true"/><span>Search web</span></button>
              <button type="button" className="attach-image-button" aria-label="Attach image" aria-describedby="image-input-help"
                disabled={!!attachmentUnavailable || !!busy || readingImage} onClick={() => fileInput.current?.click()}>
                <ImagePlus size={17} aria-hidden="true"/>
              </button></>}
              {imageMode ? <button className="send-button" aria-label="Generate image" disabled={!imageDraft.trim() || !imageJobs.available || activeEntry?.loaded === false}><ImagePlus size={20}/></button> : busy ? <button type="button" className="send-button stop-button" aria-label="Stop generation" onClick={() => { if (activeId) controllers.current.get(activeId)?.abort(); textarea.current?.focus(); }}><Square size={15} fill="currentColor"/></button>
                : <button className="send-button" aria-label="Send message" disabled={!draft.trim() || readingImage || activeEntry?.loaded === false || (searchWeb && !!webUnavailable) || (!!attachment && !!attachmentUnavailable) || (!!retryImageId && !attachment)}><ArrowUp size={20}/></button>}
            </div>
          </div>
          {!imageMode && <><p className="web-search-help" id="web-search-help">{webUnavailable || (searchWeb ? "Search required for this message. Your question is sent to a web search provider." : "Search web is off. Turn it on to look up current sources.")}</p>
          <div className="composer-attachment-note" id="image-input-help" aria-live="polite">
            {readingImage ? "Preparing image…" : retryImageId && !attachment ? "Reattach the original image to retry this message." : attachmentUnavailable}
            {retryImageId && !attachment && imageUnavailable && <span> {imageUnavailable}</span>}
            {retryImageId && <button type="button" onClick={clearDraft}>Cancel retry</button>}
          </div></>}
        </form>
        <p className="composer-footer">{imageMode ? "Image files stay on this browser. Download images you want to keep. Prompt and job details sync with your chat." : "A helpful second perspective. Always give important details a second look."}</p>
      </div></div>
    </div>
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")} aria-label="Dismiss notification"><X size={14}/></button></div>}
    {(settings || deleting) && <div className="modal-backdrop" onClick={() => { setSettings(false); setDeleting(null); }}><div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={dialog} onKeyDown={trapFocus} onClick={e => e.stopPropagation()}><button className="icon-button close-dialog" onClick={() => { setSettings(false); setDeleting(null); }} aria-label="Close dialog"><X size={20}/></button>{deleting ? <><div className="eyebrow">MAKE A LITTLE ROOM</div><h2 id="dialog-title">Delete this conversation?</h2><p>{deleting && !legacyIds.current.has(deleting) && ((cloud?.entries.get(deleting)?.revision ?? 0) > 0 || cloud?.entries.get(deleting)?.mayExistRemotely || !localStates.includes(cloud?.entries.get(deleting)?.state ?? "saved")) ? "This removes the conversation from cloud history on all your devices. It can’t be undone." : "This removes the conversation from this browser. It can’t be undone."}</p><div className="dialog-buttons"><button className="secondary-button" onClick={() => setDeleting(null)}>Keep conversation</button><button className="danger-button" onClick={deleteConversation}>Delete conversation</button></div></> : <><div className="eyebrow">MAKE YOURSELF AT HOME</div><h2 id="dialog-title">Your workspace</h2><ModelSettingsPanel connections={connections} preferences={preferences} busy={streamingChats.size > 0}
      canUseAdvancedSettings={canUseAdvancedSettings} selectedAdapter={selectedAdapter} adapterBusy={busy} onAdapterChange={selectAdapter}
      temperature={temperature} onTemperatureChange={setTemperature}
      diagnosticsEnabled={diagnosticsEnabled} onDiagnosticsChange={(model, enabled) => { if (canUseAdvancedSettings) setDiagnosticsEnabled(previous => ({ ...previous, [model]: enabled })); }}
      onRefresh={() => { void statusRequests.current?.refresh(); }}
      onApply={(model, next) => { if (canUseAdvancedSettings) { setPreferences(previous => ({ ...previous, [model]: next })); setToast(`${modelInfo(model).label} settings saved.`); } }}/>
      {canUseAdvancedSettings && diagnosticRecords.length > 0 && <div className="diagnostic-session"><p className="settings-help">{diagnosticRecords.length} diagnostic records in this session (latest 100). Reloading or signing out clears them.</p><button type="button" className="secondary-button" onClick={() => exportDiagnostics(diagnosticRecords)}>Export session CSV</button></div>}
      <section className="history-settings" aria-label="Chat history"><h3>Chat history</h3><p className="settings-help">New chats sync across devices. Cloud history keeps up to 50 chats or 2,000,000 UTF-8 bytes of text and chat details. Chats with the oldest last message are removed when full, except the chat being saved. Older browser conversations stay local, including future replies.</p><p className="settings-help">Text, generated prompts and job details sync. Image files stay in the browser and aren’t included in exports. Export a copy before deleting or reaching the limit.</p><div className="history-export-actions"><button className="secondary-button" disabled={exporting || !chats.length} onClick={() => { void downloadHistory("json", true); }}>Export JSON</button><button className="secondary-button" disabled={exporting || !chats.length} onClick={() => { void downloadHistory("md", true); }}>Export Markdown</button></div>{active && <div className="history-export-actions"><button className="secondary-button" disabled={exporting} onClick={() => { void downloadHistory("json"); }}>Export this chat as JSON</button><button className="secondary-button" disabled={exporting} onClick={() => { void downloadHistory("md"); }}>Export this chat as Markdown</button></div>}{hasPending && <p className="settings-help">A change is waiting to sync. <button className="secondary-button" onClick={() => { void cloud?.retry(); }}>Retry sync</button></p>}</section><p className="settings-footnote">In live mode, messages you send are processed by your model. Older messages may be omitted to fit its context.</p><button className="signout-button" onClick={logout}><LogOut size={16}/> Sign out</button></>}</div></div>}
  </div>;
}

export function MessageMarkdown({ message }: { message: Message }) {
  const metadata = parseWebMetadata(message.webSearch);
  // Drop images before React creates an img or its automatic image preload.
  return <ReactMarkdown remarkPlugins={metadata ? [remarkGfm, citationPlugin(metadata.sources)] : [remarkGfm]} disallowedElements={["img"]}
    components={{
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      a: ({ children, href }) => {
        const marker = typeof children === "string" ? /^\[?(S[1-9][0-9]{0,2})\]?$/.exec(children)?.[1] : undefined;
        const sourceId = href?.startsWith("#web-citation-") ? href.slice(14) : marker;
        const source = metadata?.sources.find(s => sourceId ? s.sourceId === sourceId : s.url === href);
        if (metadata && !source) return <span>{children}</span>;
        return <a href={source?.url ?? href} target="_blank" rel="noopener noreferrer" className={source ? "web-citation" : undefined}
          aria-label={source ? `${source.sourceId}: ${source.title} (opens in a new tab)` : undefined}>{children}</a>;
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
