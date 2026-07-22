// ============================================================
// Chemical Inventory Scanner - Application Logic
// ============================================================
// Uses IndexedDB for persistent local storage, html5-qrcode
// for camera barcode scanning, and SheetJS for XLSX export.
// ============================================================

(function () {
    'use strict';

    // Gemini model used for both label vision and web-grounded text lookup.
    // Change here to try a different model; gemini-2.5-flash is the previous
    // known-good value if a newer one reads labels worse.
    const GEMINI_MODEL = 'gemini-3.6-flash';

    // ==================== Database ====================
    class ChemDB {
        constructor() {
            this.db = null;
        }

        async init() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open('ChemicalInventory', 3);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    this.db = request.result;
                    resolve();
                };
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    // Chemical templates - maps barcodes to known chemical info
                    if (!db.objectStoreNames.contains('chemicals')) {
                        db.createObjectStore('chemicals', { keyPath: 'barcode' });
                    }
                    // Individual bottle inventory items
                    if (!db.objectStoreNames.contains('inventory')) {
                        const store = db.createObjectStore('inventory', { keyPath: 'id' });
                        store.createIndex('barcode', 'barcode', { unique: false });
                        store.createIndex('status', 'status', { unique: false });
                        store.createIndex('dateIn', 'dateIn', { unique: false });
                    }
                    // Managed lists (locations, names)
                    if (!db.objectStoreNames.contains('lists')) {
                        db.createObjectStore('lists', { keyPath: 'key' });
                    }
                };
            });
        }

        // -- Managed lists (names, locations) --
        async getList(key) {
            const record = await this._req(this._tx('lists', 'readonly').get(key));
            return record ? record.items : [];
        }

        async saveList(key, items) {
            return this._req(this._tx('lists', 'readwrite').put({ key, items }));
        }

        _tx(storeName, mode) {
            const tx = this.db.transaction(storeName, mode);
            return tx.objectStore(storeName);
        }

        _req(request) {
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }

        // -- Chemical templates --
        async getChemical(barcode) {
            return this._req(this._tx('chemicals', 'readonly').get(barcode));
        }

        async saveChemical(data) {
            return this._req(this._tx('chemicals', 'readwrite').put(data));
        }

        // -- Inventory items --
        async addItem(item) {
            return this._req(this._tx('inventory', 'readwrite').put(item));
        }

        async getItem(id) {
            return this._req(this._tx('inventory', 'readonly').get(id));
        }

        async updateItem(item) {
            return this._req(this._tx('inventory', 'readwrite').put(item));
        }

        async deleteItem(id) {
            return this._req(this._tx('inventory', 'readwrite').delete(id));
        }

        async getAllItems() {
            return this._req(this._tx('inventory', 'readonly').getAll());
        }

        async getItemsByBarcode(barcode) {
            const store = this._tx('inventory', 'readonly');
            const index = store.index('barcode');
            return this._req(index.getAll(barcode));
        }

        async getActiveItemsByBarcode(barcode) {
            const items = await this.getItemsByBarcode(barcode);
            return items.filter(i => i.status === 'active');
        }
    }

    // ==================== Firebase Database (REST API) ====================
    class FirebaseDB {
        constructor(url, labKey) {
            this.url = url;
            this.labKey = labKey || '';
            this.baseUrl = '';
            this.pollInterval = null;
        }

        async init() {
            if (!this.labKey) throw new Error('Lab Key is required. Set it in Settings.');
            let config;
            try {
                config = JSON.parse(this.url);
            } catch (e) {
                config = { databaseURL: this.url };
            }
            this.baseUrl = (config.databaseURL || this.url).replace(/\/+$/, '');
            // Use hashed lab key as path prefix for security
            const keyHash = await this._hashKey(this.labKey);
            this.baseUrl = this.baseUrl + '/lab_' + keyHash;
            // Test connection
            const resp = await fetch(this.baseUrl + '/.json');
            if (!resp.ok) throw new Error('Firebase connection failed: ' + resp.status);
        }

        async _hashKey(key) {
            // Simple hash to avoid exposing the actual password in the URL path
            const encoder = new TextEncoder();
            const data = encoder.encode(key);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
        }

        _encodeKey(key) {
            // Firebase keys can't contain . $ # [ ] /
            return (key || '').replace(/[.$/\[\]#]/g, '_');
        }

        async _get(path) {
            const resp = await fetch(this.baseUrl + '/' + path + '.json');
            if (!resp.ok) throw new Error('Firebase read failed: ' + resp.status);
            return resp.json();
        }

        async _set(path, data) {
            const resp = await fetch(this.baseUrl + '/' + path + '.json', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (!resp.ok) throw new Error('Firebase write failed: ' + resp.status);
            return resp.json();
        }

        async _delete(path) {
            const resp = await fetch(this.baseUrl + '/' + path + '.json', {
                method: 'DELETE'
            });
            if (!resp.ok) throw new Error('Firebase delete failed: ' + resp.status);
        }

        // -- Managed lists (names, locations) --
        async getList(key) {
            const data = await this._get('lists/' + key + '/items');
            return data || [];
        }

        async saveList(key, items) {
            return this._set('lists/' + key, { items });
        }

        // -- Chemical templates --
        async getChemical(barcode) {
            const data = await this._get('chemicals/' + this._encodeKey(barcode));
            return data || undefined;
        }

        async saveChemical(data) {
            return this._set('chemicals/' + this._encodeKey(data.barcode), data);
        }

        // -- Inventory items --
        async addItem(item) {
            return this._set('inventory/' + item.id, item);
        }

        async getItem(id) {
            const data = await this._get('inventory/' + id);
            return data || undefined;
        }

        async updateItem(item) {
            return this._set('inventory/' + item.id, item);
        }

        async deleteItem(id) {
            return this._delete('inventory/' + id);
        }

        async getAllItems() {
            const data = await this._get('inventory');
            return data ? Object.values(data) : [];
        }

        async getItemsByBarcode(barcode) {
            const items = await this.getAllItems();
            return items.filter(i => i.barcode === barcode);
        }

        async getActiveItemsByBarcode(barcode) {
            const items = await this.getItemsByBarcode(barcode);
            return items.filter(i => i.status === 'active');
        }

        // Poll for changes every 10 seconds instead of WebSocket
        startSync(callback) {
            this.pollInterval = setInterval(callback, 10000);
        }

        stopSync() {
            if (this.pollInterval) clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    // ==================== Offline-Tolerant Database ====================
    // Wraps the Firebase database with a local IndexedDB mirror and a replay
    // queue. Writes always land locally first, so a dropped connection in the
    // lab never loses an entry — the queue drains when the network returns.
    class SyncedDB {
        constructor(remote, local) {
            this.remote = remote;
            this.local = local;
            this.pending = this._loadQueue();
            this.online = true;
            this.pollInterval = null;
            this.onStatusChange = null;
            this.lastMirror = 0;
            this.MIRROR_INTERVAL = 60000; // don't rewrite the local mirror on every poll
        }

        // Local storage must come up; the remote is allowed to be unreachable.
        // Returns true if the shared database is connected.
        async init() {
            await this.local.init();
            window.addEventListener('online', () => this.flush());
            const connected = await this._connectRemote();
            if (connected) this.flush();
            return connected;
        }

        async _connectRemote() {
            try {
                await this.remote.init();
                this.remoteReady = true;
                this._setOnline(true);
                return true;
            } catch (e) {
                console.warn('Shared database unavailable:', e);
                this.remoteReady = false;
                this._setOnline(false);
                return false;
            }
        }

        // -- Queue persistence --
        _loadQueue() {
            try {
                return JSON.parse(localStorage.getItem('chem_pending_ops') || '[]');
            } catch (e) {
                return [];
            }
        }

        _saveQueue() {
            try {
                localStorage.setItem('chem_pending_ops', JSON.stringify(this.pending));
            } catch (e) {
                console.warn('Could not persist pending queue:', e);
            }
        }

        _enqueue(op) {
            // Every op is a whole-record put, so a newer op for the same key
            // fully supersedes the older one.
            this.pending = this.pending.filter(p => !(p.kind === op.kind && p.key === op.key));
            this.pending.push(op);
            this._saveQueue();
            this._setOnline(false);
        }

        _setOnline(state) {
            this.online = state;
            if (this.onStatusChange) this.onStatusChange(state, this.pending.length);
        }

        get pendingCount() {
            return this.pending.length;
        }

        // Replays queued writes in order. Stops at the first failure so later
        // ops don't jump ahead of earlier ones.
        async flush() {
            if (this.flushing || this.pending.length === 0) return;
            // A failed startup leaves the remote unconfigured; retry before replaying.
            if (!this.remoteReady && !(await this._connectRemote())) return;
            this.flushing = true;
            try {
                while (this.pending.length > 0) {
                    const op = this.pending[0];
                    await this._replay(op);
                    this.pending.shift();
                    this._saveQueue();
                }
                this._setOnline(true);
            } catch (e) {
                console.warn('Sync flush stalled:', e);
                this._setOnline(false);
            } finally {
                this.flushing = false;
                if (this.onStatusChange) this.onStatusChange(this.online, this.pending.length);
            }
        }

        _replay(op) {
            if (op.kind === 'item') {
                return op.value ? this.remote.addItem(op.value) : this.remote.deleteItem(op.key);
            }
            if (op.kind === 'chemical') return this.remote.saveChemical(op.value);
            if (op.kind === 'list') return this.remote.saveList(op.key, op.value);
            return Promise.resolve();
        }

        // Runs a write locally first, then remotely; queues it if the remote fails.
        async _write(localFn, remoteFn, op) {
            await localFn();
            if (this.pending.length > 0) {
                // Preserve ordering: if anything is already queued, this goes behind it.
                this._enqueue(op);
                this.flush();
                return;
            }
            try {
                await remoteFn();
                this._setOnline(true);
            } catch (e) {
                console.warn('Remote write failed, queued for sync:', e);
                this._enqueue(op);
                showToast('Saved offline — will sync when reconnected.', '');
            }
        }

        // Overlays queued writes onto a set of items so the UI shows unsynced work.
        _applyPending(items) {
            const queued = this.pending.filter(p => p.kind === 'item');
            if (queued.length === 0) return items;
            const map = new Map(items.map(i => [i.id, i]));
            queued.forEach(p => {
                if (p.value) map.set(p.key, p.value);
                else map.delete(p.key);
            });
            return [...map.values()];
        }

        _mirrorItems(items) {
            const now = Date.now();
            if (now - this.lastMirror < this.MIRROR_INTERVAL) return;
            this.lastMirror = now;
            Promise.all(items.map(i => this.local.addItem(i)))
                .catch(e => console.warn('Local mirror update failed:', e));
        }

        // -- Reads: remote when possible, local mirror when not --
        async getAllItems() {
            try {
                const items = await this.remote.getAllItems();
                this._setOnline(true);
                this._mirrorItems(items);
                return this._applyPending(items);
            } catch (e) {
                this._setOnline(false);
                return this._applyPending(await this.local.getAllItems());
            }
        }

        async getItem(id) {
            const queued = this.pending.find(p => p.kind === 'item' && p.key === id);
            if (queued) return queued.value ? JSON.parse(JSON.stringify(queued.value)) : undefined;
            try {
                const item = await this.remote.getItem(id);
                this._setOnline(true);
                return item;
            } catch (e) {
                this._setOnline(false);
                return this.local.getItem(id);
            }
        }

        async getList(key) {
            const queued = this.pending.find(p => p.kind === 'list' && p.key === key);
            if (queued) return queued.value.slice();
            try {
                const items = await this.remote.getList(key);
                this._setOnline(true);
                this.local.saveList(key, items).catch(() => { /* mirror is best-effort */ });
                return items;
            } catch (e) {
                this._setOnline(false);
                return this.local.getList(key);
            }
        }

        async getChemical(barcode) {
            const queued = this.pending.find(p => p.kind === 'chemical' && p.key === barcode);
            if (queued) return queued.value;
            try {
                const chem = await this.remote.getChemical(barcode);
                this._setOnline(true);
                return chem;
            } catch (e) {
                this._setOnline(false);
                return this.local.getChemical(barcode);
            }
        }

        async getItemsByBarcode(barcode) {
            const items = await this.getAllItems();
            return items.filter(i => i.barcode === barcode);
        }

        async getActiveItemsByBarcode(barcode) {
            return (await this.getItemsByBarcode(barcode)).filter(i => i.status === 'active');
        }

        // -- Writes --
        addItem(item) {
            return this._write(
                () => this.local.addItem(item),
                () => this.remote.addItem(item),
                { kind: 'item', key: item.id, value: item }
            );
        }

        updateItem(item) {
            return this.addItem(item);
        }

        deleteItem(id) {
            return this._write(
                () => this.local.deleteItem(id),
                () => this.remote.deleteItem(id),
                { kind: 'item', key: id, value: null }
            );
        }

        saveChemical(data) {
            return this._write(
                () => this.local.saveChemical(data),
                () => this.remote.saveChemical(data),
                { kind: 'chemical', key: data.barcode, value: data }
            );
        }

        saveList(key, items) {
            return this._write(
                () => this.local.saveList(key, items),
                () => this.remote.saveList(key, items),
                { kind: 'list', key, value: items }
            );
        }

        startSync(callback) {
            this.pollInterval = setInterval(() => {
                this.flush();
                callback();
            }, 10000);
        }

        stopSync() {
            if (this.pollInterval) clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    // ==================== Haptic & Audio Feedback ====================
    function hapticFeedback(type = 'light') {
        try {
            if (navigator.vibrate) {
                if (type === 'success') navigator.vibrate([50, 30, 50]);
                else if (type === 'error') navigator.vibrate([100, 50, 100, 50, 100]);
                else navigator.vibrate(30);
            }
        } catch (e) { /* ignore */ }
    }

    function playTone(freq = 800, duration = 150, type = 'sine') {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.value = freq;
            gain.gain.value = 0.3;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
            osc.stop(ctx.currentTime + duration / 1000);
        } catch (e) { /* ignore */ }
    }

    function feedbackSuccess() { hapticFeedback('success'); playTone(880, 120); setTimeout(() => playTone(1100, 150), 130); }
    function feedbackRemove() { hapticFeedback('light'); playTone(440, 200, 'triangle'); }
    function feedbackError() { hapticFeedback('error'); playTone(300, 300, 'sawtooth'); }

    // ==================== Toast Notifications ====================
    function showToast(message, type = '') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = 'toast' + (type ? ' ' + type : '');
        toast.style.display = 'block';
        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => {
            toast.style.display = 'none';
        }, 3000);
    }

    // ==================== ID Generation ====================
    function generateId() {
        if (crypto.randomUUID) return crypto.randomUUID();
        return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
            Math.floor(Math.random() * 16).toString(16)
        );
    }

    // ==================== Date Formatting ====================
    function formatDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatDateShort(iso) {
        if (!iso) return '';
        return new Date(iso).toLocaleDateString();
    }

    // ==================== Expiration ====================
    const EXPIRY_WARN_DAYS = 60;

    // Whole days from today until a YYYY-MM-DD date; negative once past.
    // Parsed at local midnight so a date never reads a day early in the US.
    function daysUntil(dateStr) {
        if (!dateStr) return null;
        const target = new Date(dateStr + 'T00:00:00');
        if (isNaN(target.getTime())) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return Math.round((target - today) / 86400000);
    }

    function expiryState(item) {
        if (item.status !== 'active') return null;
        const days = daysUntil(item.expiration);
        if (days === null) return null;
        if (days < 0) return { level: 'expired', days, label: 'Expired' };
        if (days <= EXPIRY_WARN_DAYS) {
            return { level: 'expiring', days, label: days === 0 ? 'Expires today' : 'Expires in ' + days + 'd' };
        }
        return null;
    }

    // ==================== Main App ====================
    class App {
        constructor() {
            this.db = null; // Set in init()
            this.mode = 'input'; // 'input', 'output', or 'move'
            this.selectedBottles = new Set();
            this.selectedMoveBottles = new Set();
            this.modalTarget = null; // 'names' or 'locations'
            this.editingId = null;   // set while the form is editing an existing entry
            this.cameraStream = null; // live MediaStream while the in-app camera is open
            this.batchCount = 0;      // bottles added in the current auto-add run
            this.approvedDuplicates = new Set(); // "productNumber|location" the user already OK'd this batch
        }

        getGeminiKey() {
            return localStorage.getItem('chem_gemini_api_key') || '';
        }

        getFirebaseUrl() {
            return localStorage.getItem('chem_firebase_url') || '';
        }

        getLabKey() {
            return localStorage.getItem('chem_lab_key') || '';
        }

        async init() {
            // Use Firebase if URL is configured, otherwise fall back to IndexedDB
            const fbUrl = this.getFirebaseUrl();
            const labKey = this.getLabKey();
            if (fbUrl) {
                const synced = new SyncedDB(new FirebaseDB(fbUrl, labKey), new ChemDB());
                synced.onStatusChange = (online, pending) => this.renderSyncStatus(online, pending);
                this.db = synced;
                const connected = await synced.init();
                showToast(
                    connected
                        ? 'Connected to shared database.'
                        : 'Offline — using local copy. Changes will sync when reconnected.',
                    connected ? 'success' : 'error'
                );
                // Poll for other users' changes, but only when the result is
                // actually on screen — refetching the whole inventory every
                // 10s while someone is adding bottles is pure wasted data.
                synced.startSync(() => {
                    if (document.hidden) return;
                    if (this.mode === 'inventory') this.refreshInventory();
                });
            } else {
                this.db = new ChemDB();
                await this.db.init();
            }
            this.bindEvents();
            try {
                await this.loadSessionDropdowns();
            } catch (e) {
                console.error('loadSessionDropdowns failed:', e);
            }
            this.restoreSession();
            this.refreshInventory();
        }

        // ---- Sync Status ----
        renderSyncStatus(online, pending) {
            const el = document.getElementById('sync-status');
            if (!el) return;
            if (pending > 0) {
                el.textContent = pending + ' unsynced';
                el.className = 'sync-status pending';
            } else if (!online) {
                el.textContent = 'Offline';
                el.className = 'sync-status offline';
            } else {
                el.textContent = '';
                el.className = 'sync-status';
            }
        }

        // ---- Session (Name + Location) ----
        async loadSessionDropdowns() {
            const names = await this.db.getList('names');
            const locations = await this.db.getList('locations');
            this.populateSelect('session-name', names);
            this.populateSelect('session-location', locations);
        }

        populateSelect(selectId, items) {
            const sel = document.getElementById(selectId);
            const currentVal = sel.value;
            // Keep the placeholder, remove the rest
            while (sel.options.length > 1) sel.remove(1);
            items.sort((a, b) => a.localeCompare(b));
            items.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                sel.appendChild(opt);
            });
            // Restore previous selection if still in list
            if (items.includes(currentVal)) sel.value = currentVal;
        }

        getSessionName() {
            return document.getElementById('session-name').value;
        }

        getSessionLocation() {
            return document.getElementById('session-location').value;
        }

        saveSession() {
            try {
                localStorage.setItem('chem_session_name', this.getSessionName());
                localStorage.setItem('chem_session_location', this.getSessionLocation());
            } catch (e) { /* ignore */ }
        }

        restoreSession() {
            try {
                const name = localStorage.getItem('chem_session_name');
                const loc = localStorage.getItem('chem_session_location');
                if (name) document.getElementById('session-name').value = name;
                if (loc) document.getElementById('session-location').value = loc;
            } catch (e) { /* ignore */ }
        }

        // ---- List Edit Modal ----
        openModal(target) {
            this.modalTarget = target;
            document.getElementById('modal-title').textContent =
                target === 'names' ? 'Edit Names' : 'Edit Locations';
            document.getElementById('modal-new-item').placeholder =
                target === 'names' ? 'Add new name...' : 'Add new location...';
            document.getElementById('modal-new-item').value = '';
            document.getElementById('list-modal').style.display = '';
            this.refreshModalList();
        }

        closeModal() {
            document.getElementById('list-modal').style.display = 'none';
            this.modalTarget = null;
        }

        async refreshModalList() {
            const items = await this.db.getList(this.modalTarget);
            const ul = document.getElementById('modal-list');
            const emptyMsg = document.getElementById('modal-empty');

            if (items.length === 0) {
                ul.innerHTML = '';
                emptyMsg.style.display = '';
                return;
            }
            emptyMsg.style.display = 'none';
            items.sort((a, b) => a.localeCompare(b));
            ul.innerHTML = items.map(item => `
                <li>
                    <span>${this.esc(item)}</span>
                    <button class="remove-btn" data-item="${this.esc(item)}" title="Remove">&times;</button>
                </li>
            `).join('');

            ul.querySelectorAll('.remove-btn').forEach(btn => {
                btn.addEventListener('click', () => this.removeListItem(btn.dataset.item));
            });
        }

        async addListItem() {
            const input = document.getElementById('modal-new-item');
            const value = input.value.trim();
            if (!value) return;

            const items = await this.db.getList(this.modalTarget);
            if (items.includes(value)) {
                showToast('Already exists.', 'error');
                return;
            }
            items.push(value);
            const ok = await this.write(() => this.db.saveList(this.modalTarget, items), 'Adding entry');
            if (!ok) return;
            input.value = '';
            await this.refreshModalList();
            await this.loadSessionDropdowns();
            showToast('Added: ' + value, 'success');
        }

        async removeListItem(value) {
            let items = await this.db.getList(this.modalTarget);
            items = items.filter(i => i !== value);
            const ok = await this.write(() => this.db.saveList(this.modalTarget, items), 'Removing entry');
            if (!ok) return;
            await this.refreshModalList();
            await this.loadSessionDropdowns();
            showToast('Removed: ' + value, 'success');
        }

        // ---- PubChem Lookup ----
        async doLookup() {
            const vendor = document.getElementById('f-vendor').value.trim();
            const productNumber = document.getElementById('f-product-number').value.trim();
            if (!productNumber) {
                showToast('Enter a product number first.', 'error');
                return;
            }

            const btn = document.getElementById('lookup-btn');
            const vendorLink = document.getElementById('vendor-link');
            btn.disabled = true;
            btn.textContent = 'Searching...';
            this.setLookupStatus(vendor ? 'Searching PubChem...' : 'Searching all vendors on PubChem...', 'loading');
            vendorLink.style.display = 'none';

            try {
                const result = await this.pubchemLookup(vendor, productNumber);
                if (result && (result.productName || result.casNumber)) {
                    if (result.productName && !document.getElementById('f-product-name').value) {
                        document.getElementById('f-product-name').value = result.productName;
                    }
                    if (result.casNumber && !document.getElementById('f-cas').value) {
                        document.getElementById('f-cas').value = result.casNumber;
                    }
                    // Auto-fill vendor if it was found via a specific source
                    if (result.foundVendor && !document.getElementById('f-vendor').value) {
                        document.getElementById('f-vendor').value = result.foundVendor;
                    }
                    this.setLookupStatus('Found: ' + (result.productName || 'info retrieved'), 'success');
                } else {
                    this.setLookupStatus('Not found on PubChem.', 'error');
                    const url = this.buildVendorUrl(vendor, productNumber);
                    if (url) { vendorLink.href = url; vendorLink.style.display = ''; }
                }
            } catch (e) {
                console.error('Lookup failed:', e);
                this.setLookupStatus('Lookup failed.', 'error');
                const url = this.buildVendorUrl(vendor, productNumber);
                if (url) { vendorLink.href = url; vendorLink.style.display = ''; }
            } finally {
                btn.disabled = false;
                btn.textContent = 'Look Up Info';
            }
        }

        async pubchemLookup(vendor, productNumber) {
            // Strip size suffix: A4034-100G → A4034, W332615-1L → W332615
            const cleanNum = productNumber.replace(/[-_]\d+\.?\d*\s*(?:g|kg|mg|ml|l|ul|oz|lb|ea)$/i, '').trim();
            const sourceNames = this.getPubchemSources(vendor);
            // Try multiple variations: clean number first, then original
            const numsToTry = [cleanNum];
            if (cleanNum !== productNumber) numsToTry.push(productNumber);

            // Strategy 1: PubChem substance source ID lookup (try each vendor)
            for (const source of sourceNames) {
                for (const num of numsToTry) {
                    const cid = await this.pubchemSubstanceLookup(source, num);
                    if (cid) {
                        const info = await this.getCompoundInfo(cid);
                        if (info) {
                            // Map PubChem source name back to a user-friendly vendor name
                            const vendorMap = {
                                'Sigma-Aldrich': 'Sigma-Aldrich', 'MilliporeSigma': 'Sigma-Aldrich',
                                'Fisher Scientific': 'Fisher Scientific', 'Acros Organics': 'Acros Organics',
                                'Alfa Aesar': 'Alfa Aesar', 'TCI': 'TCI', 'VWR': 'VWR'
                            };
                            info.foundVendor = vendorMap[source] || source;
                        }
                        return info;
                    }
                }
            }

            // Strategy 2: Compound name search (works for CAS numbers and common names)
            for (const num of numsToTry) {
                const cid = await this.pubchemCompoundSearch(num);
                if (cid) return await this.getCompoundInfo(cid);
            }

            return null;
        }

        getPubchemSources(vendor) {
            const v = (vendor || '').toLowerCase().trim();
            // If no vendor specified, try all major sources
            if (!v) {
                return ['Sigma-Aldrich', 'MilliporeSigma', 'Fisher Scientific', 'Acros Organics', 'Alfa Aesar', 'TCI', 'VWR'];
            }
            const names = [];
            if (v.includes('sigma') || v.includes('aldrich')) names.push('Sigma-Aldrich', 'MilliporeSigma');
            if (v.includes('millipore')) names.push('MilliporeSigma', 'Sigma-Aldrich');
            if (v.includes('fisher') || v.includes('thermo')) names.push('Fisher Scientific');
            if (v.includes('acros')) names.push('Acros Organics');
            if (v.includes('alfa')) names.push('Alfa Aesar');
            if (v.includes('tci')) names.push('TCI');
            if (v.includes('vwr') || v.includes('avantor')) names.push('VWR');
            // If vendor didn't match any known source, also try all
            if (names.length === 0) {
                return ['Sigma-Aldrich', 'MilliporeSigma', 'Fisher Scientific', 'Acros Organics', 'Alfa Aesar', 'TCI', 'VWR'];
            }
            return names;
        }

        async pubchemSubstanceLookup(source, registryId) {
            try {
                const resp = await fetch(
                    `https://pubchem.ncbi.nlm.nih.gov/rest/pug/substance/sourceid/${encodeURIComponent(source)}/${encodeURIComponent(registryId)}/cids/JSON`,
                    { signal: AbortSignal.timeout(6000) }
                );
                if (resp.ok) {
                    const data = await resp.json();
                    const cids = data.IdentifierList?.CID;
                    if (cids && cids.length > 0) return cids[0];
                }
            } catch (e) { /* ignore */ }
            return null;
        }

        async pubchemCompoundSearch(query) {
            try {
                const resp = await fetch(
                    `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/cids/JSON`,
                    { signal: AbortSignal.timeout(6000) }
                );
                if (resp.ok) {
                    const data = await resp.json();
                    return data.IdentifierList?.CID?.[0] || null;
                }
            } catch (e) { /* ignore */ }
            return null;
        }

        async getCompoundInfo(cid) {
            try {
                const [propsResp, synsResp] = await Promise.all([
                    fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/IUPACName,Title,MolecularFormula/JSON`),
                    fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`)
                ]);
                const result = { productName: '', casNumber: '' };
                if (propsResp.ok) {
                    const data = await propsResp.json();
                    const props = data.PropertyTable?.Properties?.[0];
                    if (props) {
                        let name = props.Title || props.IUPACName || '';
                        if (name) name = name.charAt(0).toUpperCase() + name.slice(1);
                        result.productName = name;
                    }
                }
                if (synsResp.ok) {
                    const data = await synsResp.json();
                    const synonyms = data.InformationList?.Information?.[0]?.Synonym || [];
                    const cas = synonyms.find(s => /^\d{2,7}-\d{2}-\d$/.test(s));
                    if (cas) result.casNumber = cas;
                }
                return result;
            } catch (e) {
                console.error('getCompoundInfo failed:', e);
                return null;
            }
        }

        buildVendorUrl(vendor, productNumber) {
            const v = vendor.toLowerCase();
            const num = encodeURIComponent(productNumber);
            if (v.includes('sigma') || v.includes('aldrich') || v.includes('millipore'))
                return `https://www.sigmaaldrich.com/US/en/search/${num}`;
            if (v.includes('fisher') || v.includes('thermo'))
                return `https://www.fishersci.com/us/en/catalog/search/products?keyword=${num}`;
            if (v.includes('vwr') || v.includes('avantor'))
                return `https://us.vwr.com/store/search/searchAdv.jsp?keyword=${num}`;
            if (v.includes('alfa'))
                return `https://www.alfa.com/en/search/?q=${num}`;
            if (v.includes('tci'))
                return `https://www.tcichemicals.com/US/en/search/?text=${num}`;
            if (v.includes('acros'))
                return `https://www.fishersci.com/us/en/catalog/search/products?keyword=${num}`;
            return null;
        }

        setLookupStatus(text, type = '') {
            const el = document.getElementById('lookup-status');
            el.textContent = text;
            el.className = 'lookup-status' + (type ? ' ' + type : '');
        }

        // ---- Settings ----
        openSettings() {
            // Gemini key
            const input = document.getElementById('api-key-input');
            const status = document.getElementById('api-key-status');
            const saved = localStorage.getItem('chem_gemini_api_key');
            input.value = saved || '';
            status.textContent = saved ? 'Key is saved.' : '';
            status.style.color = saved ? 'var(--success)' : '';
            // Firebase URL
            const fbInput = document.getElementById('firebase-url-input');
            const fbStatus = document.getElementById('firebase-url-status');
            const fbSaved = this.getFirebaseUrl();
            fbInput.value = fbSaved || '';
            fbStatus.textContent = fbSaved ? 'Connected to shared database.' : '';
            fbStatus.style.color = fbSaved ? 'var(--success)' : '';
            // Lab Key
            const lkInput = document.getElementById('lab-key-input');
            const lkStatus = document.getElementById('lab-key-status');
            const lkSaved = this.getLabKey();
            lkInput.value = lkSaved || '';
            lkStatus.textContent = lkSaved ? 'Lab key is set.' : 'Required for database access.';
            lkStatus.style.color = lkSaved ? 'var(--success)' : 'var(--danger)';
            // Always reopen masked, so a revealed key isn't left on screen.
            document.querySelectorAll('.reveal-btn').forEach(btn => {
                document.getElementById(btn.dataset.reveals).type = 'password';
                btn.textContent = 'Show';
            });
            document.getElementById('settings-modal').style.display = '';
        }

        closeSettings() {
            document.getElementById('settings-modal').style.display = 'none';
        }

        saveApiKey() {
            const key = document.getElementById('api-key-input').value.trim();
            const status = document.getElementById('api-key-status');
            if (!key) {
                localStorage.removeItem('chem_gemini_api_key');
                status.textContent = 'Key removed.';
                status.style.color = 'var(--danger)';
            } else {
                localStorage.setItem('chem_gemini_api_key', key);
                status.textContent = 'Key saved!';
                status.style.color = 'var(--success)';
            }
            showToast(key ? 'API key saved.' : 'API key removed.', 'success');
        }

        saveFirebaseUrl() {
            const url = document.getElementById('firebase-url-input').value.trim();
            const status = document.getElementById('firebase-url-status');
            if (!url) {
                localStorage.removeItem('chem_firebase_url');
                status.textContent = 'Removed. Using local storage. Reload to apply.';
                status.style.color = 'var(--danger)';
            } else {
                localStorage.setItem('chem_firebase_url', url);
                status.textContent = 'Saved! Reload the page to connect.';
                status.style.color = 'var(--success)';
            }
            showToast(url ? 'Firebase URL saved. Reload to connect.' : 'Firebase removed.', 'success');
        }

        saveLabKey() {
            const key = document.getElementById('lab-key-input').value.trim();
            const status = document.getElementById('lab-key-status');
            if (!key) {
                localStorage.removeItem('chem_lab_key');
                status.textContent = 'Key removed.';
                status.style.color = 'var(--danger)';
            } else {
                localStorage.setItem('chem_lab_key', key);
                status.textContent = 'Lab key saved! Reload to apply.';
                status.style.color = 'var(--success)';
            }
            showToast(key ? 'Lab key saved. Reload to apply.' : 'Lab key removed.', 'success');
        }

        // ---- Snap Label (AI Vision) ----
        async triggerSnapLabel() {
            if (!this.getSessionName() || !this.getSessionLocation()) {
                showToast('Select your Name and Location first.', 'error');
                return;
            }
            if (!this.getGeminiKey()) {
                showToast('Set up your API key first (gear icon).', 'error');
                this.openSettings();
                return;
            }
            // Prefer the in-app camera: a file input with `capture` hands control
            // to the OS camera app, which forces a Retake/Use Photo confirmation
            // we can't skip. Fall back to it when there's no usable camera.
            if (await this.openCamera()) return;
            document.getElementById('label-capture').click();
        }

        async openCamera() {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
            try {
                this.cameraStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
                    audio: false,
                });
            } catch (e) {
                // Denied permission, no camera, or an insecure origin.
                console.warn('In-app camera unavailable, using photo picker:', e);
                return false;
            }

            const video = document.getElementById('camera-stream');
            video.srcObject = this.cameraStream;
            try {
                await video.play();
            } catch (e) {
                console.warn('Camera preview failed to start:', e);
                this.closeCamera();
                return false;
            }

            document.getElementById('camera-view').style.display = '';
            document.getElementById('camera-shutter').disabled = false;
            document.getElementById('snap-status').textContent = '';
            document.getElementById('camera-view').scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
        }

        // Ends an auto-add run: clears the running total and the duplicate
        // approvals, which are only meant to apply within a single batch.
        endBatch() {
            if (this.batchCount > 0) {
                showToast(`Batch finished — ${this.batchCount} bottle${this.batchCount !== 1 ? 's' : ''} added.`, 'success');
            }
            this.batchCount = 0;
            this.approvedDuplicates.clear();
            const snapStatus = document.getElementById('snap-status');
            if (snapStatus) snapStatus.textContent = '';
        }

        closeCamera() {
            if (this.cameraStream) {
                // Release the camera, or the indicator light stays on.
                this.cameraStream.getTracks().forEach(t => t.stop());
                this.cameraStream = null;
            }
            const video = document.getElementById('camera-stream');
            if (video) video.srcObject = null;
            const view = document.getElementById('camera-view');
            if (view) view.style.display = 'none';
        }

        // Grabs the current preview frame, already downscaled for upload.
        captureFrame(maxDimension = 1400) {
            const video = document.getElementById('camera-stream');
            const w = video.videoWidth, h = video.videoHeight;
            if (!w || !h) return null;
            const scale = Math.min(1, maxDimension / Math.max(w, h));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(w * scale);
            canvas.height = Math.round(h * scale);
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            return {
                data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1],
                mimeType: 'image/jpeg',
            };
        }

        async shootLabel() {
            const shutter = document.getElementById('camera-shutter');
            shutter.disabled = true;
            const image = this.captureFrame();
            if (!image) {
                showToast('Camera not ready yet — try again.', 'error');
                shutter.disabled = false;
                return;
            }
            hapticFeedback('light');
            this.closeCamera();
            await this.handleLabelImage(image, true);
        }

        async handleLabelCapture(file) {
            if (!file) return;
            const snapStatus = document.getElementById('snap-status');
            try {
                const image = await this.fileToBase64(file);
                await this.handleLabelImage(image);
            } catch (e) {
                console.error('Label analysis failed:', e);
                snapStatus.textContent = 'Analysis failed: ' + (e.message || 'Unknown error');
                snapStatus.className = 'lookup-status error';
            }
        }

        async handleLabelImage(image, fromCamera = false) {
            const snapStatus = document.getElementById('snap-status');
            snapStatus.textContent = 'Analyzing label...';
            snapStatus.className = 'lookup-status loading';

            try {
                // Call Gemini Vision API
                const result = await this.analyzeWithGemini(image);

                if (result) {
                    snapStatus.textContent = 'Label read successfully!';
                    snapStatus.className = 'lookup-status success';

                    // Show and fill the form
                    this.hideOutputSelect();
                    const form = document.getElementById('chemical-form');
                    document.getElementById('chem-form').reset();
                    document.getElementById('autofill-notice').style.display = 'none';
                    this.setLookupStatus('');
                    document.getElementById('vendor-link').style.display = 'none';

                    // Use the barcode from QR data or generate a reference from product info
                    const barcode = result.productNumber
                        ? (result.productNumber + (result.amount && result.unit ? '-' + result.amount + result.unit.toUpperCase() : ''))
                        : 'LABEL-' + Date.now();
                    document.getElementById('f-barcode').value = barcode;

                    if (result.vendor) document.getElementById('f-vendor').value = result.vendor;
                    if (result.productNumber) document.getElementById('f-product-number').value = result.productNumber;
                    if (result.productName) document.getElementById('f-product-name').value = result.productName;
                    if (result.casNumber) document.getElementById('f-cas').value = result.casNumber;
                    if (result.amount) document.getElementById('f-amount').value = result.amount;
                    if (result.unit) {
                        const unitMap = { 'g': 'g', 'kg': 'kg', 'mg': 'mg', 'ml': 'mL', 'l': 'L', 'ul': 'uL', 'oz': 'oz', 'lb': 'lb' };
                        const normalized = unitMap[result.unit.toLowerCase()] || result.unit;
                        document.getElementById('f-unit').value = normalized;
                    }
                    if (result.lotNumber) document.getElementById('f-notes').value = 'Lot: ' + result.lotNumber;
                    if (result.expiration) document.getElementById('f-expiration').value = result.expiration;

                    document.getElementById('autofill-notice').textContent = 'Auto-filled from label photo. Verify and edit as needed.';
                    document.getElementById('autofill-notice').style.display = '';

                    form.style.display = '';
                    form.scrollIntoView({ behavior: 'smooth', block: 'start' });

                    // Auto-submit if toggle is checked
                    if (document.getElementById('auto-submit').checked) {
                        const added = await this.submitChemical();
                        // Batch mode: reopen the camera for the next bottle so a
                        // shelf can be worked through without touching the screen
                        // between scans. Only after a real save, and only when the
                        // scan came from the camera rather than the photo library.
                        if (added && fromCamera && this.mode === 'input') {
                            this.batchCount++;
                            // Set the running total after reopening: openCamera
                            // resets the status line.
                            await this.openCamera();
                            snapStatus.textContent =
                                `Added ${this.batchCount} this batch — ready for the next bottle.`;
                            snapStatus.className = 'lookup-status success';
                            return;
                        }
                    }

                    setTimeout(() => { snapStatus.textContent = ''; }, 3000);
                } else {
                    snapStatus.textContent = 'Could not read label. Try again with a clearer photo.';
                    snapStatus.className = 'lookup-status error';
                }
            } catch (e) {
                console.error('Label analysis failed:', e);
                snapStatus.textContent = 'Analysis failed: ' + (e.message || 'Unknown error');
                snapStatus.className = 'lookup-status error';
            }
        }

        // Phone cameras produce 3-5 MB JPEGs; base64 inflates that by a third
        // again. Downscaling first cuts the upload roughly tenfold with no
        // measurable loss in label legibility.
        async fileToBase64(file, maxDimension = 1400) {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            const original = {
                data: dataUrl.split(',')[1],
                mimeType: file.type || 'image/jpeg',
            };

            try {
                const img = await new Promise((resolve, reject) => {
                    const image = new Image();
                    image.onload = () => resolve(image);
                    image.onerror = reject;
                    image.src = dataUrl;
                });

                const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
                if (scale === 1) return original;

                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                return {
                    data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1],
                    mimeType: 'image/jpeg',
                };
            } catch (e) {
                // Canvas can fail on odd formats (HEIC, some CMYK JPEGs) —
                // fall back to sending the original rather than losing the scan.
                console.warn('Image downscale failed, sending original:', e);
                return original;
            }
        }

        // Single place the Gemini endpoint and credentials are assembled.
        // The key goes in a header rather than the URL: query strings end up in
        // browser history, proxy logs, and crash reports; headers don't.
        geminiRequest(body) {
            const apiKey = this.getGeminiKey();
            if (!apiKey) throw new Error('No API key configured');
            return fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': apiKey,
                    },
                    body: JSON.stringify(body),
                }
            );
        }

        async analyzeWithGemini(image) {

            // A response schema makes the model return parseable JSON by
            // construction, instead of asking for JSON in the prompt and
            // regexing it back out of prose.
            const fields = ['vendor', 'productNumber', 'productName', 'casNumber',
                'amount', 'unit', 'lotNumber', 'expiration'];

            const response = await this.geminiRequest({
                contents: [{
                    parts: [
                        {
                            text: `Read this chemical product label image and extract:
- vendor: manufacturer or vendor name (e.g. Sigma-Aldrich, Fisher Scientific, Alfa Aesar)
- productNumber: catalog or product number
- productName: chemical or product name
- casNumber: CAS registry number, exactly in the format XXXXX-XX-X
- amount: quantity number only (e.g. 500, 1, 2.5)
- unit: unit of measurement (g, kg, mg, mL, L, etc.)
- lotNumber: lot or batch number if visible
- expiration: expiration date as YYYY-MM-DD if visible

Use an empty string for any field that is not visible or cannot be determined. Do not guess.`
                        },
                        {
                            inlineData: {
                                mimeType: image.mimeType,
                                data: image.data
                            }
                        }
                    ]
                }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: 'OBJECT',
                        properties: fields.reduce((acc, f) => (acc[f] = { type: 'STRING' }, acc), {}),
                        required: fields,
                    },
                }
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error?.message || 'API request failed (' + response.status + ')');
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('No response from AI');

            try {
                return JSON.parse(text);
            } catch (e) {
                // Belt and braces in case a future model wraps the JSON in prose.
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try { return JSON.parse(jsonMatch[0]); } catch (e2) { /* fall through */ }
                }
                console.error('JSON parse failed:', text);
                throw new Error('Could not parse AI response');
            }
        }

        bindEvents() {
            // Coming back to the app is the moment stale dropdowns matter, so
            // resync there instead of on a timer.
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) return;
                this.loadSessionDropdowns().catch(e => console.error('Dropdown resync failed:', e));
                if (this.mode === 'inventory') this.refreshInventory();
            });

            // Session dropdowns - save on change
            document.getElementById('session-name').addEventListener('change', () => this.saveSession());
            document.getElementById('session-location').addEventListener('change', () => this.saveSession());

            // Edit buttons for name/location lists
            document.getElementById('edit-names').addEventListener('click', () => this.openModal('names'));
            document.getElementById('edit-locations').addEventListener('click', () => this.openModal('locations'));

            // Modal events
            document.getElementById('modal-close').addEventListener('click', () => this.closeModal());
            document.getElementById('list-modal').addEventListener('click', (e) => {
                if (e.target === document.getElementById('list-modal')) this.closeModal();
            });
            document.getElementById('modal-add').addEventListener('click', () => this.addListItem());
            document.getElementById('modal-new-item').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.addListItem(); }
            });

            // Lookup button
            document.getElementById('lookup-btn').addEventListener('click', () => this.doLookup());

            // Settings
            document.getElementById('settings-btn').addEventListener('click', () => this.openSettings());
            document.getElementById('settings-close').addEventListener('click', () => this.closeSettings());
            document.getElementById('settings-modal').addEventListener('click', (e) => {
                if (e.target === document.getElementById('settings-modal')) this.closeSettings();
            });
            document.getElementById('save-api-key').addEventListener('click', () => this.saveApiKey());
            document.getElementById('api-key-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.saveApiKey(); }
            });
            document.getElementById('save-firebase-url').addEventListener('click', () => this.saveFirebaseUrl());
            document.getElementById('firebase-url-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.saveFirebaseUrl(); }
            });
            // Reveal toggles — the only way to read an existing key off a
            // working device when setting up a new one.
            document.querySelectorAll('.reveal-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const input = document.getElementById(btn.dataset.reveals);
                    const hidden = input.type === 'password';
                    input.type = hidden ? 'text' : 'password';
                    btn.textContent = hidden ? 'Hide' : 'Show';
                });
            });

            document.getElementById('save-lab-key').addEventListener('click', () => this.saveLabKey());
            document.getElementById('lab-key-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.saveLabKey(); }
            });

            // Snap Label
            document.getElementById('snap-label').addEventListener('click', () => this.triggerSnapLabel());
            document.getElementById('label-capture').addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) this.handleLabelCapture(file);
                e.target.value = ''; // Reset so same file can be re-selected
            });

            // In-app camera
            document.getElementById('camera-shutter').addEventListener('click', () => this.shootLabel());
            document.getElementById('camera-cancel').addEventListener('click', () => {
                this.closeCamera();
                this.endBatch();
            });
            // Turning auto-add off ends the run; a stale count would be confusing.
            document.getElementById('auto-submit').addEventListener('change', (e) => {
                if (!e.target.checked) this.endBatch();
            });
            document.getElementById('camera-pick').addEventListener('click', () => {
                this.closeCamera();
                // Drop `capture` so this opens the photo library rather than
                // bouncing straight back into the OS camera.
                const input = document.getElementById('label-capture');
                input.removeAttribute('capture');
                input.click();
            });

            // Mode toggle
            document.getElementById('mode-input').addEventListener('click', () => this.setMode('input'));
            document.getElementById('mode-output').addEventListener('click', () => this.setMode('output'));
            document.getElementById('mode-move').addEventListener('click', () => this.setMode('move'));
            document.getElementById('mode-inventory').addEventListener('click', () => this.setMode('inventory'));

            // Manual entry
            document.getElementById('manual-submit').addEventListener('click', () => this.handleManualBarcode());
            document.getElementById('manual-barcode').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.handleManualBarcode();
                }
            });

            // Chemical form
            document.getElementById('chem-form').addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitChemical();
            });
            document.getElementById('cancel-form').addEventListener('click', () => this.hideForm());

            // Output actions
            document.getElementById('confirm-dispose').addEventListener('click', () => this.disposeSelected());
            document.getElementById('output-search').addEventListener('input', () => {
                this.showOutputSelect(document.getElementById('output-search').value);
            });

            // Move actions
            document.getElementById('confirm-move').addEventListener('click', () => this.moveSelected());
            document.getElementById('move-search').addEventListener('input', () => {
                this.showMoveSelect(document.getElementById('move-search').value);
            });

            // Inventory search & filter
            document.getElementById('search-inventory').addEventListener('input', () => this.refreshInventory());
            document.getElementById('filter-status').addEventListener('change', () => this.refreshInventory());
            document.getElementById('filter-location').addEventListener('change', () => this.refreshInventory());

            // Export
            document.getElementById('export-active').addEventListener('click', () => this.exportXLSX('active'));
            document.getElementById('export-all').addEventListener('click', () => this.exportXLSX('all'));
            document.getElementById('export-log').addEventListener('click', () => this.exportActivityLog());
        }

        // ---- Mode Management ----
        setMode(mode) {
            this.mode = mode;
            document.body.className = 'mode-' + mode;
            window.scrollTo(0, 0);
            this.closeCamera();
            this.endBatch();

            document.getElementById('mode-input').classList.toggle('active', mode === 'input');
            document.getElementById('mode-output').classList.toggle('active', mode === 'output');
            document.getElementById('mode-move').classList.toggle('active', mode === 'move');
            document.getElementById('mode-inventory').classList.toggle('active', mode === 'inventory');

            // Show/hide sections based on mode
            document.getElementById('scanner-section').style.display = mode === 'input' ? '' : 'none';
            // Show Name in Add/Remove/Move, hide in Inventory
            document.getElementById('session-name').closest('.session-field').style.display = mode === 'inventory' ? 'none' : '';
            // Only show Location dropdown in Add mode
            document.getElementById('session-location').closest('.session-field').style.display = mode === 'input' ? '' : 'none';
            this.hideForm();
            this.hideOutputSelect();
            this.hideMoveSelect();

            // Inventory & export only visible in inventory mode
            document.getElementById('inventory-section').style.display = mode === 'inventory' ? '' : 'none';
            document.getElementById('export-section').style.display = mode === 'inventory' ? '' : 'none';

            if (mode === 'output') {
                document.getElementById('output-select').style.display = '';
                document.getElementById('output-search').value = '';
                document.getElementById('matching-bottles').innerHTML = '';
                document.getElementById('no-bottles-msg').style.display = 'none';
                document.getElementById('output-actions').style.display = 'none';
            } else if (mode === 'move') {
                document.getElementById('move-select').style.display = '';
                document.getElementById('move-search').value = '';
                document.getElementById('move-bottles').innerHTML = '';
                document.getElementById('move-no-msg').style.display = 'none';
                document.getElementById('move-destination').style.display = 'none';
                this.populateMoveLocations();
            } else if (mode === 'inventory') {
                this.populateLocationFilter();
                this.refreshInventory();
            }
        }

        // ---- Manual Entry ----
        async handleManualBarcode() {
            const input = document.getElementById('manual-barcode');
            const query = input.value.trim();
            if (!query) {
                showToast('Enter a product identifier.', 'error');
                return;
            }
            if (!this.getSessionName() || !this.getSessionLocation()) {
                showToast('Select your Name and Location first.', 'error');
                return;
            }
            input.value = '';

            const snapStatus = document.getElementById('snap-status');
            snapStatus.textContent = 'Looking up "' + query + '"...';
            snapStatus.className = 'lookup-status loading';

            try {
                // Parse vendor hint from query (e.g. "Sigma A4034" → vendor="Sigma", num="A4034")
                let vendor = '';
                let productNumber = query;
                const parts = query.match(/^(sigma|aldrich|fisher|thermo|vwr|avantor|alfa|tci|acros|millipore)\s+(.+)$/i);
                if (parts) {
                    vendor = parts[1];
                    productNumber = parts[2];
                }

                let result = null;
                let source = '';

                // Strategy 1: Gemini with Google Search grounding (most reliable — actually searches the web)
                if (this.getGeminiKey()) {
                    result = await this.textLookupWithGemini(query);
                    if (result && (result.productName || result.productNumber)) {
                        source = 'web search';
                    } else {
                        result = null;
                    }
                }

                // Strategy 2: PubChem lookup (fallback if no Gemini key or Gemini found nothing)
                if (!result) {
                    snapStatus.textContent = 'Searching PubChem...';
                    const pubchemResult = await this.pubchemLookup(vendor, productNumber);
                    if (pubchemResult && (pubchemResult.productName || pubchemResult.casNumber)) {
                        result = pubchemResult;
                        source = 'PubChem';
                    }
                }

                if (result) {
                    snapStatus.textContent = 'Found via ' + source + ': ' + (result.productName || 'info retrieved');
                    snapStatus.className = 'lookup-status success';

                    this.fillFormFromResult(result, productNumber, vendor);
                    document.getElementById('autofill-notice').textContent = 'Auto-filled from ' + source + '. Verify and edit as needed.';
                    document.getElementById('autofill-notice').style.display = '';

                    if (document.getElementById('auto-submit').checked) {
                        await this.submitChemical();
                    }
                    setTimeout(() => { snapStatus.textContent = ''; }, 3000);
                    return;
                }

                snapStatus.textContent = 'Not found. Fill in manually.';
                snapStatus.className = 'lookup-status error';
                setTimeout(() => { snapStatus.textContent = ''; }, 3000);
            } catch (e) {
                console.error('Lookup failed:', e);
                snapStatus.textContent = 'Lookup failed. Fill in manually.';
                snapStatus.className = 'lookup-status error';
                setTimeout(() => { snapStatus.textContent = ''; }, 3000);
            }

            // Open form with query pre-filled
            this.showInputForm(query);
        }

        fillFormFromResult(result, fallbackBarcode, fallbackVendor) {
            const form = document.getElementById('chemical-form');
            document.getElementById('chem-form').reset();
            this.setLookupStatus('');
            document.getElementById('vendor-link').style.display = 'none';

            const barcode = result.productNumber || fallbackBarcode;
            document.getElementById('f-barcode').value = barcode;
            if (result.vendor || result.foundVendor) document.getElementById('f-vendor').value = result.vendor || result.foundVendor;
            else if (fallbackVendor) document.getElementById('f-vendor').value = fallbackVendor;
            if (result.productNumber) document.getElementById('f-product-number').value = result.productNumber;
            if (result.productName) document.getElementById('f-product-name').value = result.productName;
            if (result.casNumber) document.getElementById('f-cas').value = result.casNumber;
            if (result.amount) document.getElementById('f-amount').value = result.amount;
            if (result.unit) {
                const unitMap = { 'g': 'g', 'kg': 'kg', 'mg': 'mg', 'ml': 'mL', 'l': 'L', 'ul': 'uL', 'oz': 'oz', 'lb': 'lb' };
                document.getElementById('f-unit').value = unitMap[(result.unit || '').toLowerCase()] || result.unit;
            }

            form.style.display = '';
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        async textLookupWithGemini(query) {
            // Unlike the label scan, a missing key here is not an error — the
            // caller falls back to PubChem.
            if (!this.getGeminiKey()) return null;

            const response = await this.geminiRequest({
                contents: [{
                    parts: [{
                        text: `Search for this chemical product and return its details: "${query}"

This could be a vendor catalog number with size (e.g. "G8270-1KG", "A4034-100G"), a plain catalog number (e.g. "S7653"), a chemical name (e.g. "sodium chloride"), a CAS number, or a vendor + product number (e.g. "Sigma A4034"). The size suffix (e.g. -1KG, -100G, -500ML) indicates the package size, not part of the product number.

Return ONLY valid JSON (no markdown, no code fences):
{
  "vendor": "vendor/manufacturer name (e.g. Sigma-Aldrich, Fisher Scientific)",
  "productNumber": "catalog number WITHOUT size suffix (e.g. G8270 not G8270-1KG)",
  "productName": "chemical name",
  "casNumber": "CAS registry number in format XXXXX-XX-X",
  "amount": "package size number from the query (e.g. 1 from -1KG, 100 from -100G)",
  "unit": "package unit (g, kg, mg, mL, L, etc.)"
}
If a field cannot be determined, use empty string "".`
                    }]
                }],
                tools: [{ google_search: {} }]
            });

            if (!response.ok) return null;
            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) return null;

            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try { return JSON.parse(jsonMatch[0]); } catch (e) { return null; }
            }
            return null;
        }

        // ---- Input Mode: Chemical Form ----
        async showInputForm(barcode) {
            const known = await this.db.getChemical(barcode);
            const form = document.getElementById('chemical-form');
            const notice = document.getElementById('autofill-notice');

            document.getElementById('f-barcode').value = barcode;
            this.setLookupStatus('');
            document.getElementById('vendor-link').style.display = 'none';

            if (known) {
                document.getElementById('f-vendor').value = known.vendor || '';
                document.getElementById('f-product-number').value = known.productNumber || '';
                document.getElementById('f-product-name').value = known.productName || '';
                document.getElementById('f-cas').value = known.casNumber || '';
                document.getElementById('f-amount').value = known.amount || '';
                document.getElementById('f-unit').value = known.unit || 'mL';
                document.getElementById('f-notes').value = '';
                notice.style.display = '';
            } else {
                document.getElementById('chem-form').reset();
                document.getElementById('f-barcode').value = barcode;
                notice.style.display = 'none';
            }

            form.style.display = '';
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        async submitChemical() {
            const barcode = document.getElementById('f-barcode').value;
            const vendor = document.getElementById('f-vendor').value.trim();
            const productNumber = document.getElementById('f-product-number').value.trim();
            const productName = document.getElementById('f-product-name').value.trim();
            const casNumber = document.getElementById('f-cas').value.trim();
            const amount = document.getElementById('f-amount').value.trim();
            const unit = document.getElementById('f-unit').value;
            const expiration = document.getElementById('f-expiration').value || '';
            const notes = document.getElementById('f-notes').value.trim();
            const location = this.getSessionLocation();
            const addedBy = this.getSessionName();

            if (!vendor || !productNumber || !productName || !amount) {
                showToast('Fill in all required fields.', 'error');
                feedbackError();
                return false;
            }

            if (this.editingId) {
                await this.saveEdit({ barcode, vendor, productNumber, productName, casNumber, amount, unit, expiration, notes });
                return true;
            }

            // Warn on a bottle that looks like one already on the same shelf —
            // usually a double-scan rather than a genuine second bottle.
            const existing = await this.db.getAllItems();
            const duplicates = existing.filter(i =>
                i.status === 'active' &&
                (i.productNumber || '').toLowerCase() === productNumber.toLowerCase() &&
                (i.location || '') === location
            );
            // Once you've confirmed you really are shelving several of the same
            // item, don't ask again for that item during this batch.
            const dupKey = productNumber.toLowerCase() + '|' + location;
            if (duplicates.length > 0 && !this.approvedDuplicates.has(dupKey)) {
                const proceed = confirm(
                    `${duplicates.length} active bottle${duplicates.length !== 1 ? 's' : ''} of ${productNumber} ` +
                    `${duplicates.length !== 1 ? 'are' : 'is'} already recorded at ${location || 'this location'}.\n\n` +
                    `Add another one anyway?`
                );
                if (!proceed) return false;
                this.approvedDuplicates.add(dupKey);
            }

            // Save chemical template for future auto-fill
            const templateSaved = await this.write(() => this.db.saveChemical({
                barcode,
                vendor,
                productNumber,
                productName,
                casNumber,
                amount,
                unit,
            }), 'Saving chemical details');
            if (!templateSaved) return false;

            // Create inventory item
            const item = {
                id: generateId(),
                barcode,
                vendor,
                productNumber,
                productName,
                casNumber,
                amount,
                unit,
                location,
                expiration,
                notes,
                addedBy,
                removedBy: null,
                status: 'active',
                dateIn: new Date().toISOString(),
                dateOut: null,
                history: [],
            };

            const ok = await this.write(() => this.db.addItem(item), 'Adding to inventory');
            if (!ok) return false;
            feedbackSuccess();
            showToast(`Added: ${productName} (${amount} ${unit})`, 'success');
            this.hideForm();
            this.refreshInventory();
            return true;
        }

        // ---- Editing an existing entry ----
        async startEdit(id) {
            const item = await this.db.getItem(id);
            if (!item) {
                showToast('Entry not found.', 'error');
                return;
            }

            this.setMode('input');
            this.editingId = id;

            document.getElementById('chem-form').reset();
            document.getElementById('f-barcode').value = item.barcode || '';
            document.getElementById('f-vendor').value = item.vendor || '';
            document.getElementById('f-product-number').value = item.productNumber || '';
            document.getElementById('f-product-name').value = item.productName || '';
            document.getElementById('f-cas').value = item.casNumber || '';
            document.getElementById('f-amount').value = item.amount || '';
            document.getElementById('f-unit').value = item.unit || 'mL';
            document.getElementById('f-expiration').value = item.expiration || '';
            document.getElementById('f-notes').value = item.notes || '';

            const locations = await this.db.getList('locations');
            this.populateSelect('f-location', locations.slice());
            document.getElementById('f-location').value = item.location || '';

            document.getElementById('form-title').textContent = 'Edit Entry';
            document.getElementById('form-submit').textContent = 'Save Changes';
            document.getElementById('f-location').closest('.form-group').style.display = '';
            document.getElementById('autofill-notice').style.display = 'none';
            this.setLookupStatus('');

            const form = document.getElementById('chemical-form');
            form.style.display = '';
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        async saveEdit(fields) {
            const item = await this.db.getItem(this.editingId);
            if (!item) {
                showToast('Entry no longer exists.', 'error');
                this.hideForm();
                return;
            }

            const by = this.getSessionName() || '';
            const at = new Date().toISOString();
            const newLocation = document.getElementById('f-location').value;
            if (newLocation && newLocation !== item.location) {
                this.addHistory(item, 'moved', { from: item.location || '', to: newLocation, by, at });
                item.location = newLocation;
            }
            Object.assign(item, fields);
            this.addHistory(item, 'edited', { by, at });

            const ok = await this.write(() => this.db.updateItem(item), 'Saving changes');
            if (!ok) return;
            feedbackSuccess();
            showToast('Updated: ' + item.productName, 'success');
            this.hideForm();
            this.setMode('inventory');
        }

        hideForm() {
            document.getElementById('chemical-form').style.display = 'none';
            this.editingId = null;
            document.getElementById('form-title').textContent = 'Add Chemical to Inventory';
            document.getElementById('form-submit').textContent = 'Add to Inventory';
            document.getElementById('f-location').closest('.form-group').style.display = 'none';
        }

        // ---- Output Mode: Select Bottles ----
        async showOutputSelect(searchQuery) {
            const query = (searchQuery || '').toLowerCase().trim();
            const list = document.getElementById('matching-bottles');
            const noMsg = document.getElementById('no-bottles-msg');
            const actions = document.getElementById('output-actions');

            // Require at least 2 chars to search
            if (query.length < 2) {
                list.innerHTML = '';
                noMsg.style.display = '';
                noMsg.textContent = 'Type to search chemicals...';
                actions.style.display = 'none';
                this.selectedBottles.clear();
                return;
            }

            const allItems = await this.db.getAllItems();
            const items = allItems.filter(i => i.status === 'active' && this.matchesQuery(i, query,
                ['productName', 'vendor', 'productNumber', 'casNumber', 'barcode', 'location']
            ));

            this.selectedBottles.clear();
            list.innerHTML = '';

            if (items.length === 0) {
                noMsg.style.display = '';
                noMsg.textContent = 'No matching chemicals found.';
                actions.style.display = 'none';
            } else {
                noMsg.style.display = 'none';
                actions.style.display = '';

                items.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'bottle-item';
                    div.innerHTML = `
                        <input type="checkbox" data-id="${item.id}">
                        <div class="bottle-info">
                            <div class="bottle-name">${this.esc(item.productName)}</div>
                            <div class="bottle-details">
                                ${this.esc(item.vendor)} &bull; ${this.esc(item.productNumber)}
                                ${item.casNumber ? ' &bull; CAS ' + this.esc(item.casNumber) : ''}
                                <br>${this.esc(item.amount)} ${this.esc(item.unit)}
                                ${item.location ? ' &bull; ' + this.esc(item.location) : ''}
                                ${item.addedBy ? '<br>Added by: ' + this.esc(item.addedBy) : ''}
                                <br>Added: ${formatDateShort(item.dateIn)}
                                ${item.notes ? ' &bull; ' + this.esc(item.notes) : ''}
                            </div>
                        </div>
                    `;

                    const checkbox = div.querySelector('input[type="checkbox"]');
                    div.addEventListener('click', (e) => {
                        if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
                        div.classList.toggle('selected', checkbox.checked);
                        if (checkbox.checked) {
                            this.selectedBottles.add(item.id);
                        } else {
                            this.selectedBottles.delete(item.id);
                        }
                    });

                    list.appendChild(div);
                });
            }
        }

        async disposeSelected() {
            if (this.selectedBottles.size === 0) {
                showToast('Select at least one bottle to remove.', 'error');
                return;
            }

            const now = new Date().toISOString();
            const removedBy = this.getSessionName();
            let count = 0;

            const ok = await this.write(async () => {
                for (const id of this.selectedBottles) {
                    const item = await this.db.getItem(id);
                    if (item && item.status === 'active') {
                        item.status = 'disposed';
                        item.dateOut = now;
                        item.removedBy = removedBy;
                        this.addHistory(item, 'disposed', { by: removedBy, at: now });
                        await this.db.updateItem(item);
                        count++;
                    }
                }
            }, 'Removing bottles');
            if (!ok) return;

            feedbackRemove();
            showToast(`Removed ${count} bottle${count !== 1 ? 's' : ''} from inventory.`, 'success');
            this.hideOutputSelect();
            this.refreshInventory();
        }

        hideOutputSelect() {
            document.getElementById('output-select').style.display = 'none';
            this.selectedBottles.clear();
        }

        // ---- Move Mode ----
        async populateMoveLocations() {
            const locations = await this.db.getList('locations');
            const sel = document.getElementById('move-location');
            while (sel.options.length > 1) sel.remove(1);
            locations.sort((a, b) => a.localeCompare(b));
            locations.forEach(loc => {
                const opt = document.createElement('option');
                opt.value = loc;
                opt.textContent = loc;
                sel.appendChild(opt);
            });
        }

        async showMoveSelect(searchQuery) {
            const query = (searchQuery || '').toLowerCase().trim();
            const list = document.getElementById('move-bottles');
            const noMsg = document.getElementById('move-no-msg');
            const destSection = document.getElementById('move-destination');

            // Require at least 2 chars to search
            if (query.length < 2) {
                list.innerHTML = '';
                noMsg.style.display = '';
                noMsg.textContent = 'Type to search chemicals...';
                destSection.style.display = 'none';
                this.selectedMoveBottles.clear();
                return;
            }

            const allItems = await this.db.getAllItems();
            const items = allItems.filter(i => i.status === 'active' && this.matchesQuery(i, query,
                ['productName', 'vendor', 'productNumber', 'casNumber', 'location']
            ));

            this.selectedMoveBottles.clear();
            list.innerHTML = '';

            if (items.length === 0) {
                noMsg.style.display = '';
                destSection.style.display = 'none';
            } else {
                noMsg.style.display = 'none';
                destSection.style.display = '';

                items.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'bottle-item';
                    div.innerHTML = `
                        <input type="checkbox" data-id="${item.id}">
                        <div class="bottle-info">
                            <div class="bottle-name">${this.esc(item.productName)}</div>
                            <div class="bottle-details">
                                ${this.esc(item.vendor)} &bull; ${this.esc(item.productNumber)}
                                <br>${this.esc(item.amount)} ${this.esc(item.unit)}
                                ${item.location ? ' &bull; <strong>' + this.esc(item.location) + '</strong>' : ''}
                            </div>
                        </div>
                    `;
                    const checkbox = div.querySelector('input[type="checkbox"]');
                    div.addEventListener('click', (e) => {
                        if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
                        div.classList.toggle('selected', checkbox.checked);
                        if (checkbox.checked) this.selectedMoveBottles.add(item.id);
                        else this.selectedMoveBottles.delete(item.id);
                    });
                    list.appendChild(div);
                });
            }
        }

        async moveSelected() {
            if (this.selectedMoveBottles.size === 0) {
                showToast('Select at least one bottle to move.', 'error');
                feedbackError();
                return;
            }
            const newLocation = document.getElementById('move-location').value;
            if (!newLocation) {
                showToast('Select a destination location.', 'error');
                feedbackError();
                return;
            }
            const movedBy = this.getSessionName();
            if (!movedBy) {
                showToast('Select your Name first.', 'error');
                return;
            }

            const now = new Date().toISOString();
            let count = 0;
            const ok = await this.write(async () => {
                for (const id of this.selectedMoveBottles) {
                    const item = await this.db.getItem(id);
                    if (item && item.status === 'active') {
                        // Record the move in history rather than appending to notes,
                        // which used to grow unreadable after a few relocations.
                        this.addHistory(item, 'moved', { from: item.location || '', to: newLocation, by: movedBy, at: now });
                        item.location = newLocation;
                        await this.db.updateItem(item);
                        count++;
                    }
                }
            }, 'Moving bottles');
            if (!ok) return;

            feedbackSuccess();
            showToast(`Moved ${count} bottle${count !== 1 ? 's' : ''} to ${newLocation}.`, 'success');
            this.selectedMoveBottles.clear();
            document.getElementById('move-search').value = '';
            this.showMoveSelect('');
            this.refreshInventory();
        }

        hideMoveSelect() {
            document.getElementById('move-select').style.display = 'none';
            this.selectedMoveBottles.clear();
        }

        // ---- Inventory Display ----
        async populateLocationFilter() {
            const locations = await this.db.getList('locations');
            this.populateSelect('filter-location', locations.slice());
        }

        async refreshInventory() {
            const allItems = await this.db.getAllItems();
            const search = document.getElementById('search-inventory').value.toLowerCase().trim();
            const filterStatus = document.getElementById('filter-status').value;
            const filterLocation = document.getElementById('filter-location').value;

            // Update count badge
            const activeCount = allItems.filter(i => i.status === 'active').length;
            document.getElementById('inventory-count').textContent = activeCount;

            const listEl = document.getElementById('inventory-list');
            const emptyEl = document.getElementById('inventory-empty');

            this.renderExpiryBanner(allItems);

            // A search term is normally required so we don't render hundreds of
            // cards, but picking a location or the Expiring filter is itself a
            // narrowing choice — those browse without one.
            const browsing = !!filterLocation || filterStatus === 'expiring';
            if (search.length < 2 && !browsing) {
                listEl.innerHTML = '';
                emptyEl.style.display = '';
                emptyEl.textContent = activeCount > 0
                    ? activeCount + ' item' + (activeCount !== 1 ? 's' : '') + ' in inventory. Search, or pick a location to browse.'
                    : 'No items in inventory yet. Scan a chemical to get started.';
                return;
            }

            let items = allItems;

            // Filter by status
            if (filterStatus === 'expiring') {
                items = items.filter(i => expiryState(i));
            } else if (filterStatus !== 'all') {
                items = items.filter(i => i.status === filterStatus);
            }

            if (filterLocation) {
                items = items.filter(i => (i.location || '') === filterLocation);
            }

            // Search
            if (search) {
                items = items.filter(i => this.matchesQuery(i, search,
                    ['productName', 'vendor', 'productNumber', 'casNumber', 'location', 'addedBy', 'notes']
                ));
            }

            // Sort: active first, then soonest expiry, then newest
            items.sort((a, b) => {
                if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
                const ea = daysUntil(a.expiration), eb = daysUntil(b.expiration);
                if (filterStatus === 'expiring' && ea !== null && eb !== null) return ea - eb;
                return new Date(b.dateIn) - new Date(a.dateIn);
            });

            if (items.length === 0) {
                listEl.innerHTML = '';
                emptyEl.style.display = '';
                emptyEl.textContent = search
                    ? 'No results for "' + search + '".'
                    : 'Nothing here.';
                return;
            }

            emptyEl.style.display = 'none';
            listEl.innerHTML = items.map(item => {
                const expiry = expiryState(item);
                return `
                <div class="inv-card ${item.status === 'disposed' ? 'disposed' : ''} ${expiry ? expiry.level : ''}">
                    <div class="inv-header">
                        <div class="inv-name">${this.esc(item.productName)}</div>
                        ${expiry ? `<span class="inv-status ${expiry.level}">${expiry.label}</span>` : ''}
                        <span class="inv-status ${item.status}">${item.status}</span>
                    </div>
                    <div class="inv-meta">
                        <div><strong>Vendor:</strong> ${this.esc(item.vendor)}</div>
                        <div><strong>Product #:</strong> ${this.esc(item.productNumber)}</div>
                        <div><strong>CAS:</strong> ${this.esc(item.casNumber || '—')}</div>
                        <div><strong>Amount:</strong> ${this.esc(item.amount)} ${this.esc(item.unit)}</div>
                        ${item.location ? `<div><strong>Location:</strong> ${this.esc(item.location)}</div>` : ''}
                        ${item.expiration ? `<div><strong>Expires:</strong> ${this.esc(item.expiration)}</div>` : ''}
                        ${item.addedBy ? `<div><strong>Added by:</strong> ${this.esc(item.addedBy)}</div>` : ''}
                        ${item.removedBy ? `<div><strong>Removed by:</strong> ${this.esc(item.removedBy)}</div>` : ''}
                        ${item.notes ? `<div><strong>Notes:</strong> ${this.esc(item.notes)}</div>` : ''}
                    </div>
                    <div class="inv-dates">
                        In: ${formatDate(item.dateIn)}
                        ${item.dateOut ? ' &bull; Out: ' + formatDate(item.dateOut) : ''}
                        ${this.formatMoveHistory(item)}
                    </div>
                    <div class="inv-actions">
                        ${item.status === 'active'
                            ? `<button class="btn btn-danger" onclick="app.disposeSingle('${item.id}')">Dispose</button>`
                            : `<button class="btn btn-success" onclick="app.reactivate('${item.id}')">Reactivate</button>`
                        }
                        <button class="btn btn-secondary" onclick="app.startEdit('${item.id}')">Edit</button>
                        <button class="btn btn-secondary" onclick="app.deleteItem('${item.id}')">Delete</button>
                    </div>
                </div>
            `;
            }).join('');
        }

        formatMoveHistory(item) {
            const moves = (item.history || []).filter(h => h.action === 'moved');
            if (moves.length === 0) return '';
            const last = moves[moves.length - 1];
            const extra = moves.length > 1 ? ` (${moves.length} moves)` : '';
            return `<br>Moved from ${this.esc(last.from || '—')} by ${this.esc(last.by || '—')} on ${formatDateShort(last.at)}${extra}`;
        }

        renderExpiryBanner(allItems) {
            const banner = document.getElementById('expiry-banner');
            if (!banner) return;
            const states = allItems.map(expiryState).filter(Boolean);
            const expired = states.filter(s => s.level === 'expired').length;
            const soon = states.filter(s => s.level === 'expiring').length;
            if (expired === 0 && soon === 0) {
                banner.style.display = 'none';
                return;
            }
            const parts = [];
            if (expired) parts.push(expired + ' expired');
            if (soon) parts.push(soon + ' expiring within ' + EXPIRY_WARN_DAYS + ' days');
            banner.textContent = parts.join(' · ');
            banner.style.display = '';
        }

        async disposeSingle(id) {
            const item = await this.db.getItem(id);
            if (!item) return;
            const now = new Date().toISOString();
            const by = this.getSessionName() || '';
            const ok = await this.write(async () => {
                item.status = 'disposed';
                item.dateOut = now;
                item.removedBy = by;
                this.addHistory(item, 'disposed', { by, at: now });
                await this.db.updateItem(item);
            }, 'Disposing bottle');
            if (!ok) return;
            showToast('Marked as disposed.', 'success');
            this.refreshInventory();
        }

        async reactivate(id) {
            const item = await this.db.getItem(id);
            if (!item) return;
            const ok = await this.write(async () => {
                item.status = 'active';
                item.dateOut = null;
                this.addHistory(item, 'reactivated', { by: this.getSessionName() || '', at: new Date().toISOString() });
                await this.db.updateItem(item);
            }, 'Reactivating bottle');
            if (!ok) return;
            showToast('Reactivated.', 'success');
            this.refreshInventory();
        }

        async deleteItem(id) {
            if (!confirm('Permanently delete this entry? This cannot be undone.')) return;
            const ok = await this.write(() => this.db.deleteItem(id), 'Deleting entry');
            if (!ok) return;
            showToast('Entry deleted.', 'success');
            this.refreshInventory();
        }

        // ---- XLSX Export ----
        async exportXLSX(filter) {
            const allItems = await this.db.getAllItems();
            let items = allItems;

            if (filter === 'active') {
                items = items.filter(i => i.status === 'active');
            }

            if (items.length === 0) {
                showToast('No items to export.', 'error');
                return;
            }

            // Sort by product name, then date
            items.sort((a, b) =>
                (a.productName || '').localeCompare(b.productName || '') ||
                new Date(a.dateIn) - new Date(b.dateIn)
            );

            // Build summary sheet: group by product number, count bottles
            const grouped = {};
            items.forEach(item => {
                const key = item.productNumber || item.productName;
                if (!grouped[key]) {
                    grouped[key] = {
                        vendor: item.vendor,
                        productNumber: item.productNumber,
                        productName: item.productName,
                        casNumber: item.casNumber,
                        amount: item.amount + ' ' + item.unit,
                        locations: new Set(),
                        addedBy: new Set(),
                        expirations: new Set(),
                        notes: [],
                        activeBottles: 0,
                        disposedBottles: 0,
                    };
                }
                if (item.location) grouped[key].locations.add(item.location);
                if (item.addedBy) grouped[key].addedBy.add(item.addedBy);
                if (item.expiration) grouped[key].expirations.add(item.expiration);
                if (item.notes) grouped[key].notes.push(item.notes);
                if (item.status === 'active') grouped[key].activeBottles++;
                else grouped[key].disposedBottles++;
            });

            const summaryData = Object.values(grouped).map(g => ({
                'Vendor': g.vendor,
                'Product Number': g.productNumber,
                'Product Name': g.productName,
                'CAS Number': g.casNumber,
                'Amount Per Bottle': g.amount,
                'Location': [...g.locations].join(', '),
                'Active Bottles': g.activeBottles,
                'Disposed Bottles': g.disposedBottles,
                'Added By': [...g.addedBy].join(', '),
                'Expiration': [...g.expirations].join(', '),
                'Notes': g.notes.join('; '),
            }));

            // Build detail sheet: one row per bottle
            const detailData = items.map(item => ({
                'Vendor': item.vendor,
                'Product Number': item.productNumber,
                'Product Name': item.productName,
                'CAS Number': item.casNumber || '',
                'Amount': item.amount,
                'Unit': item.unit,
                'Location': item.location || '',
                'Status': item.status,
                'Expiration': item.expiration || '',
                'Added By': item.addedBy || '',
                'Date Added': formatDate(item.dateIn),
                'Removed By': item.removedBy || '',
                'Date Removed': item.dateOut ? formatDate(item.dateOut) : '',
                'Notes': item.notes || '',
            }));

            const wb = XLSX.utils.book_new();

            const summarySheet = XLSX.utils.json_to_sheet(summaryData);
            this.autoWidth(summarySheet, summaryData);
            XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

            const detailSheet = XLSX.utils.json_to_sheet(detailData);
            this.autoWidth(detailSheet, detailData);
            XLSX.utils.book_append_sheet(wb, detailSheet, 'All Bottles');

            const filename = `Chemical_Inventory_${filter}_${new Date().toISOString().slice(0, 10)}.xlsx`;
            XLSX.writeFile(wb, filename);
            showToast('Exported: ' + filename, 'success');
        }

        async exportActivityLog() {
            const allItems = await this.db.getAllItems();
            if (allItems.length === 0) {
                showToast('No items to export.', 'error');
                return;
            }

            // Build log entries: one per "in", "out", and recorded move.
            // Sorting happens on the raw ISO timestamp — re-parsing a formatted
            // locale string gives NaN in some browsers and scrambles the order.
            const logEntries = [];
            const entry = (item, iso, action, person, location, notes) => ({
                _ts: iso || '',
                'Date': formatDate(iso),
                'Action': action,
                'Person': person || '',
                'Product Name': item.productName,
                'Vendor': item.vendor,
                'Product Number': item.productNumber,
                'CAS Number': item.casNumber || '',
                'Amount': item.amount + ' ' + item.unit,
                'Location': location || '',
                'Notes': notes || '',
            });

            allItems.forEach(item => {
                logEntries.push(entry(item, item.dateIn, 'IN', item.addedBy, item.location, item.notes));
                (item.history || [])
                    .filter(h => h.action === 'moved')
                    .forEach(h => logEntries.push(
                        entry(item, h.at, 'MOVE', h.by, h.to, 'From: ' + (h.from || '—'))
                    ));
                if (item.dateOut) {
                    logEntries.push(entry(item, item.dateOut, 'OUT', item.removedBy, item.location, item.notes));
                }
            });

            logEntries.sort((a, b) => a._ts.localeCompare(b._ts));
            logEntries.forEach(e => delete e._ts);

            const wb = XLSX.utils.book_new();
            const sheet = XLSX.utils.json_to_sheet(logEntries);
            this.autoWidth(sheet, logEntries);
            XLSX.utils.book_append_sheet(wb, sheet, 'Activity Log');

            const filename = `Chemical_Activity_Log_${new Date().toISOString().slice(0, 10)}.xlsx`;
            XLSX.writeFile(wb, filename);
            showToast('Exported: ' + filename, 'success');
        }

        autoWidth(sheet, data) {
            if (!data.length) return;
            const keys = Object.keys(data[0]);
            sheet['!cols'] = keys.map(key => {
                const maxLen = Math.max(
                    key.length,
                    ...data.map(row => String(row[key] || '').length)
                );
                return { wch: Math.min(maxLen + 2, 40) };
            });
        }

        // ---- Utility ----
        // Runs a database mutation and reports failures to the user. Without this
        // a dropped connection rejects silently and the entry is quietly lost.
        async write(operation, description) {
            try {
                await operation();
                return true;
            } catch (e) {
                console.error(description + ' failed:', e);
                feedbackError();
                showToast(description + ' failed — ' + (e.message || 'check your connection.'), 'error');
                return false;
            }
        }

        // Appends an audit entry to an item. Kept on the item itself so it
        // travels with the record and feeds the exported activity log.
        addHistory(item, action, details) {
            if (!Array.isArray(item.history)) item.history = [];
            item.history.push(Object.assign({ action }, details));
            return item;
        }

        // Splits the query on whitespace and requires every token to appear
        // somewhere in the item, so "sigma sodium" matches regardless of order.
        matchesQuery(item, query, fields) {
            const tokens = (query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
            if (tokens.length === 0) return true;
            const haystack = fields
                .map(f => (item[f] || '').toString().toLowerCase())
                .join('   ');
            return tokens.every(t => haystack.includes(t));
        }

        esc(str) {
            if (!str) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }
    }

    // ==================== Initialize ====================
    const app = new App();
    window.app = app; // expose for inline onclick handlers

    app.init().catch(err => {
        console.error('Failed to initialize:', err);
        showToast('Failed to initialize database.', 'error');
    });
})();
