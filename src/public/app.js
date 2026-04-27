// --- State ---
let currentUserId = null;
let groups = [];
let selectedGroups = [];
let contacts = [];
let selectedContacts = [];
let uploadedFiles = [];
let templates = [];
let currentMode = 'free';
let editingMessageId = null;
let evtSource = null;
let tplAttachments = [];
let availableTags = [];
let selectedTags = [];
let participantsCache = {};
let filterState = { queue: {}, history: {} };
let currentDraftId = null;
let autoSaveTimer = null;
let userTimezone = 'Europe/Paris';
let currentMessageType = 'text';
let currentLocation = null;
let googleMapsLoaded = false;
let googleMapsApiKey = '';
let locationMap = null;
let locationMarker = null;
let audioRecorder = null;
let audioChunks = [];
let audioTimerInterval = null;
let audioStartTime = 0;
let recordedAudioFile = null;
let recordedAudioBlobUrl = null;

const TIMEZONES = [
  { value: 'Europe/Paris', label: 'Europe/Paris (UTC+1/+2)' },
  { value: 'Europe/London', label: 'Europe/London (UTC+0/+1)' },
  { value: 'Europe/Madrid', label: 'Europe/Madrid' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'Europe/Lisbon', label: 'Europe/Lisbon' },
  { value: 'Europe/Moscow', label: 'Europe/Moscow' },
  { value: 'Africa/Casablanca', label: 'Afrique/Casablanca' },
  { value: 'Africa/Tunis', label: 'Afrique/Tunis' },
  { value: 'Africa/Algiers', label: 'Afrique/Alger' },
  { value: 'Africa/Abidjan', label: 'Afrique/Abidjan' },
  { value: 'Africa/Johannesburg', label: 'Afrique/Johannesburg' },
  { value: 'Indian/Mauritius', label: 'Ocean Indien/Maurice' },
  { value: 'Indian/Reunion', label: 'Ocean Indien/Reunion' },
  { value: 'Atlantic/Canary', label: 'Canaries' },
  { value: 'America/Guadeloupe', label: 'Amerique/Guadeloupe' },
  { value: 'America/Martinique', label: 'Amerique/Martinique' },
  { value: 'America/New_York', label: 'Amerique/New York' },
  { value: 'America/Los_Angeles', label: 'Amerique/Los Angeles' },
  { value: 'America/Sao_Paulo', label: 'Amerique/Sao Paulo' },
  { value: 'Asia/Tokyo', label: 'Asie/Tokyo' },
  { value: 'Asia/Dubai', label: 'Asie/Dubai' },
  { value: 'Asia/Bangkok', label: 'Asie/Bangkok' },
  { value: 'Australia/Sydney', label: 'Australie/Sydney' },
  { value: 'UTC', label: 'UTC' },
];

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initDropZone();
  initFormatToolbars();
  initKeyboardShortcuts();
  initComposeEditor();
  initLivePreview();
  initConfig();

  // Check if user was previously selected
  const savedUserId = sessionStorage.getItem('userId');
  if (savedUserId) {
    // Verify user still exists
    fetch('/api/users').then(r => r.json()).then(users => {
      const exists = users.some(u => String(u.id) === String(savedUserId));
      if (exists) {
        selectProfile(parseInt(savedUserId), true);
      } else {
        sessionStorage.removeItem('userId');
        showProfilesScreen();
      }
    }).catch(() => showProfilesScreen());
  } else {
    showProfilesScreen();
  }
});

// --- API helper ---
function api(url, options = {}) {
  if (currentUserId) {
    options.headers = { ...options.headers, 'x-user-id': String(currentUserId) };
  }
  return fetch(url, options);
}

// --- Profiles ---
function showProfilesScreen() {
  document.getElementById('sidebar').classList.add('hidden');
  document.querySelectorAll('.section').forEach((s) => s.classList.add('hidden'));
  document.getElementById('section-profiles').classList.remove('hidden');
  document.getElementById('btn-switch-profile').classList.add('hidden');
  document.getElementById('current-user').classList.add('hidden');
  document.getElementById('wa-status').classList.add('hidden');
  document.getElementById('btn-reconnect').classList.add('hidden');
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.classList.add('hidden');
  loadProfiles();
}

async function loadProfiles() {
  try {
    const res = await fetch('/api/users');
    const users = await res.json();
    const grid = document.getElementById('profiles-grid');

    if (users.length === 0) {
      grid.innerHTML = '<p style="color:var(--text-light);font-style:italic;text-align:center;width:100%;white-space:nowrap">Aucun profil. Creez le votre !</p>';
      return;
    }

    grid.innerHTML = users.map((u) => {
      const initial = u.name.charAt(0).toUpperCase();
      const statusLabel = { ready: 'Connecte', disconnected: 'Deconnecte', qr: 'QR en attente', connecting: 'Connexion...' };
      return `<div class="profile-card" onclick="selectProfile(${u.id})">
        <div class="profile-avatar">${initial}</div>
        <div class="profile-name">${escapeHtml(u.name)}</div>
        <span class="profile-status ${u.waStatus}">${statusLabel[u.waStatus] || 'Deconnecte'}</span>
        <br><button class="profile-delete" onclick="event.stopPropagation();deleteProfile(${u.id})">Supprimer</button>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Failed to load profiles:', err);
  }
}

async function createProfile() {
  const input = document.getElementById('new-profile-name');
  const name = input.value.trim();
  if (!name) { toast('Entrez un prenom', 'error'); return; }

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (res.ok) {
      input.value = '';
      toast(`Profil "${data.name}" cree !`, 'success');
      selectProfile(data.id);
    } else {
      toast(data.error || 'Erreur', 'error');
    }
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}

async function deleteProfile(id) {
  if (!confirm('Supprimer ce profil et toutes ses donnees ?')) return;
  try {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (currentUserId === id) {
        currentUserId = null;
        sessionStorage.removeItem('userId');
        showProfilesScreen();
      }
      toast('Profil supprime', 'success');
      loadProfiles();
    }
  } catch (err) {
    toast('Erreur: ' + err.message, 'error');
  }
}

async function selectProfile(userId, silent = false) {
  if (!userId) { toast('Erreur: userId invalide', 'error'); return; }
  currentUserId = userId;
  sessionStorage.setItem('userId', String(userId));

  // Show main app
  document.getElementById('sidebar').classList.remove('hidden');
  document.getElementById('section-profiles').classList.add('hidden');
  document.getElementById('btn-switch-profile').classList.remove('hidden');
  document.getElementById('current-user').classList.remove('hidden');
  document.getElementById('wa-status').classList.remove('hidden');
  document.getElementById('btn-reconnect').classList.remove('hidden');
  document.getElementById('btn-settings').classList.remove('hidden');

  // Fetch user info
  try {
    const res = await fetch('/api/users');
    const users = await res.json();
    const user = users.find((u) => String(u.id) === String(userId));
    if (user) {
      document.getElementById('current-user').textContent = user.name;
    }
  } catch (err) { /* ignore */ }

  // Show compose section by default
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const composeNav = document.querySelector('[data-section="compose"]');
  if (composeNav) composeNav.classList.add('active');
  document.querySelectorAll('.section').forEach((s) => s.classList.add('hidden'));
  document.getElementById('section-compose').classList.remove('hidden');

  // Connect SSE for this user
  initSSE();

  // Trigger WhatsApp connection, then poll for QR
  api('/api/connect', { method: 'POST' }).catch(() => {});
  pollForQR();

  // Load data
  loadGroups();
  loadContacts();
  loadTemplatesList();
  loadAvailableTags();
  loadUserTimezone();
  startAutoSave();

  if (!silent) toast('Profil selectionne', 'info');
}

function switchProfile() {
  if (evtSource) { evtSource.close(); evtSource = null; }
  currentUserId = null;
  sessionStorage.removeItem('userId');
  showProfilesScreen();
}

// --- Navigation ---
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      if (!currentUserId) return;
      const section = item.dataset.section;
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.section').forEach((s) => s.classList.add('hidden'));
      document.getElementById(`section-${section}`).classList.remove('hidden');

      if (section === 'queue') loadQueue();
      if (section === 'drafts') loadDrafts();
      if (section === 'templates') loadTemplatesList();
      if (section === 'history') loadHistory();
    });
  });
}

// --- SSE ---
function initSSE() {
  if (evtSource) evtSource.close();
  if (!currentUserId) return;

  evtSource = new EventSource(`/api/events?userId=${currentUserId}`);

  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'groups_updated') {
      loadGroups();
      return;
    }
    if (data.type === 'contacts_updated') {
      loadContacts();
      return;
    }
    if (data.type === 'qr') {
      showQRCode(data.qrCode);
      updateStatusBadge('qr');
    } else if (data.type === 'status') {
      updateStatusBadge(data.status);
      if (data.status === 'ready') {
        hideQRCode();
        loadGroups();
        loadContacts();
      } else if (data.status === 'connecting') {
        hideQRCode();
      } else if (data.status === 'qr' && data.qrCode) {
        showQRCode(data.qrCode);
      }
    }
  };

  evtSource.onerror = () => {
    updateStatusBadge('disconnected');
  };

  // Click on badge to show QR (use onclick to avoid duplicates)
  document.getElementById('wa-status').onclick = async () => {
    if (!currentUserId) return;
    const res = await api('/api/status');
    const st = await res.json();
    if (st.qrCode) showQRCode(st.qrCode);
  };
}

let qrPollTimer = null;
function pollForQR() {
  if (qrPollTimer) clearInterval(qrPollTimer);
  let attempts = 0;
  qrPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > 20 || !currentUserId) { clearInterval(qrPollTimer); return; }
    try {
      const res = await api('/api/status');
      const st = await res.json();
      updateStatusBadge(st.status);
      if (st.qrCode) {
        showQRCode(st.qrCode);
        clearInterval(qrPollTimer);
      } else if (st.status === 'ready') {
        hideQRCode();
        loadGroups();
        loadContacts();
        clearInterval(qrPollTimer);
      }
    } catch (err) { /* ignore */ }
  }, 3000);
}

function updateStatusBadge(status) {
  const badge = document.getElementById('wa-status');
  badge.className = `status-badge ${status}`;
  const labels = { ready: 'Connecte', disconnected: 'Deconnecte', connecting: 'Connexion en cours...', qr: 'Scanner QR' };
  badge.textContent = labels[status] || status;

  // Show/hide connection overlay
  const overlay = document.getElementById('connection-overlay');
  if (overlay) {
    if (status === 'connecting') {
      overlay.innerHTML = '<div class="loading"><div class="spinner"></div><span>Connexion a WhatsApp en cours... <a href="#" onclick="event.preventDefault();checkQR()" style="color:var(--primary)">Afficher le QR code</a></span></div>';
      overlay.classList.remove('hidden');
    } else if (status === 'ready') {
      overlay.classList.add('hidden');
    } else if (status === 'disconnected') {
      overlay.innerHTML = '<div class="loading"><span style="color:var(--danger)">WhatsApp deconnecte. Cliquez sur le badge pour scanner le QR code.</span></div>';
      overlay.classList.remove('hidden');
    }
  }
}

function showQRCode(qrData) {
  const modal = document.getElementById('qr-modal');
  const container = document.getElementById('qr-container');
  container.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(qrData)}" alt="QR Code">`;
  modal.classList.remove('hidden');
}

function hideQRCode() {
  document.getElementById('qr-modal').classList.add('hidden');
}

async function checkQR() {
  if (!currentUserId) return;
  try {
    const res = await api('/api/status');
    const st = await res.json();
    if (st.qrCode) {
      showQRCode(st.qrCode);
    } else {
      toast('QR code pas encore disponible, patientez...', 'info');
    }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function reconnectWhatsApp() {
  if (!currentUserId) return;
  if (!confirm('Relancer la connexion WhatsApp ?')) return;
  toast('Reconnexion en cours... (5-10s)', 'info');
  hideQRCode();
  updateStatusBadge('connecting');
  try {
    await api('/api/reconnect', { method: 'POST' });
    // Wait for server to restart the client then poll
    setTimeout(() => pollForQR(), 3000);
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

// --- Loading indicator ---
function showLoading(elementId, message = 'Chargement...') {
  const el = document.getElementById(elementId);
  if (el) el.innerHTML = `<div class="loading"><div class="spinner"></div><span>${message}</span></div>`;
}

// --- Groups ---
async function loadGroups() {
  showLoading('groups-list', 'Chargement des groupes...');
  try {
    const res = await api('/api/groups');
    groups = await res.json();
    renderGroups();
  } catch (err) { console.error('Failed to load groups:', err); }
}

function renderGroups(filter = '') {
  const list = document.getElementById('groups-list');
  const filtered = groups.filter((g) => g.name.toLowerCase().includes(filter.toLowerCase()));

  list.innerHTML = filtered.map((g) => {
    const checked = selectedGroups.some((s) => s.id === g.id);
    return `<label class="group-item ${checked ? 'selected' : ''}">
      <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleGroup('${g.id}', '${escapeHtml(g.name)}')">
      <span>${escapeHtml(g.name)}</span>
      <span style="color:var(--text-light);font-size:12px">(${g.participants})</span>
    </label>`;
  }).join('');

  renderSelectedGroups();
}

document.getElementById('group-search')?.addEventListener('input', (e) => renderGroups(e.target.value));

function toggleGroup(id, name) {
  const idx = selectedGroups.findIndex((g) => g.id === id);
  if (idx >= 0) selectedGroups.splice(idx, 1);
  else selectedGroups.push({ id, name });
  renderGroups(document.getElementById('group-search').value);
}

function removeGroup(id) {
  selectedGroups = selectedGroups.filter((g) => g.id !== id);
  renderGroups(document.getElementById('group-search').value);
}

function renderSelectedGroups() {
  const container = document.getElementById('selected-groups');
  container.innerHTML = selectedGroups
    .map((g, i) => `<span class="group-tag draggable" draggable="true" data-idx="${i}" data-list="groups"><span class="drag-handle">&#x2630;</span> ${escapeHtml(g.name)} <span class="remove" onclick="removeGroup('${g.id}')">&times;</span></span>`)
    .join('');
  attachDragHandlers(container, 'groups');
}

// --- Contacts ---
async function loadContacts() {
  showLoading('contacts-list', 'Chargement des contacts...');
  try {
    const res = await api('/api/contacts');
    contacts = await res.json();
    renderContacts();
  } catch (err) { console.error('Failed to load contacts:', err); }
}

async function manualRefreshContacts() {
  toast('Synchronisation en cours...', 'info');
  try {
    const res = await api('/api/refresh', { method: 'POST' });
    if (res.ok) {
      toast('Groupes et contacts rafraichis', 'success');
      loadGroups();
      loadContacts();
      participantsCache = {};
    } else {
      const d = await res.json();
      toast(d.error || 'Erreur', 'error');
    }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function renderContacts(filter = '') {
  const list = document.getElementById('contacts-list');
  if (!list) return;
  const filtered = contacts.filter((c) =>
    (c.name || '').toLowerCase().includes(filter.toLowerCase()) || (c.number || '').includes(filter)
  );

  list.innerHTML = filtered.map((c) => {
    const checked = selectedContacts.some((s) => s.id === c.id);
    return `<label class="group-item ${checked ? 'selected' : ''}">
      <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleContact('${c.id}', '${escapeHtml(c.name)}')">
      <span>${escapeHtml(c.name)}</span>
      <span style="color:var(--text-light);font-size:12px">${c.number || ''}</span>
    </label>`;
  }).join('');

  renderSelectedContacts();
}

document.getElementById('contact-search')?.addEventListener('input', (e) => renderContacts(e.target.value));

function toggleContact(id, name) {
  const idx = selectedContacts.findIndex((c) => c.id === id);
  if (idx >= 0) selectedContacts.splice(idx, 1);
  else selectedContacts.push({ id, name });
  renderContacts(document.getElementById('contact-search').value);
}

function removeContact(id) {
  selectedContacts = selectedContacts.filter((c) => c.id !== id);
  renderContacts(document.getElementById('contact-search').value);
}

function renderSelectedContacts() {
  const container = document.getElementById('selected-contacts');
  if (!container) return;
  container.innerHTML = selectedContacts
    .map((c, i) => `<span class="group-tag draggable" draggable="true" data-idx="${i}" data-list="contacts"><span class="drag-handle">&#x2630;</span> ${escapeHtml(c.name)} <span class="remove" onclick="removeContact('${c.id}')">&times;</span></span>`)
    .join('');
  attachDragHandlers(container, 'contacts');
}

// --- Drag & drop recipients ---
let draggedIdx = null;
let draggedList = null;

function attachDragHandlers(container, listName) {
  container.querySelectorAll('.draggable').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      draggedIdx = parseInt(el.dataset.idx);
      draggedList = listName;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(draggedIdx)); } catch (_) {}
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      container.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
    });
    el.addEventListener('dragover', (e) => {
      if (draggedList !== listName) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      if (draggedList !== listName) return;
      e.preventDefault();
      const targetIdx = parseInt(el.dataset.idx);
      if (draggedIdx == null || targetIdx === draggedIdx) return;
      const arr = listName === 'groups' ? selectedGroups : selectedContacts;
      const [moved] = arr.splice(draggedIdx, 1);
      arr.splice(targetIdx, 0, moved);
      draggedIdx = null;
      draggedList = null;
      if (listName === 'groups') renderSelectedGroups(); else renderSelectedContacts();
    });
  });
}

// --- Mode ---
function setMode(mode) {
  currentMode = mode;
  document.getElementById('mode-free').classList.toggle('active', mode === 'free');
  document.getElementById('mode-template').classList.toggle('active', mode === 'template');
  document.getElementById('template-picker').classList.toggle('hidden', mode !== 'template');
  if (mode === 'template') loadTemplateOptions();
}

async function loadTemplateOptions() {
  try {
    const res = await api('/api/templates');
    const tpls = await res.json();
    document.getElementById('template-select').innerHTML =
      '<option value="">-- Selectionner --</option>' +
      tpls.map((t) => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join('');
  } catch (err) { console.error('Failed to load templates:', err); }
}

async function loadTemplate() {
  const select = document.getElementById('template-select');
  if (!select.value) return;
  try {
    const res = await api('/api/templates');
    const tpls = await res.json();
    const tpl = tpls.find((t) => t.id === parseInt(select.value));
    if (!tpl) return;
    // Pre-fill compose with ALL template features
    const msg = {
      groups: [...selectedGroups, ...selectedContacts],
      content: tpl.content,
      attachments: tpl.attachments || [],
      notes: tpl.notes,
      tags: tpl.tags,
      mentions: tpl.mentions,
      timezone: tpl.timezone,
      type: tpl.type,
      poll: tpl.poll,
      location: tpl.location,
      recurrence: tpl.recurrence,
    };
    fillComposeFromMessage(msg, { keepId: false, keepDate: false });
    toast('Template charge', 'info');
  } catch (err) { console.error('Failed to load template:', err); }
}

// --- Preview ---
function togglePreview() {
  const preview = document.getElementById('message-preview');
  const ed = document.getElementById('message-content');
  const { text } = getEditorText(ed);
  if (preview.classList.contains('hidden')) {
    preview.innerHTML = formatWhatsApp(text);
    preview.classList.remove('hidden');
  } else {
    preview.classList.add('hidden');
  }
}

function formatWhatsApp(text) {
  return escapeHtml(text)
    .replace(/\*(.+?)\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/~(.+?)~/g, '<del>$1</del>')
    .replace(/\n/g, '<br>');
}

// --- Emoji picker ---
let activeEmojiPicker = null;

function toggleEmojiPicker(targetId, btn) {
  const existing = document.querySelector('.emoji-picker-container');
  if (existing) {
    existing.remove();
    activeEmojiPicker = null;
    return;
  }

  const textarea = document.getElementById(targetId);
  if (!textarea) return;

  const container = document.createElement('div');
  container.className = 'emoji-picker-container';
  const picker = document.createElement('emoji-picker');
  // Try to match language
  picker.setAttribute('locale', 'fr');
  container.appendChild(picker);

  // Position : fixed, anchored to the smiley button (below, flip above if no room)
  document.body.appendChild(container);
  container.style.position = 'fixed';

  const rect = btn.getBoundingClientRect();
  const pickerWidth = 340;
  const pickerHeight = 380;
  const margin = 6;

  let left = rect.right - pickerWidth;
  if (left < 8) left = 8;
  if (left + pickerWidth > window.innerWidth - 8) left = window.innerWidth - pickerWidth - 8;

  let top = rect.bottom + margin;
  if (top + pickerHeight > window.innerHeight - 8) {
    top = rect.top - pickerHeight - margin;
    if (top < 8) top = 8;
  }

  container.style.left = left + 'px';
  container.style.top = top + 'px';
  container.style.right = 'auto';
  container.style.bottom = 'auto';

  picker.addEventListener('emoji-click', (event) => {
    const emoji = event.detail.unicode;
    if (textarea.classList.contains('contenteditable')) {
      insertEmojiAtCaret(emoji);
    } else {
      insertAtCursor(textarea, emoji);
    }
  });

  activeEmojiPicker = container;

  // Close on outside click
  setTimeout(() => {
    const closeOnOutside = (e) => {
      if (!container.contains(e.target) && e.target !== btn) {
        container.remove();
        activeEmojiPicker = null;
        document.removeEventListener('click', closeOnOutside);
      }
    };
    document.addEventListener('click', closeOnOutside);
  }, 0);
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.substring(0, start);
  const after = textarea.value.substring(end);
  textarea.value = before + text + after;
  const newPos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = newPos;
  textarea.focus();
}

// --- Formatting toolbar ---
function wrapSelection(textarea, wrap) {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const selected = textarea.value.substring(start, end) || 'texte';
  const before = textarea.value.substring(0, start);
  const after = textarea.value.substring(end);
  textarea.value = before + wrap + selected + wrap + after;
  textarea.selectionStart = start + wrap.length;
  textarea.selectionEnd = start + wrap.length + selected.length;
  textarea.focus();
}

function prefixLines(textarea, prefix) {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const selected = textarea.value.substring(start, end);
  const before = textarea.value.substring(0, start);
  const after = textarea.value.substring(end);
  const prefixed = selected ? selected.split('\n').map((l) => prefix + l).join('\n') : prefix;
  textarea.value = before + prefixed + after;
  textarea.selectionStart = textarea.selectionEnd = start + prefixed.length;
  textarea.focus();
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const inTextarea = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');

    // Escape: close any open modal
    if (e.key === 'Escape') {
      const qr = document.getElementById('qr-modal');
      const pv = document.getElementById('preview-modal');
      if (qr && !qr.classList.contains('hidden')) hideQRCode();
      if (pv && !pv.classList.contains('hidden')) closePreviewModal();
      return;
    }

    // Ctrl+Enter: send/schedule
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const composeSection = document.getElementById('section-compose');
      if (composeSection && !composeSection.classList.contains('hidden')) {
        e.preventDefault();
        const dt = document.getElementById('schedule-datetime').value;
        if (dt) scheduleMessage(); else sendNow();
      }
      return;
    }

    // Ctrl+B/I inside message area or template textarea -> WhatsApp markers
    const isEditableTarget = active && (
      active.id === 'tpl-content' ||
      (active.id === 'message-content' && active.classList.contains('contenteditable'))
    );
    if ((e.ctrlKey || e.metaKey) && isEditableTarget) {
      const key = e.key.toLowerCase();
      if (key === 'b' || key === 'i') {
        e.preventDefault();
        e.stopPropagation();
        const wrap = key === 'b' ? '*' : '_';
        if (active.classList.contains('contenteditable')) wrapSelectionCE(wrap);
        else wrapSelection(active, wrap);
      }
    }

    // "/" focuses group search if not typing
    if (e.key === '/' && !inTextarea) {
      const search = document.getElementById('group-search');
      if (search && document.getElementById('section-compose') && !document.getElementById('section-compose').classList.contains('hidden')) {
        e.preventDefault();
        search.focus();
      }
    }
  });
}

// ==============================
//  TAGS (predefined, auto color)
// ==============================
function tagColor(name) {
  // Deterministic color from name — HSL with good saturation
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 55%, 42%)`;
}

async function loadAvailableTags() {
  try {
    const res = await api('/api/tags');
    availableTags = await res.json();
    renderTagsSelector();
    renderTagsListSettings();
  } catch (err) { console.error('Failed to load tags:', err); }
}

function renderTagsSelector() {
  const container = document.getElementById('tags-selector');
  if (!container) return;
  container.innerHTML = availableTags.map((t) => {
    const active = selectedTags.includes(t.name);
    return `<span class="tag-pill ${active ? 'selected' : ''}" style="background:${tagColor(t.name)}" onclick="toggleSelectTag('${escapeHtml(t.name).replace(/'/g, '&#39;')}')">#${escapeHtml(t.name)}</span>`;
  }).join('');
}

function toggleSelectTag(name) {
  const i = selectedTags.indexOf(name);
  if (i >= 0) selectedTags.splice(i, 1);
  else selectedTags.push(name);
  renderTagsSelector();
  renderQuickSchedule();
}

function renderQuickSchedule() {
  const block = document.getElementById('quick-schedule-block');
  const container = document.getElementById('quick-schedule-events');
  if (!block || !container) return;
  // Only selected tags with event_date
  const events = availableTags.filter(t => selectedTags.includes(t.name) && t.event_date);
  if (events.length === 0) { block.classList.add('hidden'); container.innerHTML = ''; return; }
  block.classList.remove('hidden');

  container.innerHTML = events.map(t => {
    const ev = t.event_date;
    const evFormatted = formatDate(ev);
    return `<div class="quick-event-card" data-tag-id="${t.id}">
      <div class="event-name">#${escapeHtml(t.name)} — ${escapeHtml(evFormatted)}</div>
      <div class="quick-buttons">
        <button type="button" class="quick-btn" onclick="applyQuickOffset('${escapeHtml(t.name)}', -14, '09:00')">J-14 a 09h</button>
        <button type="button" class="quick-btn" onclick="applyQuickOffset('${escapeHtml(t.name)}', -7, '09:00')">J-7 a 09h</button>
        <button type="button" class="quick-btn" onclick="applyQuickOffset('${escapeHtml(t.name)}', -3, '09:00')">J-3 a 09h</button>
        <button type="button" class="quick-btn" onclick="applyQuickOffset('${escapeHtml(t.name)}', -1, '18:00')">J-1 a 18h</button>
        <button type="button" class="quick-btn" onclick="applyQuickOffset('${escapeHtml(t.name)}', 0, null)">Jour J (heure de l'evenement)</button>
      </div>
      <div class="custom-offset">
        Custom : J-<input type="number" class="input input-sm" min="0" id="qc-days-${t.id}" placeholder="7"> a <input type="time" class="input input-sm" id="qc-time-${t.id}" placeholder="09:00"> <button type="button" class="btn btn-xs" onclick="applyCustomOffset('${escapeHtml(t.name)}', ${t.id})">Appliquer</button>
      </div>
    </div>`;
  }).join('');
}

function applyQuickOffset(tagName, daysOffset, timeOverride) {
  const tag = availableTags.find(t => t.name === tagName);
  if (!tag || !tag.event_date) return;
  const m = String(tag.event_date).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return;
  const dt = new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  dt.setUTCDate(dt.getUTCDate() + daysOffset);
  const y = dt.getUTCFullYear(), mo = String(dt.getUTCMonth() + 1).padStart(2, '0'), d = String(dt.getUTCDate()).padStart(2, '0');
  const time = timeOverride || `${m[4]}:${m[5]}`;
  const dateStr = `${y}-${mo}-${d}T${time}`;
  const dtInput = document.getElementById('schedule-datetime');
  if (dtInput) dtInput.value = dateStr;
  toast(`Programme pour ${formatDate(dateStr)}`, 'success');
}

function applyCustomOffset(tagName, tagId) {
  const days = -Math.abs(parseInt(document.getElementById('qc-days-' + tagId).value || 0));
  const time = document.getElementById('qc-time-' + tagId).value || null;
  applyQuickOffset(tagName, days, time);
}

function renderTagsListSettings() {
  const container = document.getElementById('tags-list');
  if (!container) return;
  if (availableTags.length === 0) {
    container.innerHTML = '<p style="color:var(--text-light);font-style:italic">Aucun tag. Ajoutez-en !</p>';
    return;
  }
  container.innerHTML = availableTags.map((t) => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;padding:8px;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;flex-wrap:wrap">
      <span class="tag-item" style="background:${tagColor(t.name)}">#${escapeHtml(t.name)}</span>
      <input type="datetime-local" value="${t.event_date ? escapeHtml(String(t.event_date).slice(0, 16)) : ''}" id="tag-date-${t.id}" class="input input-sm" style="max-width:200px" onchange="updateTagDate(${t.id})" title="Date d'evenement (optionnel)">
      <span style="font-size:11px;color:var(--text-light)">${t.event_date ? 'Evenement : ' + formatDate(t.event_date) : '(pas d evenement)'}</span>
      <button class="btn btn-xs btn-danger" onclick="deleteTag(${t.id})" style="margin-left:auto">Supprimer</button>
    </div>
  `).join('');
}

async function updateTagDate(id) {
  const input = document.getElementById('tag-date-' + id);
  if (!input) return;
  const event_date = input.value || null;
  try {
    const res = await api(`/api/tags/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_date }),
    });
    if (res.ok) {
      await loadAvailableTags();
      toast('Date mise a jour', 'success');
    }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function loadUserTimezone() {
  try {
    const res = await api('/api/users/me');
    const u = await res.json();
    userTimezone = u.timezone || 'Europe/Paris';
    renderSettingsTimezone();
    renderComposeTimezone();
  } catch (_) {}
}

function renderSettingsTimezone() {
  const sel = document.getElementById('settings-timezone');
  if (!sel) return;
  sel.innerHTML = TIMEZONES.map(t => `<option value="${t.value}"${t.value === userTimezone ? ' selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
}

async function saveUserTimezone() {
  const sel = document.getElementById('settings-timezone');
  const tz = sel.value;
  try {
    const res = await api(`/api/users/${currentUserId}/timezone`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: tz }),
    });
    if (res.ok) {
      userTimezone = tz;
      toast('Fuseau horaire mis a jour', 'success');
      // Update message form if visible
      const msgSel = document.getElementById('message-timezone');
      if (msgSel) msgSel.value = tz;
    } else {
      const d = await res.json();
      toast(d.error || 'Erreur', 'error');
    }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function renderComposeTimezone() {
  const sel = document.getElementById('message-timezone');
  if (!sel) return;
  sel.innerHTML = TIMEZONES.map(t => `<option value="${t.value}"${t.value === userTimezone ? ' selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
}

async function createTag() {
  const input = document.getElementById('new-tag-name');
  const dateInput = document.getElementById('new-tag-date');
  const name = (input.value || '').trim();
  if (!name) return;
  const event_date = dateInput?.value || null;
  try {
    const res = await api('/api/tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, event_date }),
    });
    if (res.ok) {
      input.value = '';
      if (dateInput) dateInput.value = '';
      await loadAvailableTags();
      toast('Tag cree', 'success');
    } else {
      const d = await res.json();
      toast(d.error || 'Erreur', 'error');
    }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function deleteTag(id) {
  if (!confirm('Supprimer ce tag ? Il sera retire de tous les messages.')) return;
  try {
    const res = await api(`/api/tags/${id}`, { method: 'DELETE' });
    if (res.ok) { await loadAvailableTags(); toast('Tag supprime', 'success'); }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function showSettings() {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  document.querySelectorAll('.section').forEach((s) => s.classList.add('hidden'));
  document.getElementById('section-settings').classList.remove('hidden');
  loadAvailableTags();
  loadUserTimezone();
}

// ==============================
//  CONTENTEDITABLE compose editor
//  with @mentions (chips) + emoji + formatting
// ==============================
function initComposeEditor() {
  const ed = document.getElementById('message-content');
  if (!ed) return;
  ed.addEventListener('input', onComposeInput);
  ed.addEventListener('keydown', onComposeKeydown);
  ed.addEventListener('blur', () => setTimeout(hideMentionDropdown, 150));
  ed.addEventListener('input', updateLivePreview);
}

async function initConfig() {
  try {
    const res = await fetch('/api/config');
    const c = await res.json();
    googleMapsApiKey = c.googleMapsApiKey || '';
  } catch (_) {}
}

function initLivePreview() {
  // Initial render
  updateLivePreview();
}

function updateLivePreview() {
  const pv = document.getElementById('live-preview');
  if (!pv) return;
  const ed = document.getElementById('message-content');
  if (!ed) return;
  const { text } = getEditorText(ed);
  pv.innerHTML = formatWhatsApp(text) || '<em style="color:var(--text-light)">Tapez un message...</em>';
}

// ==============================
//  MESSAGE TYPE SELECTOR
// ==============================
// DEPRECATED — replaced by add-on based UI. Kept for backward compat / reset.
function setMessageType(type) {
  currentMessageType = type || 'text';
  // Safe no-op on missing elements (new UI doesn't use all of these)
  const _toggle = (id, hide) => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', hide); };
  ['text', 'poll', 'location'].forEach(t => {
    const btn = document.getElementById(`msgtype-${t}`);
    if (btn) btn.classList.toggle('active', t === type);
  });
  _toggle('text-form', type !== 'text');
  _toggle('poll-form', type !== 'poll');
  _toggle('location-form', type !== 'location');
  _toggle('group-mode', type !== 'text');
  _toggle('attachments-form-group', type !== 'text');
}

// ==============================
//  ADD-ONS (attachments, audio, poll, location)
// ==============================
const activeAddons = { attachments: false, poll: false, location: false };

function addAddon(type) {
  activeAddons[type] = true;
  const el = document.getElementById('addon-' + type);
  if (el) el.classList.remove('hidden');
  if (type === 'poll') {
    const container = document.getElementById('poll-options');
    if (container && container.children.length === 0) {
      addPollOption();
      addPollOption();
    }
  } else if (type === 'location') {
    loadGoogleMaps().then(() => initLocationMap()).catch(err => {
      toast('Erreur chargement Google Maps: ' + err.message, 'error');
    });
  }
}

function removeAddon(type) {
  activeAddons[type] = false;
  const el = document.getElementById('addon-' + type);
  if (el) el.classList.add('hidden');
  if (type === 'attachments') {
    uploadedFiles = uploadedFiles.filter(f => !f.voice);
    renderFileList();
  } else if (type === 'poll') {
    resetPollForm();
  } else if (type === 'location') {
    resetLocationForm();
  }
}

function resetAddons() {
  ['attachments', 'poll', 'location'].forEach(t => removeAddon(t));
}

// ==============================
//  POLLS
// ==============================
function addPollOption() {
  const container = document.getElementById('poll-options');
  if (!container) return;
  if (container.children.length >= 12) { toast('Maximum 12 options', 'info'); return; }
  const idx = container.children.length;
  const row = document.createElement('div');
  row.className = 'poll-option-row';
  row.innerHTML = `
    <input type="text" class="input poll-option-input" placeholder="Option ${idx + 1}">
    <button type="button" class="btn btn-xs btn-danger" onclick="this.parentElement.remove()">&times;</button>
  `;
  container.appendChild(row);
}

function getPollData() {
  const question = (document.getElementById('poll-question').value || '').trim();
  const options = Array.from(document.querySelectorAll('.poll-option-input'))
    .map(i => i.value.trim())
    .filter(v => v.length > 0);
  const allowMultipleAnswers = document.getElementById('poll-multi').checked;
  return { question, options, allowMultipleAnswers };
}

function resetPollForm() {
  document.getElementById('poll-question').value = '';
  document.getElementById('poll-multi').checked = false;
  document.getElementById('poll-options').innerHTML = '';
}

// ==============================
//  LOCATION (Google Maps)
// ==============================
function loadGoogleMaps() {
  return new Promise((resolve, reject) => {
    if (googleMapsLoaded) return resolve();
    if (!googleMapsApiKey) return reject(new Error('Aucune cle API Google Maps configuree sur le serveur'));
    if (window.google && window.google.maps) { googleMapsLoaded = true; return resolve(); }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}&libraries=places&callback=__gmapsReady`;
    script.async = true;
    script.defer = true;
    window.__gmapsReady = () => { googleMapsLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Impossible de charger Google Maps'));
    document.head.appendChild(script);
  });
}

function initLocationMap() {
  if (!window.google || !window.google.maps) return;
  const mapEl = document.getElementById('location-map');
  if (!mapEl) return;

  const defaultCenter = { lat: 48.8566, lng: 2.3522 };
  locationMap = new google.maps.Map(mapEl, { center: defaultCenter, zoom: 12, streetViewControl: false, mapTypeControl: false });
  locationMarker = null;

  locationMap.addListener('click', (e) => {
    setLocationMarker(e.latLng.lat(), e.latLng.lng());
  });

  // Google Places Autocomplete on the search input
  const searchInput = document.getElementById('location-search');
  if (searchInput) {
    if (!searchInput.dataset.autocompleteInit) {
      try {
        if (!google.maps.places || !google.maps.places.Autocomplete) {
          throw new Error('Places API non disponible (a activer dans GCP)');
        }
        const ac = new google.maps.places.Autocomplete(searchInput, {
          fields: ['geometry', 'formatted_address', 'name'],
        });
        ac.bindTo('bounds', locationMap);
        ac.addListener('place_changed', () => {
          const place = ac.getPlace();
          if (!place.geometry || !place.geometry.location) {
            toast('Lieu introuvable. Cliquez sur la carte pour poser le pin.', 'info');
            return;
          }
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          locationMap.setCenter({ lat, lng });
          locationMap.setZoom(15);
          setLocationMarker(lat, lng, false);
          const label = place.name && place.formatted_address && !place.formatted_address.startsWith(place.name)
            ? `${place.name} — ${place.formatted_address}`
            : place.formatted_address || place.name || '';
          document.getElementById('location-info').textContent = `${label} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
          const descInput = document.getElementById('location-description');
          if (descInput && !descInput.value) descInput.value = label;
        });
        searchInput.dataset.autocompleteInit = '1';
      } catch (err) {
        console.warn('Places Autocomplete unavailable:', err.message);
        searchInput.placeholder = 'Recherche manuelle (Places API non activee — utilisez le bouton Chercher)';
      }
    }
  }

  if (currentLocation) {
    setLocationMarker(currentLocation.latitude, currentLocation.longitude, false);
    locationMap.setCenter({ lat: currentLocation.latitude, lng: currentLocation.longitude });
    locationMap.setZoom(15);
  }

  setTimeout(() => { if (locationMap && google.maps.event) google.maps.event.trigger(locationMap, 'resize'); }, 200);
}

function setLocationMarker(lat, lng, reverseGeocode = true) {
  if (!locationMap) return;
  if (locationMarker) locationMarker.setMap(null);
  locationMarker = new google.maps.Marker({
    position: { lat, lng },
    map: locationMap,
    draggable: true,
  });
  locationMarker.addListener('dragend', (e) => {
    const newLat = e.latLng.lat();
    const newLng = e.latLng.lng();
    currentLocation = { latitude: newLat, longitude: newLng, description: currentLocation?.description || '' };
    document.getElementById('location-info').textContent = `Coord: ${newLat.toFixed(5)}, ${newLng.toFixed(5)}`;
    if (window.google && google.maps.Geocoder) {
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ location: { lat: newLat, lng: newLng } }, (results, status) => {
        if (status === 'OK' && results[0]) {
          document.getElementById('location-info').textContent = `${results[0].formatted_address} (${newLat.toFixed(5)}, ${newLng.toFixed(5)})`;
        }
      });
    }
  });
  currentLocation = { latitude: lat, longitude: lng, description: currentLocation?.description || '' };
  document.getElementById('location-info').textContent = `Coord: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  if (reverseGeocode && window.google && google.maps.Geocoder) {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ location: { lat, lng } }, (results, status) => {
      if (status === 'OK' && results[0]) {
        document.getElementById('location-info').textContent = `${results[0].formatted_address} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
        const descInput = document.getElementById('location-description');
        if (descInput && !descInput.value) descInput.value = results[0].formatted_address;
      }
    });
  }
}

function googleMapsLink(lat, lng) {
  return `https://maps.google.com/?q=${lat},${lng}`;
}

async function searchLocation() {
  const q = document.getElementById('location-search').value.trim();
  if (!q || !window.google) return;
  const geocoder = new google.maps.Geocoder();
  geocoder.geocode({ address: q }, (results, status) => {
    if (status === 'OK' && results[0]) {
      const loc = results[0].geometry.location;
      locationMap.setCenter(loc);
      locationMap.setZoom(15);
      setLocationMarker(loc.lat(), loc.lng(), false);
      document.getElementById('location-info').textContent = `${results[0].formatted_address} (${loc.lat().toFixed(5)}, ${loc.lng().toFixed(5)})`;
      const descInput = document.getElementById('location-description');
      if (descInput && !descInput.value) descInput.value = results[0].formatted_address;
    } else {
      toast('Adresse introuvable', 'error');
    }
  });
}

function getLocationData() {
  if (!currentLocation) return null;
  const description = (document.getElementById('location-description').value || '').trim();
  return { latitude: currentLocation.latitude, longitude: currentLocation.longitude, description };
}

function resetLocationForm() {
  currentLocation = null;
  const s = document.getElementById('location-search'); if (s) s.value = '';
  const d = document.getElementById('location-description'); if (d) d.value = '';
  const i = document.getElementById('location-info'); if (i) i.textContent = '';
  if (locationMarker) { locationMarker.setMap(null); locationMarker = null; }
}

// ==============================
//  AUDIO RECORDING (webm -> server-side opus)
// ==============================
function tryRecordAudio() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Enregistrement micro indisponible en HTTP. Uploadez un fichier audio (MP3/OGG/M4A/WAV) via "Fichier".', 'info');
    // Open attachments panel to help
    addAddon('attachments');
    setTimeout(() => document.getElementById('file-input')?.click(), 200);
    return;
  }
  toggleAudioRecording();
}

function formatTimer(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function stopAudioRecording() {
  if (audioRecorder && audioRecorder.state === 'recording') {
    audioRecorder.stop();
  }
}

function deleteRecordedAudio() {
  // Remove the file from uploaded files
  if (recordedAudioFile) {
    uploadedFiles = uploadedFiles.filter(f => f.filename !== recordedAudioFile.filename);
    renderFileList();
    recordedAudioFile = null;
  }
  // Revoke the blob URL
  if (recordedAudioBlobUrl) {
    URL.revokeObjectURL(recordedAudioBlobUrl);
    recordedAudioBlobUrl = null;
  }
  document.getElementById('audio-preview').classList.add('hidden');
  document.getElementById('audio-preview-player').src = '';
  toast('Audio supprime', 'info');
}

async function toggleAudioRecording() {
  const btn = document.getElementById('btn-record-audio');
  const recorderUI = document.getElementById('audio-recorder');
  const previewUI = document.getElementById('audio-preview');

  if (audioRecorder && audioRecorder.state === 'recording') {
    audioRecorder.stop();
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return;
  }

  // Clear any previous preview
  if (recordedAudioBlobUrl) {
    URL.revokeObjectURL(recordedAudioBlobUrl);
    recordedAudioBlobUrl = null;
  }
  previewUI.classList.add('hidden');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    audioRecorder = new MediaRecorder(stream);
    audioRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };

    audioRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(audioTimerInterval);
      audioTimerInterval = null;

      recorderUI.classList.add('hidden');
      btn.classList.remove('recording');
      btn.textContent = '🎤 Enregistrer un message audio';

      const mime = audioChunks[0]?.type || 'audio/webm';
      const blob = new Blob(audioChunks, { type: mime });

      // Show local preview immediately
      recordedAudioBlobUrl = URL.createObjectURL(blob);
      const player = document.getElementById('audio-preview-player');
      player.src = recordedAudioBlobUrl;
      previewUI.classList.remove('hidden');

      // Upload and convert server-side
      const form = new FormData();
      form.append('audio', blob, 'voice.webm');
      try {
        const res = await api('/api/upload-audio', { method: 'POST', body: form });
        const data = await res.json();
        if (res.ok) {
          // Remove any previously recorded audio from uploadedFiles
          if (recordedAudioFile) {
            uploadedFiles = uploadedFiles.filter(f => f.filename !== recordedAudioFile.filename);
          }
          recordedAudioFile = data;
          uploadedFiles.push(data);
          renderFileList();
        } else {
          toast(data.error || 'Erreur envoi audio', 'error');
        }
      } catch (err) {
        toast('Erreur: ' + err.message, 'error');
      }
    };

    audioRecorder.start();
    audioStartTime = Date.now();
    btn.classList.add('recording');
    btn.textContent = '⏹ Arreter l\'enregistrement';

    // Show recorder UI with timer
    recorderUI.classList.remove('hidden');
    const timerEl = document.getElementById('audio-rec-timer');
    timerEl.textContent = '00:00';
    audioTimerInterval = setInterval(() => {
      timerEl.textContent = formatTimer(Date.now() - audioStartTime);
    }, 200);
  } catch (err) {
    toast('Micro indisponible: ' + err.message, 'error');
  }
}

// ==============================
//  RECURRENCE / BATCH
// ==============================
function toggleRecurrence() {
  const on = document.getElementById('enable-recurrence').checked;
  document.getElementById('recurrence-form').classList.toggle('hidden', !on);
}

function updateRecurrenceMode() {
  const mode = document.querySelector('input[name="recurrence-mode"]:checked')?.value || 'regular';
  document.getElementById('recurrence-regular').classList.toggle('hidden', mode !== 'regular');
  document.getElementById('recurrence-custom').classList.toggle('hidden', mode !== 'custom');
}

function getRecurrenceData() {
  const enabled = document.getElementById('enable-recurrence')?.checked;
  if (!enabled) return null;
  const mode = document.querySelector('input[name="recurrence-mode"]:checked')?.value || 'regular';
  if (mode !== 'regular') return null; // Mode custom is handled as batch, not recurrence
  return {
    frequency: document.getElementById('recurrence-frequency').value,
    interval: parseInt(document.getElementById('recurrence-interval').value || 1),
    endDate: document.getElementById('recurrence-enddate').value || null,
  };
}

function getBatchData() {
  const enabled = document.getElementById('enable-recurrence')?.checked;
  if (!enabled) return null;
  const mode = document.querySelector('input[name="recurrence-mode"]:checked')?.value;
  if (mode !== 'custom') return null;
  const reference = document.getElementById('batch-reference').value;
  if (!reference) return null;
  const rows = document.querySelectorAll('#batch-offsets-list .batch-offset-row');
  const offsets = [];
  rows.forEach(row => {
    const daysInput = row.querySelector('.bo-days');
    const timeInput = row.querySelector('.bo-time');
    const days = parseInt(daysInput.value || 0);
    const time = timeInput.value || null;
    if (!isNaN(days)) offsets.push({ days, time });
  });
  if (offsets.length === 0) return null;
  return { reference, offsets };
}

function addBatchOffset(defaultDays = -7, defaultTime = '09:00') {
  const list = document.getElementById('batch-offsets-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'batch-offset-row';
  row.innerHTML = `
    <span style="font-size:13px">J</span>
    <input type="number" class="input input-sm bo-days" value="${defaultDays}" style="width:70px">
    <span style="font-size:13px">a</span>
    <input type="time" class="input input-sm bo-time" value="${defaultTime}">
    <button type="button" class="btn btn-xs btn-danger" onclick="this.parentElement.remove()">&times;</button>
  `;
  list.appendChild(row);
}

let mentionAnchorNode = null;
let mentionStartOffset = null;
let mentionCurrentText = '';
let mentionActiveIdx = 0;
let mentionParticipants = [];

function getEditorText(ed) {
  // Convert contenteditable to raw text with @number placeholders + mentions array
  let text = '';
  const mentions = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList && node.classList.contains('mention-chip')) {
        const cid = node.dataset.contactId;
        const num = node.dataset.number;
        if (num) text += '@' + num;
        if (cid && !mentions.includes(cid)) mentions.push(cid);
      } else if (node.tagName === 'BR') {
        text += '\n';
      } else if (node.tagName === 'DIV' && node.parentNode === ed && node !== ed.firstChild) {
        // Each <div> is typically a new line in contenteditable
        text += '\n';
        node.childNodes.forEach(walk);
      } else {
        node.childNodes.forEach(walk);
      }
    }
  };
  ed.childNodes.forEach(walk);
  return { text: text.replace(/\u00A0/g, ' '), mentions };
}

function setEditorFromText(text) {
  // Simple: insert text directly (no mention re-parsing on restore)
  const ed = document.getElementById('message-content');
  if (!ed) return;
  ed.innerHTML = '';
  ed.appendChild(document.createTextNode(text || ''));
}

function onComposeInput(e) {
  detectMentionAtCaret();
}

function onComposeKeydown(e) {
  const dropdown = document.getElementById('mention-dropdown');
  const isOpen = dropdown && !dropdown.classList.contains('hidden');
  if (isOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionActiveIdx = Math.min(mentionParticipants.length - 1, mentionActiveIdx + 1); renderMentionDropdown(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionActiveIdx = Math.max(0, mentionActiveIdx - 1); renderMentionDropdown(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectMention(mentionParticipants[mentionActiveIdx]); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideMentionDropdown(); return; }
  }
}

function detectMentionAtCaret() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return hideMentionDropdown();
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return hideMentionDropdown();
  const text = node.textContent.slice(0, range.startOffset);
  // Allow letters, digits, accents, hyphens, apostrophes, spaces — but stop at punctuation
  // Up to 40 chars after @, can contain spaces (for "Jean-Pierre Dupont")
  const m = text.match(/@([^\n,.!?:;@]{0,40})$/);
  if (!m) return hideMentionDropdown();
  mentionAnchorNode = node;
  mentionStartOffset = range.startOffset - m[0].length;
  mentionCurrentText = m[1].toLowerCase().trim();
  openMentionDropdown();
}

async function openMentionDropdown() {
  // Mentions only make sense in GROUPS. If no group selected, show a helper message.
  const groupRecipients = selectedGroups.filter(g => g.id && g.id.endsWith('@g.us'));
  if (groupRecipients.length === 0) {
    showMentionHint("Les mentions ne fonctionnent que dans les groupes. Selectionnez au moins un groupe destinataire.");
    return;
  }

  // Load participants for selected groups (cache per group)
  const promises = groupRecipients.map(async (g) => {
    if (participantsCache[g.id]) return participantsCache[g.id];
    try {
      const res = await api(`/api/groups/${encodeURIComponent(g.id)}/participants`);
      const data = await res.json();
      participantsCache[g.id] = Array.isArray(data) ? data : [];
      return participantsCache[g.id];
    } catch (_) { return []; }
  });

  const arrays = await Promise.all(promises);
  const all = [].concat(...arrays);
  // Dedupe by id
  const seen = new Set();
  const unique = all.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  // Filter by current text (match all words in order)
  const q = mentionCurrentText.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 0);
  mentionParticipants = unique.filter(p => {
    const haystack = ((p.name || '') + ' ' + (p.number || '')).toLowerCase();
    if (!q) return true;
    return words.every(w => haystack.includes(w));
  }).slice(0, 20);
  mentionActiveIdx = 0;
  renderMentionDropdown();
}

function showMentionHint(msg) {
  const dd = document.getElementById('mention-dropdown');
  if (!dd) return;
  dd.innerHTML = `<div class="mention-item" style="cursor:default;color:var(--text-light);font-size:12px">${escapeHtml(msg)}</div>`;
  const sel = window.getSelection();
  if (sel.rangeCount) {
    const range = sel.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    const ed = document.getElementById('message-content');
    const edRect = ed.getBoundingClientRect();
    dd.style.position = 'absolute';
    dd.style.left = (rect.left - edRect.left + ed.scrollLeft) + 'px';
    dd.style.top = (rect.bottom - edRect.top + ed.scrollTop + 4) + 'px';
  }
  dd.classList.remove('hidden');
  mentionParticipants = [];
}

function renderMentionDropdown() {
  const dd = document.getElementById('mention-dropdown');
  if (!dd) return;
  if (mentionParticipants.length === 0) return hideMentionDropdown();

  dd.innerHTML = mentionParticipants.map((p, i) => `
    <div class="mention-item ${i === mentionActiveIdx ? 'active' : ''}" onmousedown="event.preventDefault();selectMention(mentionParticipants[${i}])">
      <span class="m-name">${escapeHtml(p.name || p.number)}</span>
      <span class="m-number">${escapeHtml(p.number || '')}</span>
    </div>
  `).join('');

  // Position near the caret
  const sel = window.getSelection();
  if (sel.rangeCount) {
    const range = sel.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    const ed = document.getElementById('message-content');
    const edRect = ed.getBoundingClientRect();
    dd.style.position = 'absolute';
    dd.style.left = (rect.left - edRect.left + ed.scrollLeft) + 'px';
    dd.style.top = (rect.bottom - edRect.top + ed.scrollTop + 4) + 'px';
  }
  dd.classList.remove('hidden');
}

function hideMentionDropdown() {
  const dd = document.getElementById('mention-dropdown');
  if (dd) dd.classList.add('hidden');
  mentionAnchorNode = null;
  mentionStartOffset = null;
  mentionCurrentText = '';
  mentionParticipants = [];
}

function selectMention(participant) {
  if (!participant || !mentionAnchorNode || mentionStartOffset == null) return hideMentionDropdown();

  const node = mentionAnchorNode;
  const startOffset = mentionStartOffset;
  const textBefore = node.textContent.slice(0, startOffset);
  const typedLen = 1 /*@*/ + mentionCurrentText.length;
  const textAfter = node.textContent.slice(startOffset + typedLen);

  // Split the text node: before | chip | after
  const parent = node.parentNode;
  const beforeNode = document.createTextNode(textBefore);
  const afterNode = document.createTextNode(textAfter || '\u00A0');
  const chip = document.createElement('span');
  chip.className = 'mention-chip';
  chip.contentEditable = 'false';
  chip.dataset.contactId = participant.id;
  chip.dataset.number = participant.number || '';
  chip.textContent = participant.name || participant.number;

  parent.insertBefore(beforeNode, node);
  parent.insertBefore(chip, node);
  parent.insertBefore(afterNode, node);
  parent.removeChild(node);

  // Place caret after the chip
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(afterNode, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);

  hideMentionDropdown();
}

// Adapted emoji insertion for contenteditable
function insertEmojiAtCaret(emoji) {
  const ed = document.getElementById('message-content');
  if (!ed) return;
  ed.focus();
  const sel = window.getSelection();
  if (!sel.rangeCount) {
    ed.appendChild(document.createTextNode(emoji));
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(document.createTextNode(emoji));
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Wrap selection in contenteditable (for B/I/S format)
function wrapSelectionCE(wrap) {
  const ed = document.getElementById('message-content');
  if (!ed) return;
  ed.focus();
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const selected = range.toString() || 'texte';
  range.deleteContents();
  range.insertNode(document.createTextNode(wrap + selected + wrap));
}

function initFormatToolbars() {
  document.querySelectorAll('.format-toolbar').forEach((toolbar) => {
    if (toolbar.dataset.initialized) return;
    toolbar.dataset.initialized = '1';
    const targetId = toolbar.dataset.target;
    toolbar.querySelectorAll('.fmt-btn').forEach((btn) => {
      if (btn.classList.contains('fmt-emoji')) return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.getElementById(targetId);
        if (!target) return;
        // Contenteditable (message) uses different helpers
        if (target.classList.contains('contenteditable')) {
          if (btn.dataset.wrap) wrapSelectionCE(btn.dataset.wrap);
          else if (btn.dataset.prefix) {
            target.focus();
            document.execCommand('insertText', false, btn.dataset.prefix);
          }
        } else {
          if (btn.dataset.wrap) wrapSelection(target, btn.dataset.wrap);
          else if (btn.dataset.prefix) prefixLines(target, btn.dataset.prefix);
        }
      });
    });
  });
}

// --- File upload ---
function initDropZone() {
  const zone = document.getElementById('drop-zone');
  const input = document.getElementById('file-input');

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });
}

async function handleFiles(fileList) {
  const formData = new FormData();
  for (const file of fileList) {
    if (file.size > 16 * 1024 * 1024) { toast(`"${file.name}" depasse 16 Mo`, 'error'); continue; }
    formData.append('files', file);
  }
  try {
    const res = await api('/api/upload', { method: 'POST', body: formData });
    const files = await res.json();
    if (res.ok) { uploadedFiles.push(...files); renderFileList(); }
    else toast(files.error || 'Erreur upload', 'error');
  } catch (err) { toast('Erreur upload: ' + err.message, 'error'); }
}

function renderFileList() {
  document.getElementById('file-list').innerHTML = uploadedFiles
    .map((f, i) => `<div class="file-item">
      <div><span class="file-name">${escapeHtml(f.originalname)}</span>
      <span class="file-size">${formatSize(f.size)}</span></div>
      <button class="btn btn-xs btn-danger" onclick="removeFile(${i})">Supprimer</button>
    </div>`).join('');
}

function removeFile(index) { uploadedFiles.splice(index, 1); renderFileList(); }

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
  return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
}

// --- Send / Schedule ---
async function sendNow() {
  const payload = buildPayload();
  if (!payload) return;
  const nb = payload.groups.length;
  if (!confirm(`Envoyer ce message maintenant a ${nb} destinataire${nb > 1 ? 's' : ''} ?`)) return;

  // If current draft -> promote it
  if (currentDraftId) {
    const ok = await promoteCurrentDraft(null, true);
    if (ok) { toast('Message envoye !', 'success'); resetForm(); return; }
  }
  payload.send_now = true;
  try {
    const res = await api('/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) { toast('Message envoye !', 'success'); resetForm(); }
    else toast(data.error || 'Erreur', 'error');
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function scheduleMessage() {
  const batch = getBatchData();
  const datetime = document.getElementById('schedule-datetime').value;
  if (!batch && !datetime) { toast('Selectionnez une date et heure (ou activez la planification batch)', 'error'); return; }
  const payload = buildPayload();
  if (!payload) return;

  if (batch) {
    payload.referenceDate = batch.reference;
    payload.offsets = batch.offsets;
    try {
      const res = await api('/api/messages/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        toast(`${data.count} message(s) programme(s)`, 'success');
        resetForm();
      } else {
        toast(data.error || 'Erreur', 'error');
      }
    } catch (err) { toast('Erreur: ' + err.message, 'error'); }
    return;
  }

  payload.scheduled_at = datetime;

  if (currentDraftId && !editingMessageId) {
    const ok = await promoteCurrentDraft(datetime, false);
    if (ok) { toast('Message programme !', 'success'); resetForm(); return; }
  }

  const url = editingMessageId ? `/api/messages/${editingMessageId}` : '/api/messages';
  const method = editingMessageId ? 'PUT' : 'POST';
  try {
    const res = await api(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) { toast(editingMessageId ? 'Message modifie !' : 'Message programme !', 'success'); resetForm(); editingMessageId = null; }
    else toast(data.error || 'Erreur', 'error');
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function buildComposeState() {
  const ed = document.getElementById('message-content');
  const { text, mentions } = ed ? getEditorText(ed) : { text: '', mentions: [] };
  let content = text.trim();

  const attachments = uploadedFiles.map((f) => ({ filename: f.filename, originalname: f.originalname, voice: !!f.voice }));
  let poll = null;
  let location = null;

  if (activeAddons.poll) {
    const p = getPollData();
    if (p.question && p.options.length >= 2) poll = p;
  }
  if (activeAddons.location) {
    const l = getLocationData();
    if (l) {
      location = l;
      // Auto-insert Maps link if checkbox checked
      const insertLink = document.getElementById('location-insert-link')?.checked;
      if (insertLink) {
        const link = googleMapsLink(l.latitude, l.longitude);
        if (!content.includes(link)) {
          content = (content ? content + '\n\n' : '') + link;
        }
      }
    }
  }

  return { content, mentions, attachments, poll, location };
}

function buildPayload() {
  const allRecipients = [...selectedGroups, ...selectedContacts];
  if (allRecipients.length === 0) { toast('Selectionnez au moins un groupe ou un contact', 'error'); return null; }

  const state = buildComposeState();
  const notes = (document.getElementById('message-notes')?.value || '').trim();
  const timezone = document.getElementById('message-timezone')?.value || userTimezone || 'Europe/Paris';

  // Validation by add-ons
  const hasText = !!state.content;
  const hasPoll = !!state.poll;
  const hasLocation = !!state.location;
  const hasAttachments = state.attachments.length > 0;

  if (!hasText && !hasPoll && !hasLocation && !hasAttachments) {
    toast('Ajoutez du contenu (texte, sondage, localisation ou fichier)', 'error');
    return null;
  }

  // Poll partial validation
  if (activeAddons.poll) {
    const p = getPollData();
    if (!p.question) { toast('Question du sondage requise', 'error'); return null; }
    if (p.options.length < 2) { toast('Au moins 2 options pour le sondage', 'error'); return null; }
  }
  if (activeAddons.location && !state.location) {
    toast('Selectionnez un emplacement sur la carte', 'error'); return null;
  }

  // Determine primary type
  let type = 'text';
  if (hasLocation) type = 'location';
  else if (hasPoll && !hasText && !hasAttachments) type = 'poll'; // pure poll
  // Note: when hasPoll AND hasText, we send them as 2 messages — scheduler handles via type+extraPoll

  return {
    groups: allRecipients,
    content: state.content,
    attachments: state.attachments,
    notes,
    tags: [...selectedTags],
    mentions: state.mentions,
    timezone,
    type,
    poll: state.poll,
    location: state.location,
    recurrence: getRecurrenceData(),
  };
}

function resetForm() {
  // Wrap each step in try/catch so an error in one step doesn't break the rest
  const safe = (fn, label) => { try { fn(); } catch (e) { console.error('resetForm:' + label, e); } };

  // Core state
  selectedGroups = [];
  selectedContacts = [];
  uploadedFiles = [];
  selectedTags = [];
  editingMessageId = null;
  currentDraftId = null;
  currentLocation = null;

  // Compose editor
  safe(() => {
    const ed = document.getElementById('message-content');
    if (ed) { ed.innerHTML = ''; ed.textContent = ''; }
  }, 'editor');

  // Inputs
  safe(() => { const dt = document.getElementById('schedule-datetime'); if (dt) dt.value = ''; }, 'datetime');
  safe(() => { const el = document.getElementById('group-search'); if (el) el.value = ''; }, 'group-search');
  safe(() => { const el = document.getElementById('contact-search'); if (el) el.value = ''; }, 'contact-search');
  safe(() => { const el = document.getElementById('message-preview'); if (el) el.classList.add('hidden'); }, 'preview');
  safe(() => { const el = document.getElementById('message-notes'); if (el) el.value = ''; }, 'notes');
  safe(() => { const tz = document.getElementById('message-timezone'); if (tz) tz.value = userTimezone || 'Europe/Paris'; }, 'tz');
  safe(() => { const fi = document.getElementById('file-input'); if (fi) fi.value = ''; }, 'file-input');
  safe(() => { const fl = document.getElementById('file-list'); if (fl) fl.innerHTML = ''; }, 'file-list');

  // Tags
  safe(() => renderTagsSelector(), 'tags');

  // Lists
  safe(() => renderGroups(), 'groups');
  safe(() => renderContacts(), 'contacts');
  safe(() => renderFileList(), 'files');

  // Add-ons
  safe(() => {
    ['attachments', 'poll', 'location'].forEach(t => {
      activeAddons[t] = false;
      const el = document.getElementById('addon-' + t);
      if (el) el.classList.add('hidden');
    });
  }, 'addons');

  // Poll
  safe(() => {
    const q = document.getElementById('poll-question'); if (q) q.value = '';
    const m = document.getElementById('poll-multi'); if (m) m.checked = false;
    const o = document.getElementById('poll-options'); if (o) o.innerHTML = '';
  }, 'poll');

  // Location
  safe(() => {
    const s = document.getElementById('location-search'); if (s) s.value = '';
    const d = document.getElementById('location-description'); if (d) d.value = '';
    const i = document.getElementById('location-info'); if (i) i.textContent = '';
    if (locationMarker) { try { locationMarker.setMap(null); } catch (_) {} locationMarker = null; }
  }, 'location');

  // Recurrence
  safe(() => {
    const recCb = document.getElementById('enable-recurrence');
    if (recCb) { recCb.checked = false; toggleRecurrence(); }
    const batchRef = document.getElementById('batch-reference'); if (batchRef) batchRef.value = '';
    const offsetList = document.getElementById('batch-offsets-list'); if (offsetList) offsetList.innerHTML = '';
    const regularRadio = document.querySelector('input[name="recurrence-mode"][value="regular"]');
    if (regularRadio) { regularRadio.checked = true; updateRecurrenceMode(); }
  }, 'recurrence');

  // Quick schedule
  safe(() => renderQuickSchedule(), 'quick-schedule');

  // Live preview
  safe(() => updateLivePreview(), 'live-preview');

  // Exit template mode
  safe(() => exitTemplateMode(), 'template-mode');

  // Audio preview
  safe(() => {
    if (recordedAudioBlobUrl) { URL.revokeObjectURL(recordedAudioBlobUrl); recordedAudioBlobUrl = null; }
    recordedAudioFile = null;
    const ap = document.getElementById('audio-preview'); if (ap) ap.classList.add('hidden');
    const app = document.getElementById('audio-preview-player'); if (app) app.src = '';
    const ar = document.getElementById('audio-recorder'); if (ar) ar.classList.add('hidden');
    const btnA = document.getElementById('btn-record-audio');
    if (btnA) { btnA.classList.remove('recording'); btnA.textContent = '🎤 Enregistrer un message audio'; }
  }, 'audio');

  console.log('[resetForm] done');
}

// --- Queue ---
let queueCache = [];

async function loadQueue() {
  try {
    const res = await api('/api/messages');
    queueCache = await res.json();
    renderQueueFilterTagsChips();
    renderQueueFiltered();
  } catch (err) { console.error('Failed to load queue:', err); }
}

function renderQueueFilterTagsChips() {
  const container = document.getElementById('queue-filter-tags');
  if (!container) return;
  if (!filterState.queue.tags) filterState.queue.tags = [];
  if (availableTags.length === 0) { container.innerHTML = '<span style="font-size:11px;color:var(--text-light)">Aucun tag defini</span>'; return; }
  container.innerHTML = availableTags.map(t => {
    const active = filterState.queue.tags.includes(t.name);
    return `<span class="tag-pill ${active ? 'selected' : ''}" style="background:${tagColor(t.name)}" onclick="toggleQueueFilterTag('${escapeHtml(t.name).replace(/'/g, '&#39;')}')">#${escapeHtml(t.name)}</span>`;
  }).join('');
}

function toggleQueueFilterTag(name) {
  const arr = filterState.queue.tags = filterState.queue.tags || [];
  const i = arr.indexOf(name);
  if (i >= 0) arr.splice(i, 1); else arr.push(name);
  renderQueueFilterTagsChips();
  renderQueueFiltered();
}

function resetQueueFilters() {
  filterState.queue = { tags: [] };
  document.getElementById('queue-filter-text').value = '';
  document.getElementById('queue-filter-recipient').value = '';
  document.getElementById('queue-filter-from').value = '';
  document.getElementById('queue-filter-to').value = '';
  renderQueueFilterTagsChips();
  renderQueueFiltered();
}

function renderQueueFiltered() {
  const text = (document.getElementById('queue-filter-text')?.value || '').toLowerCase();
  const recipient = (document.getElementById('queue-filter-recipient')?.value || '').toLowerCase();
  const from = document.getElementById('queue-filter-from')?.value || '';
  const to = document.getElementById('queue-filter-to')?.value || '';
  const tagsFilter = filterState.queue.tags || [];

  const messages = queueCache.filter((m) => {
    if (text && !(m.content || '').toLowerCase().includes(text)) return false;
    if (recipient && !(m.groups || []).some(g => (g.name || '').toLowerCase().includes(recipient))) return false;
    if (from && (m.scheduled_at || '') < from) return false;
    if (to && (m.scheduled_at || '') > (to + 'T23:59:59')) return false;
    if (tagsFilter.length && !(m.tags || []).some(t => tagsFilter.includes(t))) return false;
    return true;
  });

  const container = document.getElementById('queue-list');
  if (messages.length === 0) { container.innerHTML = '<p class="empty">Aucun message dans la file (ou filtres trop restrictifs).</p>'; return; }

  container.innerHTML = messages.map((m) => {
    const tags = Array.isArray(m.tags) ? m.tags : [];
    return `
    <div class="queue-item">
      <div class="queue-item-header">
        <span class="date">${formatDate(m.scheduled_at, m.timezone)}</span>
        <span style="font-size:12px;color:var(--text-light)">#${m.id}</span>
      </div>
      <div class="queue-item-groups">
        ${m.groups.map((g) => `<span class="group-tag">${escapeHtml(g.name)}</span>`).join('')}
      </div>
      <div class="queue-item-content">${escapeHtml(m.content).substring(0, 200)}</div>
      ${m.attachments.length > 0 ? `<div style="font-size:12px;color:var(--text-light)">&#128206; ${m.attachments.length} piece(s) jointe(s)</div>` : ''}
      ${tags.length > 0 ? `<div class="message-tags">${tags.map(t => `<span class="message-tag" style="background:${tagColor(t)}">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      ${m.notes ? `<div style="font-size:12px;color:#7d6608;background:#fef9e7;padding:6px 8px;border-radius:4px;margin-top:6px">&#128221; ${escapeHtml(m.notes)}</div>` : ''}
      <div class="queue-item-actions">
        <button class="btn btn-sm" onclick='openPreviewFromQueue(${m.id})'>Apercu</button>
        <button class="btn btn-sm" onclick="editQueueMessage(${m.id})">Modifier</button>
        <button class="btn btn-sm" onclick='duplicateQueueMessage(${m.id})'>Dupliquer</button>
        <button class="btn btn-sm btn-primary" onclick="sendQueueMessage(${m.id})">Envoyer maintenant</button>
        <button class="btn btn-sm btn-danger" onclick="deleteQueueMessage(${m.id})">Supprimer</button>
      </div>
    </div>`;
  }).join('');
}

function fillComposeFromMessage(msg, { keepId = false, keepDate = true } = {}) {
  // Reset first
  resetAddons();
  selectedGroups = Array.isArray(msg.groups) ? [...msg.groups] : [];
  selectedContacts = [];
  uploadedFiles = Array.isArray(msg.attachments) ? [...msg.attachments] : [];
  setEditorFromText(msg.content || '');
  const dt = document.getElementById('schedule-datetime');
  if (keepDate && msg.scheduled_at) dt.value = String(msg.scheduled_at).slice(0, 16);
  else dt.value = '';
  const notesEl = document.getElementById('message-notes');
  if (notesEl) notesEl.value = msg.notes || '';
  selectedTags = Array.isArray(msg.tags) ? [...msg.tags] : [];
  renderTagsSelector();
  const tzSel = document.getElementById('message-timezone');
  if (tzSel) tzSel.value = msg.timezone || userTimezone || 'Europe/Paris';
  editingMessageId = keepId ? msg.id : null;

  // Restore add-ons
  if (uploadedFiles.length > 0) {
    activeAddons.attachments = true;
    document.getElementById('addon-attachments').classList.remove('hidden');
  }
  if (msg.poll) {
    activeAddons.poll = true;
    document.getElementById('addon-poll').classList.remove('hidden');
    document.getElementById('poll-question').value = msg.poll.question || '';
    document.getElementById('poll-multi').checked = !!msg.poll.allowMultipleAnswers;
    const container = document.getElementById('poll-options');
    container.innerHTML = '';
    (msg.poll.options || []).forEach(opt => {
      addPollOption();
      const last = container.lastElementChild.querySelector('.poll-option-input');
      if (last) last.value = opt;
    });
  }
  if (msg.location) {
    activeAddons.location = true;
    document.getElementById('addon-location').classList.remove('hidden');
    currentLocation = { ...msg.location };
    const descInput = document.getElementById('location-description');
    if (descInput) descInput.value = msg.location.description || '';
    loadGoogleMaps().then(() => initLocationMap()).catch(() => {});
  }

  // Recurrence
  if (msg.recurrence) {
    document.getElementById('enable-recurrence').checked = true;
    toggleRecurrence();
    document.querySelector('input[name="recurrence-mode"][value="regular"]').checked = true;
    updateRecurrenceMode();
    document.getElementById('recurrence-interval').value = msg.recurrence.interval || 1;
    document.getElementById('recurrence-frequency').value = msg.recurrence.frequency || 'weekly';
    document.getElementById('recurrence-enddate').value = msg.recurrence.endDate || '';
  }

  renderGroups(); renderContacts(); renderFileList();
  renderQuickSchedule();
  updateLivePreview();

  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  document.querySelector('[data-section="compose"]').classList.add('active');
  document.querySelectorAll('.section').forEach((s) => s.classList.add('hidden'));
  document.getElementById('section-compose').classList.remove('hidden');
}

async function editQueueMessage(id) {
  try {
    const res = await api(`/api/messages/${id}`);
    const msg = await res.json();
    fillComposeFromMessage(msg, { keepId: true, keepDate: true });
    toast('Message charge pour modification', 'info');
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function duplicateQueueMessage(id) {
  try {
    const res = await api(`/api/messages/${id}`);
    const msg = await res.json();
    fillComposeFromMessage(msg, { keepId: false, keepDate: false });
    toast('Message duplique — ajustez et programmez', 'info');
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function duplicateHistoryMessage(idx) {
  const rows = window._historyRows || [];
  const row = rows[idx];
  if (!row) return;
  fillComposeFromMessage({
    groups: [{ id: row.group_id, name: row.group_name }],
    attachments: row.attachments || [],
    content: row.content || '',
    notes: row.notes || '',
    tags: row.tags || [],
  }, { keepId: false, keepDate: false });
  toast('Message duplique depuis l\'historique', 'info');
}

// --- Preview modal ---
function openPreviewModal({ scheduledAt, sentAt, status, recipients, content, attachments, notes, tags, timezone }) {
  const modal = document.getElementById('preview-modal');
  const meta = document.getElementById('preview-modal-meta');
  const body = document.getElementById('preview-modal-body');
  const atts = document.getElementById('preview-modal-attachments');
  const notesEl = document.getElementById('preview-modal-notes');

  const parts = [];
  if (scheduledAt) parts.push(`<strong>Programme :</strong> ${formatDate(scheduledAt, timezone)}`);
  if (sentAt) parts.push(`<strong>Envoye :</strong> ${formatDate(sentAt, timezone)}`);
  if (status) parts.push(`<strong>Statut :</strong> <span class="status-${status}">${status === 'sent' ? 'Envoye' : status === 'error' ? 'Erreur' : status}</span>`);
  if (timezone) parts.push(`<strong>Fuseau :</strong> ${escapeHtml(timezone)}`);
  if (recipients && recipients.length) parts.push(`<strong>Destinataire(s) :</strong> ${recipients.map(escapeHtml).join(', ')}`);
  if (tags && tags.length) parts.push(`<strong>Tags :</strong> ${tags.map(t => '<span class="message-tag" style="background:' + tagColor(t) + '">#' + escapeHtml(t) + '</span>').join(' ')}`);
  meta.innerHTML = parts.join(' &middot; ');

  body.innerHTML = formatWhatsApp(content || '');

  if (attachments && attachments.length) {
    atts.innerHTML = attachments.map(a => `<div class="preview-attachment">&#128206; ${escapeHtml(a.originalname || a.filename)}</div>`).join('');
  } else {
    atts.innerHTML = '';
  }

  if (notes && notes.trim()) {
    notesEl.textContent = '[Notes internes] ' + notes;
    notesEl.classList.remove('hidden');
  } else {
    notesEl.classList.add('hidden');
  }

  modal.classList.remove('hidden');
}

function closePreviewModal() {
  document.getElementById('preview-modal').classList.add('hidden');
}

async function openPreviewFromQueue(id) {
  try {
    const res = await api(`/api/messages/${id}`);
    const m = await res.json();
    openPreviewModal({
      scheduledAt: m.scheduled_at,
      status: m.status,
      recipients: (m.groups || []).map(g => g.name),
      content: m.content,
      attachments: m.attachments,
      notes: m.notes,
      tags: m.tags,
      timezone: m.timezone,
    });
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function openPreviewFromHistory(idx) {
  const rows = window._historyRows || [];
  const r = rows[idx];
  if (!r) return;
  openPreviewModal({
    sentAt: r.sent_at,
    status: r.status,
    recipients: [r.group_name],
    content: r.content,
    attachments: r.attachments,
    notes: r.notes,
    tags: r.tags,
    timezone: r.timezone,
  });
}

async function sendQueueMessage(id) {
  try {
    const res = await api(`/api/messages/${id}/send`, { method: 'POST' });
    if (res.ok) { toast('Envoi lance !', 'success'); loadQueue(); }
    else { const data = await res.json(); toast(data.error || 'Erreur', 'error'); }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function deleteQueueMessage(id) {
  if (!confirm('Supprimer ce message programme ?')) return;
  try {
    const res = await api(`/api/messages/${id}`, { method: 'DELETE' });
    if (res.ok) { toast('Message supprime', 'success'); loadQueue(); }
    else { const data = await res.json(); toast(data.error || 'Erreur', 'error'); }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

// --- Templates ---
async function loadTemplatesList() {
  try {
    const res = await api('/api/templates');
    templates = await res.json();
    renderTemplates();
  } catch (err) { console.error('Failed to load templates:', err); }
}

function renderTemplates() {
  const grid = document.getElementById('templates-grid');
  if (templates.length === 0) {
    grid.innerHTML = '<p style="color:var(--text-light);font-style:italic">Aucun template. Creez-en un !</p>';
    return;
  }
  grid.innerHTML = templates.map((t) => {
    const attCount = Array.isArray(t.attachments) ? t.attachments.length : 0;
    return `
    <div class="template-card">
      <h3>${escapeHtml(t.title)}</h3>
      <div class="preview">${escapeHtml(t.content).substring(0, 120)}</div>
      ${attCount > 0 ? `<div style="font-size:12px;color:var(--text-light);margin-bottom:8px">&#128206; ${attCount} piece(s) jointe(s)</div>` : ''}
      <div class="actions">
        <button class="btn btn-sm" onclick="editTemplate(${t.id})">Modifier</button>
        <button class="btn btn-sm" onclick="duplicateTemplate(${t.id})">Dupliquer</button>
        <button class="btn btn-sm btn-danger" onclick="deleteTemplate(${t.id})">Supprimer</button>
      </div>
    </div>`;
  }).join('');
}

// Legacy — kept so old calls don't break
function showTemplateForm() { newTemplate(); }

function hideTemplateForm() {
  document.getElementById('template-form').classList.add('hidden');
  tplAttachments = [];
}

function renderTplFileList() {
  const container = document.getElementById('tpl-file-list');
  if (!container) return;
  container.innerHTML = tplAttachments
    .map((f, i) => `<div class="file-item">
      <div><span class="file-name">${escapeHtml(f.originalname)}</span>
      ${f.size ? `<span class="file-size">${formatSize(f.size)}</span>` : ''}</div>
      <button class="btn btn-xs btn-danger" onclick="removeTplFile(${i})">Supprimer</button>
    </div>`).join('');
}

function removeTplFile(index) {
  tplAttachments.splice(index, 1);
  renderTplFileList();
}

async function handleTplFiles(fileList) {
  const formData = new FormData();
  for (const file of fileList) {
    if (file.size > 16 * 1024 * 1024) { toast(`"${file.name}" depasse 16 Mo`, 'error'); continue; }
    formData.append('files', file);
  }
  try {
    const res = await api('/api/upload', { method: 'POST', body: formData });
    const files = await res.json();
    if (res.ok) { tplAttachments.push(...files); renderTplFileList(); }
    else toast(files.error || 'Erreur upload', 'error');
  } catch (err) { toast('Erreur upload: ' + err.message, 'error'); }
}

function initTplDropZone() {
  const zone = document.getElementById('tpl-drop-zone');
  const input = document.getElementById('tpl-file-input');
  if (!zone || !input) return;
  if (zone.dataset.initialized) return;
  zone.dataset.initialized = '1';
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); handleTplFiles(e.dataTransfer.files); });
  input.addEventListener('change', () => { handleTplFiles(input.files); input.value = ''; });
}

async function saveTemplate() {
  const editId = document.getElementById('template-edit-id').value;
  const title = document.getElementById('tpl-title').value.trim();
  const content = document.getElementById('tpl-content').value.trim();
  if (!title || !content) { toast('Titre et contenu requis', 'error'); return; }
  const attachments = tplAttachments.map((f) => ({ filename: f.filename, originalname: f.originalname }));
  const url = editId ? `/api/templates/${editId}` : '/api/templates';
  const method = editId ? 'PUT' : 'POST';
  try {
    const res = await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, variables: [], attachments }) });
    if (res.ok) { toast(editId ? 'Template modifie !' : 'Template cree !', 'success'); hideTemplateForm(); loadTemplatesList(); }
    else { const data = await res.json(); toast(data.error || 'Erreur', 'error'); }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function editTemplate(id) {
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return;
  // Pre-fill compose editor with full template
  fillComposeFromMessage({
    groups: [],
    content: tpl.content,
    attachments: tpl.attachments || [],
    notes: tpl.notes,
    tags: tpl.tags,
    mentions: tpl.mentions,
    timezone: tpl.timezone,
    type: tpl.type,
    poll: tpl.poll,
    location: tpl.location,
    recurrence: tpl.recurrence,
  }, { keepId: false, keepDate: false });
  enterTemplateMode(id, tpl.title);
}

function newTemplate() {
  resetForm();
  enterTemplateMode(null, '');
}

function enterTemplateMode(templateId, title) {
  document.getElementById('compose-title').textContent = templateId ? 'Modifier template' : 'Nouveau template';
  document.getElementById('template-title-block').classList.remove('hidden');
  document.getElementById('template-save-block').classList.remove('hidden');
  document.getElementById('send-options-block').classList.add('hidden');
  document.getElementById('template-title').value = title || '';
  document.getElementById('template-edit-id').value = templateId || '';

  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const navCompose = document.querySelector('[data-section="compose"]');
  if (navCompose) navCompose.classList.add('active');
  document.querySelectorAll('.section').forEach((s) => s.classList.add('hidden'));
  document.getElementById('section-compose').classList.remove('hidden');
}

function exitTemplateMode() {
  document.getElementById('compose-title').textContent = 'Nouveau message';
  document.getElementById('template-title-block').classList.add('hidden');
  document.getElementById('template-save-block').classList.add('hidden');
  document.getElementById('send-options-block').classList.remove('hidden');
  document.getElementById('template-title').value = '';
  document.getElementById('template-edit-id').value = '';
}

function cancelTemplateEdit() {
  exitTemplateMode();
  resetForm();
  // Go back to templates section
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  document.querySelector('[data-section="templates"]').classList.add('active');
  document.querySelectorAll('.section').forEach((s) => s.classList.add('hidden'));
  document.getElementById('section-templates').classList.remove('hidden');
  loadTemplatesList();
}

async function saveTemplateFromCompose() {
  const title = (document.getElementById('template-title').value || '').trim();
  if (!title) { toast('Titre requis', 'error'); return; }
  const editId = document.getElementById('template-edit-id').value;

  const state = buildComposeState();
  const notes = (document.getElementById('message-notes')?.value || '').trim();
  const timezone = document.getElementById('message-timezone')?.value || userTimezone || 'Europe/Paris';
  const payload = {
    title,
    content: state.content,
    attachments: state.attachments,
    tags: [...selectedTags],
    mentions: state.mentions,
    notes,
    timezone,
    type: state.location ? 'location' : (state.poll && !state.content && !state.attachments.length ? 'poll' : 'text'),
    poll: state.poll,
    location: state.location,
    recurrence: getRecurrenceData(),
  };

  const url = editId ? `/api/templates/${editId}` : '/api/templates';
  const method = editId ? 'PUT' : 'POST';
  try {
    const res = await api(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      toast(editId ? 'Template modifie' : 'Template cree', 'success');
      cancelTemplateEdit();
    } else {
      toast(data.error || 'Erreur', 'error');
    }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function duplicateTemplate(id) {
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return;
  try {
    const res = await api('/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: tpl.title + ' (copie)',
        content: tpl.content,
        variables: [],
        attachments: tpl.attachments || [],
      }),
    });
    if (res.ok) { toast('Template duplique !', 'success'); loadTemplatesList(); }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function deleteTemplate(id) {
  if (!confirm('Supprimer ce template ?')) return;
  try {
    const res = await api(`/api/templates/${id}`, { method: 'DELETE' });
    if (res.ok) { toast('Template supprime', 'success'); loadTemplatesList(); }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

// --- History ---
let historyCache = [];

async function loadHistory() {
  try {
    const res = await api('/api/history');
    historyCache = await res.json();
    window._historyRows = historyCache;
    renderHistoryFilterTagsChips();
    renderHistoryFiltered();
  } catch (err) { console.error('Failed to load history:', err); }
}

function renderHistoryFilterTagsChips() {
  const container = document.getElementById('history-filter-tags');
  if (!container) return;
  if (!filterState.history.tags) filterState.history.tags = [];
  if (availableTags.length === 0) { container.innerHTML = '<span style="font-size:11px;color:var(--text-light)">Aucun tag defini</span>'; return; }
  container.innerHTML = availableTags.map(t => {
    const active = filterState.history.tags.includes(t.name);
    return `<span class="tag-pill ${active ? 'selected' : ''}" style="background:${tagColor(t.name)}" onclick="toggleHistoryFilterTag('${escapeHtml(t.name).replace(/'/g, '&#39;')}')">#${escapeHtml(t.name)}</span>`;
  }).join('');
}

function toggleHistoryFilterTag(name) {
  const arr = filterState.history.tags = filterState.history.tags || [];
  const i = arr.indexOf(name);
  if (i >= 0) arr.splice(i, 1); else arr.push(name);
  renderHistoryFilterTagsChips();
  renderHistoryFiltered();
}

function resetHistoryFilters() {
  filterState.history = { tags: [] };
  document.getElementById('history-filter-text').value = '';
  document.getElementById('filter-group').value = '';
  document.getElementById('filter-status').value = '';
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  renderHistoryFilterTagsChips();
  renderHistoryFiltered();
}

function renderHistoryFiltered() {
  const text = (document.getElementById('history-filter-text')?.value || '').toLowerCase();
  const group = (document.getElementById('filter-group')?.value || '').toLowerCase();
  const status = document.getElementById('filter-status')?.value || '';
  const from = document.getElementById('filter-from')?.value || '';
  const to = document.getElementById('filter-to')?.value || '';
  const tagsFilter = filterState.history.tags || [];

  const rows = historyCache.filter((r) => {
    if (text && !(r.content || '').toLowerCase().includes(text)) return false;
    if (group && !(r.group_name || '').toLowerCase().includes(group)) return false;
    if (status && r.status !== status) return false;
    if (from && (r.sent_at || '') < from) return false;
    if (to && (r.sent_at || '') > (to + 'T23:59:59')) return false;
    if (tagsFilter.length && !(r.tags || []).some(t => tagsFilter.includes(t))) return false;
    return true;
  });

  const tbody = document.getElementById('history-body');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-light)">Aucun envoi (ou filtres trop restrictifs)</td></tr>';
    return;
  }
  window._historyRows = rows;

  tbody.innerHTML = rows.map((r, idx) => `
    <tr>
      <td>${formatDate(r.sent_at, r.timezone)}</td>
      <td style="font-size:11px;color:var(--text-light)">${escapeHtml(tzShort(r.timezone || 'Europe/Paris'))}</td>
      <td>${escapeHtml(r.group_name)}</td>
      <td>${escapeHtml((r.content || '').substring(0, 80))}</td>
      <td class="status-${r.status}">${r.status === 'sent' ? 'Envoye' : 'Erreur'}</td>
      <td>${escapeHtml(r.error || '-')}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-xs" onclick="openPreviewFromHistory(${idx})">Apercu</button>
        <button class="btn btn-xs" onclick="duplicateHistoryMessage(${idx})">Dupliquer</button>
        ${r.status === 'error' ? `<button class="btn btn-xs btn-primary" onclick="retryFromHistory(${r.id})">Relancer</button>` : ''}
      </td>
    </tr>`).join('');
}

async function retryFromHistory(sendLogId) {
  if (!confirm('Relancer cet envoi ?')) return;
  try {
    const res = await api(`/api/history/${sendLogId}/retry`, { method: 'POST' });
    if (res.ok) {
      toast('Envoi relance !', 'success');
      loadHistory();
    } else {
      const d = await res.json();
      toast(d.error || 'Erreur', 'error');
    }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function exportCSV() {
  const params = new URLSearchParams();
  const group = document.getElementById('filter-group').value;
  const status = document.getElementById('filter-status').value;
  const from = document.getElementById('filter-from').value;
  const to = document.getElementById('filter-to').value;
  if (group) params.set('group_name', group);
  if (status) params.set('status', status);
  if (from) params.set('date_from', from);
  if (to) params.set('date_to', to);
  // For CSV export, we need to pass the user ID as query param since it's a direct link
  params.set('_userId', currentUserId);
  window.open(`/api/history/export?${params}`, '_blank');
}

// --- Utilities ---
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function formatDate(dateStr, tz) {
  // Our dates are stored as local time in the message's timezone (format "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS")
  // No timezone suffix — parsing with Date() would be ambiguous.
  // We parse manually for accurate display without shifting.
  if (!dateStr) return '-';
  const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return dateStr;
  const base = `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  if (tz && tz !== userTimezone) {
    // Show short TZ code to distinguish from default
    return `${base} (${tzShort(tz)})`;
  }
  return base;
}

function tzShort(tz) {
  if (!tz) return '';
  const parts = tz.split('/');
  return parts[parts.length - 1].replace(/_/g, ' ');
}

// ==============================
//  DRAFTS
// ==============================
function hasDraftableContent() {
  const ed = document.getElementById('message-content');
  if (!ed) return false;
  const { text } = getEditorText(ed);
  return text.trim().length > 0 || uploadedFiles.length > 0 || selectedGroups.length > 0 || selectedContacts.length > 0;
}

async function saveAsTemplate() {
  const title = prompt('Nom du template ?');
  if (!title || !title.trim()) return;
  const state = buildComposeState();
  const notes = (document.getElementById('message-notes')?.value || '').trim();
  const timezone = document.getElementById('message-timezone')?.value || userTimezone || 'Europe/Paris';
  const payload = {
    title: title.trim(),
    content: state.content,
    attachments: state.attachments,
    tags: [...selectedTags],
    mentions: state.mentions,
    notes,
    timezone,
    type: state.poll && !state.content && !state.attachments.length ? 'poll' : (state.location ? 'location' : 'text'),
    poll: state.poll,
    location: state.location,
    recurrence: getRecurrenceData(),
  };
  try {
    const res = await api('/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      toast('Template cree !', 'success');
      loadTemplatesList();
    } else {
      toast(data.error || 'Erreur', 'error');
    }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function saveAsDraft(silent = false) {
  if (!hasDraftableContent()) {
    if (!silent) toast('Rien a enregistrer', 'info');
    return null;
  }
  const ed = document.getElementById('message-content');
  const { text, mentions } = getEditorText(ed);
  const timezone = document.getElementById('message-timezone')?.value || userTimezone || 'Europe/Paris';
  const payload = {
    groups: [...selectedGroups, ...selectedContacts],
    content: text,
    attachments: uploadedFiles.map(f => ({ filename: f.filename, originalname: f.originalname })),
    notes: (document.getElementById('message-notes')?.value || '').trim(),
    tags: [...selectedTags],
    mentions,
    timezone,
  };
  try {
    let res;
    if (currentDraftId) {
      res = await api(`/api/drafts/${currentDraftId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    } else {
      res = await api('/api/drafts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        currentDraftId = data.id;
      }
    }
    if (res.ok) {
      if (!silent) toast('Brouillon enregistre', 'success');
      return currentDraftId;
    } else {
      const d = await res.json();
      if (!silent) toast(d.error || 'Erreur', 'error');
    }
  } catch (err) {
    if (!silent) toast('Erreur: ' + err.message, 'error');
  }
  return null;
}

function startAutoSave() {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  autoSaveTimer = setInterval(() => {
    if (hasDraftableContent()) saveAsDraft(true);
  }, 30000);
}

async function loadDrafts() {
  try {
    const res = await api('/api/drafts');
    const drafts = await res.json();
    const container = document.getElementById('drafts-list');
    if (!drafts || drafts.length === 0) {
      container.innerHTML = '<p class="empty">Aucun brouillon.</p>';
      return;
    }
    container.innerHTML = drafts.map((d) => {
      const tags = Array.isArray(d.tags) ? d.tags : [];
      return `
      <div class="queue-item">
        <div class="queue-item-header">
          <span class="date">${formatDate(d.created_at)}</span>
          <span style="font-size:12px;color:var(--text-light)">#${d.id}</span>
        </div>
        <div class="queue-item-groups">
          ${(d.groups || []).map((g) => `<span class="group-tag">${escapeHtml(g.name)}</span>`).join('')}
        </div>
        <div class="queue-item-content">${escapeHtml(d.content || '').substring(0, 200) || '<em style="color:var(--text-light)">(vide)</em>'}</div>
        ${d.attachments && d.attachments.length ? `<div style="font-size:12px;color:var(--text-light)">&#128206; ${d.attachments.length} piece(s) jointe(s)</div>` : ''}
        ${tags.length > 0 ? `<div class="message-tags">${tags.map(t => `<span class="message-tag" style="background:${tagColor(t)}">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        ${d.notes ? `<div style="font-size:12px;color:#7d6608;background:#fef9e7;padding:6px 8px;border-radius:4px;margin-top:6px">&#128221; ${escapeHtml(d.notes)}</div>` : ''}
        <div class="queue-item-actions">
          <button class="btn btn-sm btn-primary" onclick="editDraft(${d.id})">Reprendre</button>
          <button class="btn btn-sm btn-danger" onclick="deleteDraft(${d.id})">Supprimer</button>
        </div>
      </div>`;
    }).join('');
  } catch (err) { console.error('Failed to load drafts:', err); }
}

async function editDraft(id) {
  try {
    const res = await api('/api/drafts');
    const drafts = await res.json();
    const d = drafts.find(x => x.id === id);
    if (!d) return;
    fillComposeFromMessage(d, { keepId: false, keepDate: false });
    currentDraftId = id;
    toast('Brouillon charge — modifications auto-sauvegardees', 'info');
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

async function deleteDraft(id) {
  if (!confirm('Supprimer ce brouillon ?')) return;
  try {
    const res = await api(`/api/drafts/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (currentDraftId === id) currentDraftId = null;
      toast('Brouillon supprime', 'success');
      loadDrafts();
    }
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

// If user has a current draft and calls send/schedule, promote it instead of creating a new message
async function promoteCurrentDraft(scheduledAt, sendNow) {
  if (!currentDraftId) return false;
  try {
    // First sync draft with current form state
    await saveAsDraft(true);
    const res = await api(`/api/drafts/${currentDraftId}/promote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduled_at: scheduledAt, send_now: !!sendNow }),
    });
    if (res.ok) {
      currentDraftId = null;
      return true;
    }
  } catch (_) {}
  return false;
}

function toast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) { container = document.createElement('div'); container.className = 'toast-container'; document.body.appendChild(container); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 4000);
}
