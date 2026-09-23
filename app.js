const { db, $, $$, collection, getDocs } = window.MTW;
/* ============================================================
   CommitBoard — Trello-style workspace with commit history
   - MAIN cards  = projects with full commit/history timeline
   - TODO cards  = tasks in lists, draggable, committable
   - Storage     = localStorage + Firebase Firestore (collection "workstation")
   - Hosting     = any static host / GitHub Pages, no build step
   ============================================================ */

const STORAGE_KEY = 'commitboard-v1';
const WORKSTATION_COLLECTION = 'workstation';
const WORKSTATION_DOC = 'main';
// Extra Firestore helpers provided by window.MTW (set in Webflow, stubbed locally)
const { doc, setDoc } = window.MTW || {};
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const nowISO = () => new Date().toISOString();
const fmtDate = (iso) => {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
};
const fakeHash = () => Math.random().toString(16).slice(2, 9);
const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- STATE ---------------- */

let state = loadLocal() || seed();
let editingProjectId = null;
let editingTaskId = null;
let editingListId = null;
let commitTaskId = null;
let selectedColor = '#6366f1';
let searchTerm = '';
let cloudEnabled = !!(db && collection && getDocs);
let lastCloudSavedAt = null;

function seed() {
  const p1 = uid(), p2 = uid();
  const l1 = uid(), l2 = uid(), l3 = uid();
  return {
    projects: [
      {
        id: p1, title: 'FXL Website', description: 'Main marketing site — hero, pages, CMS wiring.',
        color: '#6366f1', createdAt: nowISO(),
        commits: [
          { id: uid(), hash: fakeHash(), title: 'Initial hero + navbar', message: 'Scaffolded homepage, added responsive nav.', taskTitle: 'Setup homepage', date: nowISO() },
          { id: uid(), hash: fakeHash(), title: 'Fixed mobile menu overlap', message: 'z-index + hamburger fix.', taskTitle: 'Fix navbar', date: nowISO() },
        ]
      },
      {
        id: p2, title: 'FXL Dashboard', description: 'Client dashboard app.',
        color: '#10b981', createdAt: nowISO(), commits: []
      }
    ],
    lists: [
      { id: l1, title: 'To Do' },
      { id: l2, title: 'In Progress' },
      { id: l3, title: 'Done' },
    ],
    tasks: [
      { id: uid(), listId: l1, title: 'I have to do this — rewrite footer', description: 'Update links + copyright', projectId: p1, committed: false, createdAt: nowISO() },
      { id: uid(), listId: l1, title: 'I have to do that — optimize images', description: 'Compress hero images', projectId: p1, committed: false, createdAt: nowISO() },
      { id: uid(), listId: l2, title: 'Add contact form', description: 'Wire to API', projectId: p1, committed: false, createdAt: nowISO() },
    ]
  };
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { console.warn('localStorage save failed', e); }
}
// Keep old name working (anything still calling load() gets local copy)
function load() { return loadLocal(); }

function save() {
  saveLocal();
  scheduleCloudSave();
}

/* ---------------- FIREBASE — collection "workstation" ----------------
   Reads:  getDocs(collection(db, "workstation"))
   Writes: setDoc(doc(db, "workstation", "main"), state)
--------------------------------------------------------------------- */

function setSyncStatus(mode, text) {
  const pill = $('#syncStatus');
  if (!pill) return;
  pill.classList.remove('cloud', 'syncing', 'error');
  if (mode) pill.classList.add(mode);
  pill.textContent = text;
}

function refreshSyncPill() {
  if (!cloudEnabled || !db) {
    setSyncStatus('', '○ local');
  } else if (lastCloudSavedAt) {
    setSyncStatus('cloud', '☁ synced ' + fmtDate(lastCloudSavedAt));
  } else {
    setSyncStatus('cloud', '☁ cloud on');
  }
}

// GET — pull the whole workspace from collection "workstation"
async function loadFromCloud() {
  if (!cloudEnabled) return null;
  setSyncStatus('syncing', '☁ syncing…');
  try {
    const snap = await getDocs(collection(db, WORKSTATION_COLLECTION));
    let mainData = null;
    snap.forEach((d) => {
      if (d.id === WORKSTATION_DOC) mainData = { id: d.id, ...d.data() };
    });
    // Fallback: if only one doc exists and it isn't "main", use it
    if (!mainData && !snap.empty && snap.docs && snap.docs.length) {
      const first = snap.docs[0];
      mainData = { id: first.id, ...first.data() };
    }
    if (mainData && mainData.projects && mainData.lists && mainData.tasks) {
      lastCloudSavedAt = mainData.updatedAt || null;
      refreshSyncPill();
      return mainData;
    }
    refreshSyncPill();
    return null;
  } catch (e) {
    console.warn('[cloud] load failed:', e);
    setSyncStatus('error', '☁ offline');
    return null;
  }
}

// SEND — push the whole workspace to collection "workstation" / doc "main"
async function pushToCloud() {
  if (!cloudEnabled || typeof doc !== 'function' || typeof setDoc !== 'function') return false;
  setSyncStatus('syncing', '☁ saving…');
  try {
    const payload = {
      projects: state.projects,
      lists: state.lists,
      tasks: state.tasks,
      updatedAt: nowISO()
    };
    await setDoc(doc(db, WORKSTATION_COLLECTION, WORKSTATION_DOC), payload);
    lastCloudSavedAt = payload.updatedAt;
    saveLocal(); // keep local copy in step
    refreshSyncPill();
    return true;
  } catch (e) {
    console.warn('[cloud] save failed:', e);
    setSyncStatus('error', '☁ save failed');
    return false;
  }
}

// Debounced auto-push so every drag/commit doesn't spam Firestore
let _saveTimer = null;
function scheduleCloudSave() {
  refreshSyncPill();
  if (!cloudEnabled) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { pushToCloud(); }, 800);
}

// On boot: render local instantly, then reconcile with cloud (newest wins)
async function initCloudSync() {
  refreshSyncPill();
  if (!cloudEnabled) return;
  const cloud = await loadFromCloud();
  if (!cloud) {
    // Nothing in cloud yet → push local state up once
    if (state && (state.projects.length || state.tasks.length)) {
      await pushToCloud();
    }
    return;
  }
  const localRaw = localStorage.getItem(STORAGE_KEY);
  const cloudTime = cloud.updatedAt ? new Date(cloud.updatedAt).getTime() : 0;
  let localTime = 0;
  try {
    const l = localRaw ? JSON.parse(localRaw) : null;
    localTime = l && l.updatedAt ? new Date(l.updatedAt).getTime() : 0;
  } catch {}
  if (cloudTime >= localTime) {
    state = {
      projects: cloud.projects || [],
      lists: cloud.lists || [],
      tasks: cloud.tasks || [],
      updatedAt: cloud.updatedAt
    };
    saveLocal();
    render();
    toast('☁ Loaded workspace from Firebase');
  } else {
    await pushToCloud();
  }
  refreshSyncPill();
}

/* ---------------- TOAST + MODALS ---------------- */

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function openModal(id) {
  // $ is querySelector-only (window.MTW), so normalize bare ids: 'x' -> '#x'
  const sel = typeof id === 'string' ? (id.startsWith('#') ? id : '#' + id) : id;
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.classList.add('open');
}
function closeModal(el) { el.classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('[data-close]')) closeModal(ov);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(closeModal);
});

/* ---------------- HELPERS ---------------- */

const getProject = (id) => state.projects.find((p) => p.id === id);
const getList = (id) => state.lists.find((l) => l.id === id);
const doneListId = () => {
  const found = state.lists.find((l) => l.title.toLowerCase() === 'done');
  return found ? found.id : state.lists[state.lists.length - 1]?.id;
};

function filteredTasks(listId) {
  let tasks = state.tasks.filter((t) => t.listId === listId);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    tasks = tasks.filter((t) =>
      t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
    );
  }
  return tasks;
}
function filteredProjects() {
  if (!searchTerm) return state.projects;
  const q = searchTerm.toLowerCase();
  return state.projects.filter((p) =>
    p.title.toLowerCase().includes(q) ||
    (p.description || '').toLowerCase().includes(q) ||
    p.commits.some((c) => c.title.toLowerCase().includes(q))
  );
}

/* ---------------- RENDER ---------------- */

function render() {
  renderStats();
  renderProjects();
  renderBoard();
  save();
}

function renderStats() {
  const totalCommits = state.projects.reduce((n, p) => n + p.commits.length, 0);
  const openTasks = state.tasks.filter((t) => !t.committed).length;
  $('#statsBar').innerHTML = `
    <div class="stat"><b>${state.projects.length}</b><span>📦 Main cards</span></div>
    <div class="stat"><b>${state.tasks.length}</b><span>🗂️ Todo cards (${openTasks} open)</span></div>
    <div class="stat"><b>${totalCommits}</b><span>✔ Total commits</span></div>
    <div class="stat"><b>${state.lists.length}</b><span>📋 Lists</span></div>
  `;
}

function renderProjects() {
  const grid = $('#projectsGrid');
  const projects = filteredProjects();
  if (!projects.length) {
    grid.innerHTML = `<div class="empty-box">No Main cards yet.<br/>Click <b>+ Main Card</b> to create one like <b>FXL Website</b>.</div>`;
    return;
  }
  grid.innerHTML = projects.map((p) => {
    const last = p.commits[p.commits.length - 1];
    return `
    <div class="project-card">
      <div class="project-top" style="background:${escapeHtml(p.color)}"></div>
      <div class="project-body">
        <h3>${escapeHtml(p.title)}</h3>
        <p class="desc">${escapeHtml(p.description || 'No description')}</p>
        <div class="commit-meta">
          <span class="commit-count">${p.commits.length} commits</span>
          <span class="last-commit">${last ? '● ' + escapeHtml(last.title) : '○ no commits yet'}</span>
        </div>
        <div class="project-actions">
          <button class="btn btn-small btn-secondary" onclick="openHistory('${p.id}')">📜 History</button>
          <button class="btn btn-small btn-accent" onclick="quickCommit('${p.id}')">+ Commit</button>
          <button class="btn btn-small btn-ghost" onclick="editProject('${p.id}')">Edit</button>
          <button class="btn btn-small btn-danger" onclick="deleteProject('${p.id}')">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderBoard() {
  const board = $('#board');
  if (!state.lists.length) {
    board.innerHTML = `<div class="empty-box">No lists. Click <b>+ List</b>.</div>`;
    return;
  }
  board.innerHTML = state.lists.map((list) => {
    const tasks = filteredTasks(list.id);
    const cards = tasks.map((t) => {
      const proj = getProject(t.projectId);
      return `
      <div class="task" draggable="true" data-task="${t.id}">
        <h4>${escapeHtml(t.title)} ${t.committed ? '<span class="badge committed">✔ committed</span>' : ''}</h4>
        ${t.description ? `<p>${escapeHtml(t.description)}</p>` : ''}
        <div class="task-badges">
          ${proj ? `<span class="badge"><span class="linked-dot" style="background:${escapeHtml(proj.color)}"></span>${escapeHtml(proj.title)}</span>` : '<span class="badge">no main card</span>'}
          <span class="badge">🕒 ${fmtDate(t.createdAt)}</span>
        </div>
        <div class="task-footer">
          <button class="btn btn-small btn-accent" onclick="openCommit('${t.id}')">✔ Commit</button>
          <button class="btn btn-small btn-ghost" onclick="editTask('${t.id}')">Edit</button>
          <button class="btn btn-small btn-danger" onclick="deleteTask('${t.id}')">✕</button>
        </div>
      </div>`;
    }).join('');

    return `
    <div class="list" data-list="${list.id}">
      <div class="list-head">
        <h3>${escapeHtml(list.title)}<span>${tasks.length}</span></h3>
        <div class="list-menu">
          <button class="icon-btn" onclick="editList('${list.id}')" title="Rename">✏️</button>
          <button class="icon-btn" onclick="deleteList('${list.id}')" title="Delete">🗑️</button>
        </div>
      </div>
      <div class="task-slot">${cards || '<p class="muted" style="padding:4px">Drop cards here…</p>'}</div>
      <button class="add-card-btn" onclick="openTaskModal('${list.id}')">+ Add todo card</button>
    </div>`;
  }).join('');

  attachDrag();
}

/* ---------------- DRAG & DROP ---------------- */

function attachDrag() {
  const tasks = document.querySelectorAll('.task');
  const lists = document.querySelectorAll('.list');

  tasks.forEach((el) => {
    el.addEventListener('dragstart', () => {
      el.classList.add('dragging');
      el._taskId = el.dataset.task;
      document._dragTask = el.dataset.task;
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });

  lists.forEach((zone) => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const taskId = document._dragTask;
      if (!taskId) return;
      const task = state.tasks.find((t) => t.id === taskId);
      if (task && task.listId !== zone.dataset.list) {
        task.listId = zone.dataset.list;
        render();
        toast(`Moved "${task.title.slice(0, 30)}" → ${getList(task.listId)?.title}`);
      }
    });
  });
}

/* ---------------- PROJECT CRUD ---------------- */

function openProjectModal() {
  editingProjectId = null;
  $('#projectModalTitle').textContent = 'New Main Card';
  $('#projectTitle').value = '';
  $('#projectDesc').value = '';
  selectedColor = '#6366f1';
  syncColors();
  openModal('projectModal');
}

function editProject(id) {
  const p = getProject(id);
  if (!p) return;
  editingProjectId = id;
  $('#projectModalTitle').textContent = 'Edit Main Card';
  $('#projectTitle').value = p.title;
  $('#projectDesc').value = p.description || '';
  selectedColor = p.color || '#6366f1';
  syncColors();
  openModal('projectModal');
}

function syncColors() {
  document.querySelectorAll('#projectColors button').forEach((b) => {
    b.classList.toggle('selected', b.dataset.color === selectedColor);
  });
}
document.querySelectorAll('#projectColors button').forEach((b) => {
  b.addEventListener('click', (e) => { e.preventDefault(); selectedColor = b.dataset.color; syncColors(); });
});

function saveProject() {
  const title = $('#projectTitle').value.trim();
  if (!title) return toast('Give the Main card a title (e.g. FXL Website)');
  if (editingProjectId) {
    const p = getProject(editingProjectId);
    p.title = title;
    p.description = $('#projectDesc').value.trim();
    p.color = selectedColor;
    toast('Main card updated');
  } else {
    state.projects.push({
      id: uid(), title,
      description: $('#projectDesc').value.trim(),
      color: selectedColor, createdAt: nowISO(), commits: []
    });
    toast(`Main card "${title}" created 📦`);
  }
  closeModal($('#projectModal'));
  render();
}

function deleteProject(id) {
  const p = getProject(id);
  if (!p) return;
  if (!confirm(`Delete Main card "${p.title}" + its ${p.commits.length} commits? Todo cards linked to it will be unlinked.`)) return;
  state.projects = state.projects.filter((x) => x.id !== id);
  state.tasks.forEach((t) => { if (t.projectId === id) t.projectId = null; });
  render();
  toast('Main card deleted');
}

/* ---------------- LIST CRUD ---------------- */

function openListModal() {
  editingListId = null;
  $('#listModalTitle').textContent = 'New List';
  $('#listTitle').value = '';
  openModal('listModal');
}
function editList(id) {
  editingListId = id;
  $('#listModalTitle').textContent = 'Rename List';
  $('#listTitle').value = getList(id)?.title || '';
  openModal('listModal');
}
function saveList() {
  const title = $('#listTitle').value.trim();
  if (!title) return toast('List needs a name');
  if (editingListId) {
    getList(editingListId).title = title;
    toast('List renamed');
  } else {
    state.lists.push({ id: uid(), title });
    toast(`List "${title}" added`);
  }
  closeModal($('#listModal'));
  render();
}
function deleteList(id) {
  if (state.lists.length <= 1) return toast('Keep at least one list');
  if (!confirm('Delete this list? Its cards will move to the first list.')) return;
  const fallback = state.lists.find((l) => l.id !== id).id;
  state.tasks.forEach((t) => { if (t.listId === id) t.listId = fallback; });
  state.lists = state.lists.filter((l) => l.id !== id);
  render();
}

/* ---------------- TASK CRUD ---------------- */

function fillTaskSelects(activeListId, activeProjectId) {
  $('#taskList').innerHTML = state.lists.map((l) =>
    `<option value="${l.id}" ${l.id === activeListId ? 'selected' : ''}>${escapeHtml(l.title)}</option>`).join('');
  $('#taskProject').innerHTML = `<option value="">— No Main card —</option>` + state.projects.map((p) =>
    `<option value="${p.id}" ${p.id === activeProjectId ? 'selected' : ''}>${escapeHtml(p.title)}</option>`).join('');
}

function openTaskModal(listId) {
  editingTaskId = null;
  $('#taskModalTitle').textContent = 'New Todo Card';
  $('#taskTitle').value = '';
  $('#taskDesc').value = '';
  fillTaskSelects(listId || state.lists[0]?.id, state.projects[0]?.id);
  openModal('taskModal');
}

function editTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  editingTaskId = id;
  $('#taskModalTitle').textContent = 'Edit Todo Card';
  $('#taskTitle').value = t.title;
  $('#taskDesc').value = t.description || '';
  fillTaskSelects(t.listId, t.projectId);
  openModal('taskModal');
}

function saveTask() {
  const title = $('#taskTitle').value.trim();
  if (!title) return toast('Todo card needs a title');
  const data = {
    title,
    description: $('#taskDesc').value.trim(),
    listId: $('#taskList').value,
    projectId: $('#taskProject').value || null,
  };
  if (editingTaskId) {
    Object.assign(state.tasks.find((t) => t.id === editingTaskId), data);
    toast('Todo card updated');
  } else {
    state.tasks.push({ id: uid(), committed: false, createdAt: nowISO(), ...data });
    toast('Todo card added 🗂️');
  }
  closeModal($('#taskModal'));
  render();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
  render();
  toast('Todo card deleted');
}

/* ---------------- COMMITS ---------------- */

function openCommit(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  if (!state.projects.length) return toast('Create a Main card first!');
  commitTaskId = taskId;
  $('#commitTaskName').textContent = `Task: "${t.title}"`;
  $('#commitProject').innerHTML = state.projects.map((p) =>
    `<option value="${p.id}" ${p.id === (t.projectId || state.projects[0].id) ? 'selected' : ''}>${escapeHtml(p.title)}</option>`).join('');
  $('#commitTitle').value = t.title;
  $('#commitMessage').value = t.description || '';
  openModal('commitModal');
  setTimeout(() => $('#commitTitle').focus(), 50);
}

// "Quick commit" from a project card — manual entry not tied to a task
function quickCommit(projectId) {
  if (!state.tasks.length) {
    // still allow a manual commit
    const title = prompt('Commit title — what changed?');
    if (!title) return;
    pushCommit(projectId, { title, message: '', taskTitle: 'manual commit' });
    render();
    return;
  }
  // default: pick most recent open task linked to this project, or first open task
  const cand = state.tasks.find((t) => t.projectId === projectId && !t.committed)
    || state.tasks.find((t) => !t.committed)
    || state.tasks[0];
  openCommit(cand.id);
  // pre-select the project the button was pressed on
  setTimeout(() => { $('#commitProject').value = projectId; }, 50);
}

function pushCommit(projectId, { title, message, taskTitle, taskId }) {
  const p = getProject(projectId);
  if (!p) return;
  p.commits.push({
    id: uid(), hash: fakeHash(),
    title: title.trim(), message: (message || '').trim(),
    taskTitle: taskTitle || '', taskId: taskId || null,
    date: nowISO()
  });
}

function saveCommit() {
  const t = state.tasks.find((x) => x.id === commitTaskId);
  const projectId = $('#commitProject').value;
  const title = $('#commitTitle').value.trim();
  if (!projectId) return toast('Pick a Main card to commit to');
  if (!title) return toast('Write a commit title — what changed?');
  pushCommit(projectId, {
    title,
    message: $('#commitMessage').value,
    taskTitle: t?.title || 'manual',
    taskId: t?.id || null
  });
  if (t) {
    t.projectId = projectId;
    t.committed = true;
    if ($('#commitAndMove').checked) {
      const done = doneListId();
      if (done) t.listId = done;
    }
  }
  closeModal($('#commitModal'));
  render();
  const pname = getProject(projectId)?.title;
  toast(`✔ Committed to "${pname}"`);
}

function openHistory(projectId) {
  const p = getProject(projectId);
  if (!p) return;
  $('#historyTitle').textContent = `📜 ${p.title} — commit history`;
  $('#historySub').textContent = `${p.commits.length} commit(s) • created ${fmtDate(p.createdAt)}`;
  const list = $('#historyList');
  if (!p.commits.length) {
    list.innerHTML = `<div class="empty-box">No commits yet. Finish a TODO and press <b>✔ Commit</b>, choosing <b>${escapeHtml(p.title)}</b>.</div>`;
  } else {
    list.innerHTML = [...p.commits].reverse().map((c) => `
      <div class="commit-item" style="border-left-color:${escapeHtml(p.color)}">
        <h4>${escapeHtml(c.title)} <span class="commit-hash">#${c.hash}</span></h4>
        <div class="meta">🕒 ${fmtDate(c.date)}${c.taskTitle ? ` • from task: “${escapeHtml(c.taskTitle)}”` : ''}</div>
        ${c.message ? `<p>${escapeHtml(c.message)}</p>` : ''}
      </div>`).join('');
  }
  openModal('historyModal');
}

/* ---------------- SEARCH / EXPORT / IMPORT ---------------- */

$('#searchInput').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim();
  renderProjects();
  renderBoard();
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'commitboard-backup.json';
  a.click();
  toast('Backup exported ⬇');
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!data.projects || !data.tasks || !data.lists) throw new Error('bad file');
      state = data;
      render();
      scheduleCloudSave();
      toast('Backup imported ⬆');
    } catch { toast('Invalid backup file'); }
  };
  r.readAsText(f);
  e.target.value = '';
});

/* ---------------- WIRING ---------------- */

$('#newProjectBtn').addEventListener('click', openProjectModal);
$('#addProjectBtn2').addEventListener('click', openProjectModal);
$('#newTaskBtn').addEventListener('click', () => openTaskModal());
$('#addListBtn').addEventListener('click', openListModal);
$('#saveProjectBtn').addEventListener('click', saveProject);
$('#saveTaskBtn').addEventListener('click', saveTask);
$('#saveListBtn').addEventListener('click', saveList);
$('#saveCommitBtn').addEventListener('click', saveCommit);
const _cloudBtn = $('#cloudSyncBtn');
if (_cloudBtn) _cloudBtn.addEventListener('click', async () => {
  if (!cloudEnabled) {
    toast('Firebase not configured — running on localStorage');
    return;
  }
  toast('☁ Syncing with Firebase…');
  const ok = await pushToCloud();
  if (ok) {
    const cloud = await loadFromCloud();
    if (cloud && cloud.updatedAt) {
      state = {
        projects: cloud.projects || [],
        lists: cloud.lists || [],
        tasks: cloud.tasks || [],
        updatedAt: cloud.updatedAt
      };
      saveLocal();
      render();
    }
    toast('☁ Synced with Firebase ✔');
  }
});

// expose for inline onclick handlers
window.editProject = editProject;
window.deleteProject = deleteProject;
window.openHistory = openHistory;
window.quickCommit = quickCommit;
window.editTask = editTask;
window.deleteTask = deleteTask;
window.openCommit = openCommit;
window.openTaskModal = openTaskModal;
window.editList = editList;
window.deleteList = deleteList;

/* ---------------- INIT ---------------- */
render();
refreshSyncPill();
initCloudSync();
