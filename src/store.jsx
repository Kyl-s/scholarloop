import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [library, setLibrary] = useState([]);
  const [memories, setMemories] = useState([]);
  const [path, setPathState] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [journals, setJournals] = useState([]);
  const [notes, setNotes] = useState([]);
  const [settings, setSettings] = useState({});
  const [stats, setStats] = useState(null);
  const [meta, setMeta] = useState(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const [lib, memoryData, pathData, draftData, journalData, noteData, settingData, statData, metaData] = await Promise.all([
      api.get("/api/library"),
      api.getMemories(),
      api.get("/api/path"),
      api.get("/api/drafts"),
      api.get("/api/journals"),
      api.getNotes().catch(() => []),
      api.get("/api/settings"),
      api.get("/api/stats"),
      api.get("/api/sources")
    ]);
    setLibrary(lib);
    setMemories(memoryData);
    setPathState(pathData);
    setDrafts(draftData);
    setJournals(journalData);
    setNotes(noteData);
    setSettings(settingData);
    setStats(statData);
    setMeta(metaData);
    setReady(true);
  }, []);

  useEffect(() => {
    refresh().catch((err) => console.error("初始化失败", err));
  }, [refresh]);

  const savePaper = useCallback(async (paper) => {
    const saved = await api.post("/api/library", paper);
    setLibrary((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)]);
    refresh();
    return saved;
  }, [refresh]);

  const updatePaper = useCallback(async (id, patch) => {
    const saved = await api.put(`/api/library/${id}`, patch);
    setLibrary((prev) => prev.map((p) => (p.id === id ? saved : p)));
    refresh();
    return saved;
  }, [refresh]);

  const removePaper = useCallback(async (id) => {
    await api.del(`/api/library/${id}`);
    setLibrary((prev) => prev.filter((p) => p.id !== id));
    refresh();
  }, [refresh]);

  const createMemory = useCallback(async (memory) => {
    const saved = await api.createMemory(memory);
    setMemories((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)]);
    return saved;
  }, []);

  const updateMemory = useCallback(async (id, patch) => {
    const saved = await api.updateMemory(id, patch);
    setMemories((prev) => prev.map((item) => (item.id === id ? saved : item)));
    return saved;
  }, []);

  const deleteMemory = useCallback(async (id) => {
    await api.deleteMemory(id);
    setMemories((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const generatePath = useCallback(async (body) => {
    const p = await api.post("/api/path/generate", body);
    setPathState(p);
    refresh();
    return p;
  }, [refresh]);

  const updatePath = useCallback(async (patch) => {
    const p = await api.put("/api/path", patch);
    setPathState(p);
    refresh();
    return p;
  }, [refresh]);

  const saveDraft = useCallback(async (draft) => {
    const saved = draft.id ? await api.put(`/api/drafts/${draft.id}`, draft) : await api.post("/api/drafts", draft);
    setDrafts((prev) => [saved, ...prev.filter((d) => d.id !== saved.id)]);
    refresh();
    return saved;
  }, [refresh]);

  const deleteDraft = useCallback(async (id) => {
    await api.del(`/api/drafts/${id}`);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    refresh();
  }, [refresh]);

  const saveJournal = useCallback(async (body) => {
    const saved = await api.post("/api/journals", body);
    refresh();
    return saved;
  }, [refresh]);

  const deleteJournal = useCallback(async (id) => {
    await api.del(`/api/journals/${id}`);
    setJournals((prev) => prev.filter((j) => j.id !== id));
    refresh();
  }, [refresh]);

  const createNote = useCallback(async (note) => {
    const saved = await api.createNote(note);
    setNotes((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)]);
    return saved;
  }, []);

  const updateNote = useCallback(async (id, patch) => {
    const saved = await api.updateNote(id, patch);
    setNotes((prev) => prev.map((item) => (item.id === id ? saved : item)));
    return saved;
  }, []);

  const deleteNote = useCallback(async (id) => {
    await api.deleteNote(id);
    setNotes((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const updateSettings = useCallback(async (patch) => {
    const s = await api.put("/api/settings", patch);
    setSettings(s);
    refresh();
    return s;
  }, [refresh]);

  const value = useMemo(
    () => ({ library, memories, path, drafts, journals, notes, settings, stats, meta, ready, refresh, savePaper, updatePaper, removePaper, createMemory, updateMemory, deleteMemory, generatePath, updatePath, saveDraft, deleteDraft, saveJournal, deleteJournal, createNote, updateNote, deleteNote, updateSettings }),
    [library, memories, path, drafts, journals, notes, settings, stats, meta, ready, refresh, savePaper, updatePaper, removePaper, createMemory, updateMemory, deleteMemory, generatePath, updatePath, saveDraft, deleteDraft, saveJournal, deleteJournal, createNote, updateNote, deleteNote, updateSettings]
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  return useContext(DataContext);
}
