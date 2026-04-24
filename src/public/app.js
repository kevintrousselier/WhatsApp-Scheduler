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

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initDropZone();
  initFormatToolbars();
  initKeyboardShortcuts();

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
  document.getElementById('selected-groups').innerHTML = selectedGroups
    .map((g) => `<span class="group-tag">${escapeHtml(g.name)} <span class="remove" onclick="removeGroup('${g.id}')">&times;</span></span>`)
    .join('');
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
    .map((c) => `<span class="group-tag">${escapeHtml(c.name)} <span class="remove" onclick="removeContact('${c.id}')">&times;</span></span>`)
    .join('');
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
    if (tpl) {
      document.getElementById('message-content').value = tpl.content;
      if (Array.isArray(tpl.attachments) && tpl.attachments.length > 0) {
        // Merge template attachments into compose uploads (avoid duplicates)
        const existingNames = new Set(uploadedFiles.map((f) => f.filename));
        for (const att of tpl.attachments) {
          if (!existingNames.has(att.filename)) uploadedFiles.push(att);
        }
        renderFileList();
        toast(`${tpl.attachments.length} piece(s) jointe(s) chargee(s) depuis le template`, 'info');
      }
    }
  } catch (err) { console.error('Failed to load template:', err); }
}

// --- Preview ---
function togglePreview() {
  const preview = document.getElementById('message-preview');
  const content = document.getElementById('message-content').value;
  if (preview.classList.contains('hidden')) {
    preview.innerHTML = formatWhatsApp(content);
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

  // Position near the button
  const wrapper = btn.closest('.textarea-wrapper') || textarea.parentElement;
  wrapper.style.position = 'relative';
  wrapper.appendChild(container);

  // Position: below the button, right-aligned
  container.style.right = '0';
  container.style.top = '100%';

  picker.addEventListener('emoji-click', (event) => {
    const emoji = event.detail.unicode;
    insertAtCursor(textarea, emoji);
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

    // Ctrl+B/I inside textareas -> apply formatting
    if ((e.ctrlKey || e.metaKey) && inTextarea && (active.id === 'message-content' || active.id === 'tpl-content')) {
      if (e.key.toLowerCase() === 'b') { e.preventDefault(); wrapSelection(active, '*'); }
      else if (e.key.toLowerCase() === 'i') { e.preventDefault(); wrapSelection(active, '_'); }
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

function initFormatToolbars() {
  document.querySelectorAll('.format-toolbar').forEach((toolbar) => {
    if (toolbar.dataset.initialized) return;
    toolbar.dataset.initialized = '1';
    const targetId = toolbar.dataset.target;
    toolbar.querySelectorAll('.fmt-btn').forEach((btn) => {
      if (btn.classList.contains('fmt-emoji')) return; // has its own onclick
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const textarea = document.getElementById(targetId);
        if (!textarea) return;
        if (btn.dataset.wrap) wrapSelection(textarea, btn.dataset.wrap);
        else if (btn.dataset.prefix) prefixLines(textarea, btn.dataset.prefix);
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
  const datetime = document.getElementById('schedule-datetime').value;
  if (!datetime) { toast('Selectionnez une date et heure', 'error'); return; }
  const payload = buildPayload();
  if (!payload) return;
  payload.scheduled_at = datetime;

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

function parseTagsInput(str) {
  return (str || '').split(/[\s,]+/).map((t) => t.trim().replace(/^#/, '')).filter((t) => t.length > 0);
}

function buildPayload() {
  const allRecipients = [...selectedGroups, ...selectedContacts];
  if (allRecipients.length === 0) { toast('Selectionnez au moins un groupe ou un contact', 'error'); return null; }
  const content = document.getElementById('message-content').value.trim();
  if (!content && uploadedFiles.length === 0) { toast('Redigez un message ou ajoutez un fichier', 'error'); return null; }
  const notes = (document.getElementById('message-notes')?.value || '').trim();
  const tags = parseTagsInput(document.getElementById('message-tags')?.value);
  return {
    groups: allRecipients, content,
    attachments: uploadedFiles.map((f) => ({ filename: f.filename, originalname: f.originalname })),
    notes,
    tags,
  };
}

function resetForm() {
  selectedGroups = []; selectedContacts = []; uploadedFiles = [];
  document.getElementById('message-content').value = '';
  document.getElementById('schedule-datetime').value = '';
  document.getElementById('group-search').value = '';
  document.getElementById('contact-search').value = '';
  document.getElementById('message-preview').classList.add('hidden');
  const notesEl = document.getElementById('message-notes');
  if (notesEl) notesEl.value = '';
  const tagsEl = document.getElementById('message-tags');
  if (tagsEl) tagsEl.value = '';
  renderGroups(); renderContacts(); renderFileList();
  editingMessageId = null;
}

// --- Queue ---
async function loadQueue() {
  try {
    const res = await api('/api/messages');
    const messages = await res.json();
    const container = document.getElementById('queue-list');

    if (messages.length === 0) { container.innerHTML = '<p class="empty">Aucun message programme.</p>'; return; }

    container.innerHTML = messages.map((m) => {
      const tags = Array.isArray(m.tags) ? m.tags : [];
      return `
      <div class="queue-item">
        <div class="queue-item-header">
          <span class="date">${formatDate(m.scheduled_at)}</span>
          <span style="font-size:12px;color:var(--text-light)">#${m.id}</span>
        </div>
        <div class="queue-item-groups">
          ${m.groups.map((g) => `<span class="group-tag">${escapeHtml(g.name)}</span>`).join('')}
        </div>
        <div class="queue-item-content">${escapeHtml(m.content).substring(0, 200)}</div>
        ${m.attachments.length > 0 ? `<div style="font-size:12px;color:var(--text-light)">&#128206; ${m.attachments.length} piece(s) jointe(s)</div>` : ''}
        ${tags.length > 0 ? `<div class="message-tags">${tags.map(t => `<span class="message-tag">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
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
  } catch (err) { console.error('Failed to load queue:', err); }
}

function fillComposeFromMessage(msg, { keepId = false, keepDate = true } = {}) {
  selectedGroups = Array.isArray(msg.groups) ? [...msg.groups] : [];
  selectedContacts = [];
  uploadedFiles = Array.isArray(msg.attachments) ? [...msg.attachments] : [];
  document.getElementById('message-content').value = msg.content || '';
  const dt = document.getElementById('schedule-datetime');
  if (keepDate && msg.scheduled_at) dt.value = String(msg.scheduled_at).slice(0, 16);
  else dt.value = '';
  const notesEl = document.getElementById('message-notes');
  if (notesEl) notesEl.value = msg.notes || '';
  const tagsEl = document.getElementById('message-tags');
  if (tagsEl) tagsEl.value = Array.isArray(msg.tags) ? msg.tags.map(t => '#' + t).join(' ') : '';
  editingMessageId = keepId ? msg.id : null;
  renderGroups(); renderContacts(); renderFileList();
  // Switch to compose section
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
function openPreviewModal({ scheduledAt, sentAt, status, recipients, content, attachments, notes, tags }) {
  const modal = document.getElementById('preview-modal');
  const meta = document.getElementById('preview-modal-meta');
  const body = document.getElementById('preview-modal-body');
  const atts = document.getElementById('preview-modal-attachments');
  const notesEl = document.getElementById('preview-modal-notes');

  const parts = [];
  if (scheduledAt) parts.push(`<strong>Programme :</strong> ${formatDate(scheduledAt)}`);
  if (sentAt) parts.push(`<strong>Envoye :</strong> ${formatDate(sentAt)}`);
  if (status) parts.push(`<strong>Statut :</strong> <span class="status-${status}">${status === 'sent' ? 'Envoye' : status === 'error' ? 'Erreur' : status}</span>`);
  if (recipients && recipients.length) parts.push(`<strong>Destinataire(s) :</strong> ${recipients.map(escapeHtml).join(', ')}`);
  if (tags && tags.length) parts.push(`<strong>Tags :</strong> ${tags.map(t => '<span class="message-tag">#' + escapeHtml(t) + '</span>').join(' ')}`);
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

function showTemplateForm() {
  document.getElementById('template-form').classList.remove('hidden');
  document.getElementById('template-form-title').textContent = 'Nouveau template';
  document.getElementById('template-edit-id').value = '';
  document.getElementById('tpl-title').value = '';
  document.getElementById('tpl-content').value = '';
  tplAttachments = [];
  renderTplFileList();
  initTplDropZone();
}

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
  document.getElementById('template-form').classList.remove('hidden');
  document.getElementById('template-form-title').textContent = 'Modifier template';
  document.getElementById('template-edit-id').value = id;
  document.getElementById('tpl-title').value = tpl.title;
  document.getElementById('tpl-content').value = tpl.content;
  tplAttachments = Array.isArray(tpl.attachments) ? [...tpl.attachments] : [];
  renderTplFileList();
  initTplDropZone();
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
async function loadHistory() {
  try {
    const params = new URLSearchParams();
    const group = document.getElementById('filter-group').value;
    const status = document.getElementById('filter-status').value;
    const from = document.getElementById('filter-from').value;
    const to = document.getElementById('filter-to').value;
    if (group) params.set('group_name', group);
    if (status) params.set('status', status);
    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);

    const res = await api(`/api/history?${params}`);
    const rows = await res.json();
    const tbody = document.getElementById('history-body');

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-light)">Aucun envoi enregistre</td></tr>';
      return;
    }

    // Stash rows for preview/duplicate access
    window._historyRows = rows;

    tbody.innerHTML = rows.map((r, idx) => `
      <tr>
        <td>${formatDate(r.sent_at)}</td>
        <td>${escapeHtml(r.group_name)}</td>
        <td>${escapeHtml((r.content || '').substring(0, 80))}</td>
        <td class="status-${r.status}">${r.status === 'sent' ? 'Envoye' : 'Erreur'}</td>
        <td>${escapeHtml(r.error || '-')}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-xs" onclick="openPreviewFromHistory(${idx})">Apercu</button>
          <button class="btn btn-xs" onclick="duplicateHistoryMessage(${idx})">Dupliquer</button>
        </td>
      </tr>`).join('');
  } catch (err) { console.error('Failed to load history:', err); }
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

function formatDate(isoString) {
  if (!isoString) return '-';
  const d = new Date(isoString);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
