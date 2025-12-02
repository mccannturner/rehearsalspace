console.log("Band Workspace script loaded");

const STORAGE_KEY = "rehearsalSpaceBandWorkspace";

function loadWorkspace() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        bandName: "",
        recordings: [], // { roomId, bpm, label, timestamp }
        ideas: []       // { id, title, body, timestamp }
      };
    }
    const data = JSON.parse(raw);
    if (!data.recordings) data.recordings = [];
    if (!data.ideas) data.ideas = [];
    if (typeof data.bandName !== "string") data.bandName = "";
    return data;
  } catch (e) {
    console.warn("Failed to load Band Workspace from localStorage", e);
    return {
      bandName: "",
      recordings: [],
      ideas: []
    };
  }
}

function saveWorkspace(workspace) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  } catch (e) {
    console.warn("Failed to save Band Workspace to localStorage", e);
  }
}

const bandNameInput = document.getElementById("band-name-input");
const sessionsList = document.getElementById("sessions-list");
const recordingsList = document.getElementById("recordings-list");
const ideasList = document.getElementById("ideas-list");
const addIdeaBtn = document.getElementById("add-idea-btn");
const ideaTitleInput = document.getElementById("idea-title-input");
const ideaNotesInput = document.getElementById("idea-notes-input");

let workspace = loadWorkspace();

function formatDateTime(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function renderBandName() {
  if (!bandNameInput) return;
  bandNameInput.value = workspace.bandName || "";
}

function renderSessions() {
  if (!sessionsList) return;
  sessionsList.innerHTML = "";

  if (!workspace.recordings.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = "No sessions yet. Record in the app and they’ll show up here.";
    sessionsList.appendChild(empty);
    return;
  }

  // Group recordings by roomId
  const sessionsMap = new Map();
  workspace.recordings.forEach((rec) => {
    if (!rec.roomId) return;
    if (!sessionsMap.has(rec.roomId)) {
      sessionsMap.set(rec.roomId, []);
    }
    sessionsMap.get(rec.roomId).push(rec);
  });

  Array.from(sessionsMap.entries()).forEach(([roomId, recs]) => {
    // Sort by timestamp descending
    recs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const latest = recs[0];
    const div = document.createElement("div");
    div.className = "session-item";

    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = roomId;

    const meta = document.createElement("div");
    meta.className = "session-meta";
    const count = recs.length;
    const bpm = latest.bpm ? `${latest.bpm} BPM` : "Unknown tempo";
    meta.textContent = `${count} recording${count > 1 ? "s" : ""} · ${bpm} · Last activity ${formatDateTime(latest.timestamp)}`;

    div.appendChild(title);
    div.appendChild(meta);
    sessionsList.appendChild(div);
  });
}

function renderRecordings() {
  if (!recordingsList) return;
  recordingsList.innerHTML = "";

  if (!workspace.recordings.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = "Your recordings will show up here after you record in the app.";
    recordingsList.appendChild(empty);
    return;
  }

  // Sort by newest first
  const recs = [...workspace.recordings].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  recs.forEach((rec) => {
    const div = document.createElement("div");
    div.className = "recording-item";

    const title = document.createElement("div");
    title.className = "recording-title";
    const label = rec.label && rec.label.trim() ? ` – ${rec.label}` : "";
    const roomText = rec.roomId ? `${rec.roomId}` : "Untitled room";
    title.textContent = `${roomText} – ${rec.bpm || "?"} BPM${label}`;

    const meta = document.createElement("div");
    meta.className = "recording-meta";
    meta.textContent = `Recorded ${formatDateTime(rec.timestamp)}`;

    div.appendChild(title);
    div.appendChild(meta);

    if (rec.audioDataUrl) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = rec.audioDataUrl;
      audio.style.display = "block";
      audio.style.marginTop = "4px";
      div.appendChild(audio);
    }

    recordingsList.appendChild(div);
  });
}

function renderIdeas() {
  if (!ideasList) return;
  ideasList.innerHTML = "";

  if (!workspace.ideas.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = "No ideas saved yet. Jot something down above.";
    ideasList.appendChild(empty);
    return;
  }

  const ideas = [...workspace.ideas].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  ideas.forEach((idea) => {
    const div = document.createElement("div");
    div.className = "idea-item";

    const title = document.createElement("div");
    title.className = "idea-title";
    title.textContent = idea.title || "Untitled idea";

    const body = document.createElement("div");
    body.className = "idea-body";
    body.textContent = idea.body || "";

    const meta = document.createElement("div");
    meta.className = "idea-meta";
    meta.textContent = `Saved ${formatDateTime(idea.timestamp)}`;

    div.appendChild(title);
    if (idea.body) div.appendChild(body);
    div.appendChild(meta);
    ideasList.appendChild(div);
  });
}

function renderAll() {
  renderBandName();
  renderSessions();
  renderRecordings();
  renderIdeas();
}

if (bandNameInput) {
  bandNameInput.addEventListener("input", () => {
    workspace.bandName = bandNameInput.value;
    saveWorkspace(workspace);
  });
}

if (addIdeaBtn) {
  addIdeaBtn.addEventListener("click", () => {
    const title = (ideaTitleInput && ideaTitleInput.value.trim()) || "";
    const body = (ideaNotesInput && ideaNotesInput.value.trim()) || "";
    if (!title && !body) {
      alert("Add a title or some notes before saving.");
      return;
    }
    const idea = {
      id: "idea-" + Date.now().toString(36),
      title,
      body,
      timestamp: Date.now()
    };
    workspace.ideas.push(idea);
    saveWorkspace(workspace);
    if (ideaTitleInput) ideaTitleInput.value = "";
    if (ideaNotesInput) ideaNotesInput.value = "";
    renderIdeas();
  });
}

// Initial render
renderAll();
