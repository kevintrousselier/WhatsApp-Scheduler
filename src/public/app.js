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

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initDropZone();

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

  // Trigger WhatsApp connection
  api('/api/connect', { method: 'POST' }).catch(() => {});

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

  document.getElementById('wa-status').addEventListener('click', async () => {
    if (!currentUserId) return;
    const res = await api('/api/status');
    const status = await res.json();
    if (status.qrCode) showQRCode(status.qrCode);
  });
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
      overlay.innerHTML = '<div class="loading"><div class="spinner"></div><span>Connexion a WhatsApp en cours... Cela peut prendre jusqu\'a 1 minute.</span></div>';
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
    if (tpl) document.getElementById('message-content').value = tpl.content;
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
  payload.scheduled_at = new Date(datetime).toISOString();

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

function buildPayload() {
  const allRecipients = [...selectedGroups, ...selectedContacts];
  if (allRecipients.length === 0) { toast('Selectionnez au moins un groupe ou un contact', 'error'); return null; }
  const content = document.getElementById('message-content').value.trim();
  if (!content && uploadedFiles.length === 0) { toast('Redigez un message ou ajoutez un fichier', 'error'); return null; }
  return {
    groups: allRecipients, content,
    attachments: uploadedFiles.map((f) => ({ filename: f.filename, originalname: f.originalname })),
  };
}

function resetForm() {
  selectedGroups = []; selectedContacts = []; uploadedFiles = [];
  document.getElementById('message-content').value = '';
  document.getElementById('schedule-datetime').value = '';
  document.getElementById('group-search').value = '';
  document.getElementById('contact-search').value = '';
  document.getElementById('message-preview').classList.add('hidden');
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

    container.innerHTML = messages.map((m) => `
      <div class="queue-item">
        <div class="queue-item-header">
          <span class="date">${formatDate(m.scheduled_at)}</span>
          <span style="font-size:12px;color:var(--text-light)">#${m.id}</span>
        </div>
        <div class="queue-item-groups">
          ${m.groups.map((g) => `<span class="group-tag">${escapeHtml(g.name)}</span>`).join('')}
        </div>
        <div class="queue-item-content">${escapeHtml(m.content).substring(0, 200)}</div>
        ${m.attachments.length > 0 ? `<div style="font-size:12px;color:var(--text-light)">${m.attachments.length} piece(s) jointe(s)</div>` : ''}
        <div class="queue-item-actions">
          <button class="btn btn-sm" onclick="editQueueMessage(${m.id})">Modifier</button>
          <button class="btn btn-sm btn-primary" onclick="sendQueueMessage(${m.id})">Envoyer maintenant</button>
          <button class="btn btn-sm btn-danger" onclick="deleteQueueMessage(${m.id})">Supprimer</button>
        </div>
      </div>`).join('');
  } catch (err) { console.error('Failed to load queue:', err); }
}

async function editQueueMessage(id) {
  try {
    const res = await api(`/api/messages/${id}`);
    const msg = await res.json();
    selectedGroups = msg.groups; uploadedFiles = msg.attachments || [];
    document.getElementById('message-content').value = msg.content;
    if (msg.scheduled_at) document.getElementById('schedule-datetime').value = msg.scheduled_at.slice(0, 16);
    editingMessageId = id;
    renderGroups(); renderFileList();
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    document.querySelector('[data-section="compose"]').classList.add('active');
    document.querySelectorAll('.section').forEach((s) => s.classList.add('hidden'));
    document.getElementById('section-compose').classList.remove('hidden');
    toast('Message charge pour modification', 'info');
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
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
  grid.innerHTML = templates.map((t) => `
    <div class="template-card">
      <h3>${escapeHtml(t.title)}</h3>
      <div class="preview">${escapeHtml(t.content).substring(0, 120)}</div>
      <div class="actions">
        <button class="btn btn-sm" onclick="editTemplate(${t.id})">Modifier</button>
        <button class="btn btn-sm" onclick="duplicateTemplate(${t.id})">Dupliquer</button>
        <button class="btn btn-sm btn-danger" onclick="deleteTemplate(${t.id})">Supprimer</button>
      </div>
    </div>`).join('');
}

function showTemplateForm() {
  document.getElementById('template-form').classList.remove('hidden');
  document.getElementById('template-form-title').textContent = 'Nouveau template';
  document.getElementById('template-edit-id').value = '';
  document.getElementById('tpl-title').value = '';
  document.getElementById('tpl-content').value = '';
}

function hideTemplateForm() { document.getElementById('template-form').classList.add('hidden'); }

async function saveTemplate() {
  const editId = document.getElementById('template-edit-id').value;
  const title = document.getElementById('tpl-title').value.trim();
  const content = document.getElementById('tpl-content').value.trim();
  if (!title || !content) { toast('Titre et contenu requis', 'error'); return; }
  const variables = [...new Set((content.match(/\{\{(\w+)\}\}/g) || []).map((v) => v.replace(/[{}]/g, '')))];
  const url = editId ? `/api/templates/${editId}` : '/api/templates';
  const method = editId ? 'PUT' : 'POST';
  try {
    const res = await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, variables }) });
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
}

async function duplicateTemplate(id) {
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return;
  try {
    const res = await api('/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: tpl.title + ' (copie)', content: tpl.content, variables: tpl.variables }),
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
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-light)">Aucun envoi enregistre</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${formatDate(r.sent_at)}</td>
        <td>${escapeHtml(r.group_name)}</td>
        <td>${escapeHtml((r.content || '').substring(0, 80))}</td>
        <td class="status-${r.status}">${r.status === 'sent' ? 'Envoye' : 'Erreur'}</td>
        <td>${escapeHtml(r.error || '-')}</td>
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
