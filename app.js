const { db, $, $$, collection, getDocs } = window.MTW;
/* ============================================================
   CommitBoard — Trello-style workspace with commit history
   - MAIN cards  = projects with full commit/history timeline
   - TODO cards  = tasks in lists, draggable, committable
   - Committing a todo archives it (removed from the board)
   - Storage     = localStorage + Firebase Firestore (collection "workstation")
   ============================================================ */

const STORAGE_KEY = 'commitboard-v1';
const SETTINGS_KEY = 'commitboard-settings';
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

/* ---------------- SVG ICONS (stroke = currentColor) ---------------- */
const svgWrap = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const I = {
  plus: svgWrap('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  check: svgWrap('<polyline points="20 6 9 17 4 12"/>'),
  x: svgWrap('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  edit: svgWrap('<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>'),
  trash: svgWrap('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  clock: svgWrap('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 13.5"/>'),
  history: svgWrap('<polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>'),
};

/* ---------------- STATE ---------------- */

let state = loadLocal() || seed();
let settings = loadSettings();
let editingProjectId = null;
let editingTaskId = null;
let editingListId = null;
let commitTaskId = null;
let selectedColor = '#6366f1';
let searchTerm = '';
let cloudEnabled = !!(db && collection && getDocs);
let lastCloudSavedAt = null;
let confirmCallback = null;

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
        color: '#14b8a6', createdAt: nowISO(), commits: []
      }
    ],
    lists: [
      { id: l1, title: 'To Do' },
      { id: l2, title: 'In Progress' },
      { id: l3, title: 'Done' },
    ],
    tasks: [
      { id: uid(), listId: l1, title: 'Rewrite footer', description: 'Update links + copyright', projectId: p1, createdAt: nowISO() },
      { id: uid(), listId: l1, title: 'Optimize images', description: 'Compress hero images', projectId: p1, createdAt: nowISO() },
      { id: uid(), listId: l2, title: 'Add contact form', description: 'Wire to API', projectId: p1, createdAt: nowISO() },
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
function load() { return loadLocal(); }

function save() {
  saveLocal();
  scheduleCloudSave();
}

function loadSettings() {
  try {
    return Object.assign(
      { theme: 'midnight', accent: '#6366f1', custom: {} },
      JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    );
  } catch {
    return { theme: 'midnight', accent: '#6366f1', custom: {} };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) { console.warn('settings save failed', e); }
}
function applySettings() {
  document.documentElement.dataset.theme = settings.theme || 'midnight';
  document.documentElement.style.setProperty('--accent', settings.accent || '#6366f1');
  // Custom overrides win over the preset (cleared when not set)
  const customs = settings.custom || {};
  THEME_VARS.forEach(([key]) => {
    if (customs[key]) document.documentElement.style.setProperty(key, customs[key]);
    else document.documentElement.style.removeProperty(key);
  });
  document.querySelectorAll('#themeOptions button').forEach((b) => {
    b.classList.toggle('selected', b.dataset.themeOpt === settings.theme);
  });
  document.querySelectorAll('#accentOptions button').forEach((b) => {
    b.classList.toggle('selected', b.dataset.accent === settings.accent);
  });
  refreshThemeEditor();
}

/* ---- Custom theme editor: every page color, pick your own ---- */
const THEME_VARS = [
  ['--bg', 'Background'],
  ['--bg2', 'Background alt'],
  ['--panel', 'Panels'],
  ['--card', 'Cards'],
  ['--card2', 'Cards alt'],
  ['--input', 'Inputs'],
  ['--border', 'Borders'],
  ['--text', 'Text'],
  ['--muted', 'Muted text'],
  ['--topbar', 'Top bar'],
  ['--accent', 'Accent'],
  ['--success', 'Success'],
  ['--danger', 'Danger'],
  ['--warn', 'Warning'],
];

function toHex(v) {
  v = String(v || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) return '#888888';
  const parts = m[1].split(',').slice(0, 3).map((x) => {
    x = x.trim();
    if (x.endsWith('%')) return Math.round((parseFloat(x) / 100) * 255);
    return parseInt(x, 10);
  });
  if (parts.some((n) => Number.isNaN(n))) return '#888888';
  return '#' + parts.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
}
const effectiveVar = (key) =>
  toHex(getComputedStyle(document.documentElement).getPropertyValue(key));

function buildThemeEditor() {
  const wrap = $('#customColors');
  if (!wrap || wrap.dataset.built) return;
  wrap.dataset.built = '1';
  wrap.innerHTML = THEME_VARS.map(([key, label]) => `
    <div class="theme-row">
      <span>${label}</span>
      <code data-hex="${key}"></code>
      <input type="color" data-var="${key}" value="#888888" aria-label="${label} color" />
    </div>`).join('');
  wrap.querySelectorAll('input[type="color"]').forEach((inp) => {
    inp.addEventListener('input', () => {
      settings.custom = settings.custom || {};
      settings.custom[inp.dataset.var] = inp.value;
      if (inp.dataset.var === '--accent') settings.accent = inp.value;
      document.documentElement.style.setProperty(inp.dataset.var, inp.value);
      const code = wrap.querySelector(`code[data-hex="${inp.dataset.var}"]`);
      if (code) code.textContent = inp.value;
      saveSettings();
      applySettings();
    });
  });
  refreshThemeEditor();
}

function refreshThemeEditor() {
  const wrap = $('#customColors');
  if (!wrap || !wrap.dataset.built) return;
  wrap.querySelectorAll('input[type="color"]').forEach((inp) => {
    const hex = effectiveVar(inp.dataset.var);
    inp.value = hex;
    const code = wrap.querySelector(`code[data-hex="${inp.dataset.var}"]`);
    if (code) code.textContent = hex;
  });
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
    setSyncStatus('', 'Local mode');
  } else if (lastCloudSavedAt) {
    setSyncStatus('cloud', 'Synced ' + fmtDate(lastCloudSavedAt));
  } else {
    setSyncStatus('cloud', 'Cloud connected');
  }
}

// GET — pull the whole workspace from collection "workstation"
async function loadFromCloud() {
  if (!cloudEnabled) return null;
  setSyncStatus('syncing', 'Syncing...');
  try {
    const snap = await getDocs(collection(db, WORKSTATION_COLLECTION));
    let mainData = null;
    snap.forEach((d) => {
      if (d.id === WORKSTATION_DOC) mainData = { id: d.id, ...d.data() };
    });
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
    setSyncStatus('error', 'Offline');
    return null;
  }
}

// SEND — push the whole workspace to collection "workstation" / doc "main"
async function pushToCloud() {
  if (!cloudEnabled || typeof doc !== 'function' || typeof setDoc !== 'function') return false;
  setSyncStatus('syncing', 'Saving...');
  try {
    const payload = {
      projects: state.projects,
      lists: state.lists,
      tasks: state.tasks,
      updatedAt: nowISO()
    };
    await setDoc(doc(db, WORKSTATION_COLLECTION, WORKSTATION_DOC), payload);
    lastCloudSavedAt = payload.updatedAt;
    saveLocal();
    refreshSyncPill();
    return true;
  } catch (e) {
    console.warn('[cloud] save failed:', e);
    setSyncStatus('error', 'Save failed');
    return false;
  }
}

let _saveTimer = null;
function scheduleCloudSave() {
  refreshSyncPill();
  if (!cloudEnabled) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { pushToCloud(); }, 800);
}

async function initCloudSync() {
  refreshSyncPill();
  if (!cloudEnabled) return;
  const cloud = await loadFromCloud();
  if (!cloud) {
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
    toast('Workspace loaded from cloud');
  } else {
    await pushToCloud();
  }
  refreshSyncPill();
}

async function manualSync() {
  if (!cloudEnabled) {
    toast('Cloud not configured — working locally');
    return;
  }
  toast('Syncing...');
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
    toast('Sync complete');
  }
}

/* ---------------- TOAST + MODALS ---------------- */

function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

function openModal(id) {
  // $ is querySelector-only (window.MTW), so normalize bare ids: 'x' -> '#x'
  const sel = typeof id === 'string' ? (id.startsWith('#') ? id : '#' + id) : id;
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.classList.add('open');
}
function closeModal(el) {
  if (typeof el === 'string') {
    openModalReverse(el);
    return;
  }
  if (el) el.classList.remove('open');
}
function openModalReverse(id) {
  const sel = id.startsWith('#') ? id : '#' + id;
  const el = $(sel);
  if (el) el.classList.remove('open');
}
document.querySelectorAll('.modal-overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('[data-close]')) closeModal(ov);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(closeModal);
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    $('#searchInput')?.focus();
  }
});

/* Custom confirm dialog — replaces native confirm() */
function askConfirm({ title, message, okLabel, onConfirm }) {
  $('#confirmTitle').textContent = title || 'Are you sure?';
  $('#confirmMessage').textContent = message || '';
  $('#confirmOk').textContent = okLabel || 'Delete';
  confirmCallback = onConfirm || null;
  openModal('confirmModal');
  setTimeout(() => $('#confirmCancel')?.focus(), 50);
}

/* ---------------- HELPERS ---------------- */

const getProject = (id) => state.projects.find((p) => p.id === id);
const getList = (id) => state.lists.find((l) => l.id === id);

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
  renderProjects();
  renderBoard();
  save();
}

function renderProjects() {
  const grid = $('#projectsGrid');
  if (!grid) return;
  const projects = filteredProjects();
  if (!projects.length) {
    grid.innerHTML = `<div class="empty-box">No main cards yet.<br/>Create one to start collecting commits.</div>`;
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
          <span class="commit-count">${p.commits.length} commit${p.commits.length === 1 ? '' : 's'}</span>
          <span class="last-commit">${last ? escapeHtml(last.title) : 'No commits yet'}</span>
        </div>
        <div class="project-actions">
          <button class="btn btn-small btn-ghost" onclick="openHistory('${p.id}')">${I.history} History</button>
          <button class="btn btn-small btn-success" onclick="quickCommit('${p.id}')">${I.plus} Commit</button>
          <button class="btn btn-small btn-ghost" onclick="editProject('${p.id}')">${I.edit} Edit</button>
          <button class="btn btn-small btn-danger" onclick="deleteProject('${p.id}')">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderBoard() {
  const board = $('#board');
  if (!board) return;
  if (!state.lists.length) {
    board.innerHTML = `<div class="empty-box">No lists. Create one to get started.</div>`;
    return;
  }
  board.innerHTML = state.lists.map((list) => {
    const tasks = filteredTasks(list.id);
    const cards = tasks.map((t) => {
      const proj = getProject(t.projectId);
      return `
      <div class="task" draggable="true" data-task="${t.id}">
        <h4>${escapeHtml(t.title)}</h4>
        ${t.description ? `<p>${escapeHtml(t.description)}</p>` : ''}
        <div class="task-badges">
          ${proj ? `<span class="badge"><span class="linked-dot" style="background:${escapeHtml(proj.color)}"></span>${escapeHtml(proj.title)}</span>` : '<span class="badge">Unlinked</span>'}
          <span class="badge">${I.clock} ${fmtDate(t.createdAt)}</span>
        </div>
        <div class="task-footer">
          <button class="btn btn-small btn-success" onclick="openCommit('${t.id}')">${I.check} Commit</button>
          <button class="btn btn-small btn-ghost" onclick="editTask('${t.id}')">Edit</button>
          <button class="icon-btn danger" onclick="deleteTask('${t.id}')" title="Delete card">${I.trash}</button>
        </div>
      </div>`;
    }).join('');

    return `
    <div class="list" data-list="${list.id}">
      <div class="list-head">
        <h3>${escapeHtml(list.title)}<span class="count">${tasks.length}</span></h3>
        <div class="list-menu">
          <button class="icon-btn" onclick="editList('${list.id}')" title="Rename list">${I.edit}</button>
          <button class="icon-btn danger" onclick="deleteList('${list.id}')" title="Delete list">${I.trash}</button>
        </div>
      </div>
      <div class="task-slot">${cards || '<p class="muted small" style="padding:4px">Drop cards here</p>'}</div>
      <button class="add-card-btn" onclick="openTaskModal('${list.id}')">${I.plus} Add todo card</button>
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
        toast(`Moved to ${getList(task.listId)?.title || 'list'}`);
      }
    });
  });
}

/* ---------------- PROJECT CRUD ---------------- */

function openProjectModal() {
  editingProjectId = null;
  $('#projectModalTitle').textContent = 'New main card';
  $('#projectTitle').value = '';
  $('#projectDesc').value = '';
  selectedColor = '#6366f1';
  syncColors();
  openModal('projectModal');
  setTimeout(() => $('#projectTitle')?.focus(), 50);
}

function editProject(id) {
  const p = getProject(id);
  if (!p) return;
  editingProjectId = id;
  $('#projectModalTitle').textContent = 'Edit main card';
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
  if (!title) return toast('Give the main card a title');
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
    toast(`Main card "${title}" created`);
  }
  closeModal($('#projectModal'));
  render();
}

function deleteProject(id) {
  const p = getProject(id);
  if (!p) return;
  const linked = state.tasks.filter((t) => t.projectId === id).length;
  askConfirm({
    title: `Delete "${p.title}"?`,
    message: `This removes the card and its ${p.commits.length} commit${p.commits.length === 1 ? '' : 's'}.${linked ? ` ${linked} todo card${linked === 1 ? '' : 's'} linked to it will become unlinked.` : ''} This cannot be undone.`,
    okLabel: 'Delete card',
    onConfirm: () => {
      state.projects = state.projects.filter((x) => x.id !== id);
      state.tasks.forEach((t) => { if (t.projectId === id) t.projectId = null; });
      render();
      toast('Main card deleted');
    }
  });
}

/* ---------------- LIST CRUD ---------------- */

function openListModal() {
  editingListId = null;
  $('#listModalTitle').textContent = 'New list';
  $('#listTitle').value = '';
  openModal('listModal');
  setTimeout(() => $('#listTitle')?.focus(), 50);
}
function editList(id) {
  editingListId = id;
  $('#listModalTitle').textContent = 'Rename list';
  $('#listTitle').value = getList(id)?.title || '';
  openModal('listModal');
  setTimeout(() => $('#listTitle')?.focus(), 50);
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
  const l = getList(id);
  const count = state.tasks.filter((t) => t.listId === id).length;
  askConfirm({
    title: `Delete list "${l?.title || ''}"?`,
    message: count
      ? `${count} todo card${count === 1 ? '' : 's'} will move to another list. This cannot be undone.`
      : 'This cannot be undone.',
    okLabel: 'Delete list',
    onConfirm: () => {
      const fallback = state.lists.find((x) => x.id !== id).id;
      state.tasks.forEach((t) => { if (t.listId === id) t.listId = fallback; });
      state.lists = state.lists.filter((x) => x.id !== id);
      render();
      toast('List deleted');
    }
  });
}

/* ---------------- TASK CRUD ---------------- */

function fillTaskSelects(activeListId, activeProjectId) {
  $('#taskList').innerHTML = state.lists.map((l) =>
    `<option value="${l.id}" ${l.id === activeListId ? 'selected' : ''}>${escapeHtml(l.title)}</option>`).join('');
  $('#taskProject').innerHTML = `<option value="">No main card</option>` + state.projects.map((p) =>
    `<option value="${p.id}" ${p.id === activeProjectId ? 'selected' : ''}>${escapeHtml(p.title)}</option>`).join('');
}

function openTaskModal(listId) {
  editingTaskId = null;
  $('#taskModalTitle').textContent = 'New todo card';
  $('#taskTitle').value = '';
  $('#taskDesc').value = '';
  fillTaskSelects(listId || state.lists[0]?.id, state.projects[0]?.id);
  openModal('taskModal');
  setTimeout(() => $('#taskTitle')?.focus(), 50);
}

function editTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  editingTaskId = id;
  $('#taskModalTitle').textContent = 'Edit todo card';
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
    state.tasks.push({ id: uid(), createdAt: nowISO(), ...data });
    toast('Todo card added');
  }
  closeModal($('#taskModal'));
  render();
}

function deleteTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  askConfirm({
    title: 'Delete this todo card?',
    message: `"${t.title}" will be permanently removed. This cannot be undone.`,
    okLabel: 'Delete card',
    onConfirm: () => {
      state.tasks = state.tasks.filter((x) => x.id !== id);
      render();
      toast('Todo card deleted');
    }
  });
}

/* ---------------- COMMITS (archiving) ---------------- */

function openCommit(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  if (!state.projects.length) return toast('Create a main card first');
  commitTaskId = taskId;
  $('#commitTaskName').textContent = `Task: "${t.title}"`;
  $('#commitProject').innerHTML = state.projects.map((p) =>
    `<option value="${p.id}" ${p.id === (t.projectId || state.projects[0].id) ? 'selected' : ''}>${escapeHtml(p.title)}</option>`).join('');
  $('#commitTitle').value = t.title;
  $('#commitMessage').value = t.description || '';
  openModal('commitModal');
  setTimeout(() => $('#commitTitle')?.focus(), 50);
}

function quickCommit(projectId) {
  const cand = state.tasks.find((t) => t.projectId === projectId)
    || state.tasks[0];
  if (!cand) return toast('No open todo cards — create one first');
  openCommit(cand.id);
  setTimeout(() => { const s = $('#commitProject'); if (s) s.value = projectId; }, 50);
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
  if (!projectId) return toast('Pick a main card to commit to');
  if (!title) return toast('Write a commit title — what changed?');
  pushCommit(projectId, {
    title,
    message: $('#commitMessage').value,
    taskTitle: t?.title || 'Manual commit',
    taskId: t?.id || null
  });
  // Archive: the todo card is removed from the board once committed
  if (t) {
    state.tasks = state.tasks.filter((x) => x.id !== t.id);
  }
  closeModal($('#commitModal'));
  render();
  const pname = getProject(projectId)?.title;
  toast(`Committed to "${pname}" — todo archived`);
}

function openHistory(projectId) {
  const p = getProject(projectId);
  if (!p) return;
  $('#historyTitle').textContent = `${p.title} — commit history`;
  $('#historySub').textContent = `${p.commits.length} commit${p.commits.length === 1 ? '' : 's'}`;
  const list = $('#historyList');
  if (!p.commits.length) {
    list.innerHTML = `<div class="empty-box">No commits yet. Finish a todo and commit it to <b>${escapeHtml(p.title)}</b>.</div>`;
  } else {
    list.innerHTML = [...p.commits].reverse().map((c) => `
      <div class="commit-item" style="border-left-color:${escapeHtml(p.color)}">
        <h4>${escapeHtml(c.title)} <span class="commit-hash">#${c.hash}</span></h4>
        <div class="meta">${fmtDate(c.date)}${c.taskTitle ? ` — from "${escapeHtml(c.taskTitle)}"` : ''}</div>
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

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'commitboard-backup.json';
  a.click();
  toast('Backup exported');
}
$('#settingsExportBtn').addEventListener('click', exportBackup);
$('#settingsImportBtn').addEventListener('click', () => $('#settingsImportFile').click());
$('#settingsImportFile').addEventListener('change', (e) => {
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
      toast('Backup imported');
    } catch { toast('Invalid backup file'); }
  };
  r.readAsText(f);
  e.target.value = '';
});

/* ---------------- SETTINGS ---------------- */

function openSettings() {
  buildThemeEditor();
  applySettings();
  openModal('settingsModal');
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsSyncBtn').addEventListener('click', () => { manualSync(); });
$('#settingsResetBtn').addEventListener('click', () => {
  askConfirm({
    title: 'Reset workspace?',
    message: 'All cards, lists and commits will be replaced with the demo data. This cannot be undone.',
    okLabel: 'Reset everything',
    onConfirm: () => {
      state = seed();
      render();
      scheduleCloudSave();
      closeModal($('#settingsModal'));
      toast('Workspace reset');
    }
  });
});
document.querySelectorAll('#themeOptions button').forEach((b) => {
  b.addEventListener('click', () => {
    settings.theme = b.dataset.themeOpt;
    saveSettings();
    applySettings();
  });
});
document.querySelectorAll('#accentOptions button').forEach((b) => {
  b.addEventListener('click', () => {
    settings.accent = b.dataset.accent;
    settings.custom = settings.custom || {};
    settings.custom['--accent'] = b.dataset.accent;
    saveSettings();
    applySettings();
  });
});
$('#resetCustomBtn').addEventListener('click', () => {
  settings.custom = {};
  saveSettings();
  applySettings();
  toast('Custom colors cleared');
});

/* ---------------- CONFIRM WIRING ---------------- */

$('#confirmCancel').addEventListener('click', () => {
  confirmCallback = null;
  closeModal($('#confirmModal'));
});
$('#confirmOk').addEventListener('click', () => {
  const cb = confirmCallback;
  confirmCallback = null;
  closeModal($('#confirmModal'));
  if (cb) cb();
});

/* ---------------- CRUD WIRING ---------------- */

$('#addProjectBtn').addEventListener('click', openProjectModal);
$('#addListBtn').addEventListener('click', openListModal);
$('#saveProjectBtn').addEventListener('click', saveProject);
$('#saveTaskBtn').addEventListener('click', saveTask);
$('#saveListBtn').addEventListener('click', saveList);
$('#saveCommitBtn').addEventListener('click', saveCommit);

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
applySettings();
render();
refreshSyncPill();
initCloudSync();
