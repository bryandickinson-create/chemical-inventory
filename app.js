// ============================================================
// Chemical Inventory Scanner - Application Logic
// ============================================================
// Uses IndexedDB for persistent local storage, html5-qrcode
// for camera barcode scanning, and SheetJS for XLSX export.
// ============================================================

(function () {
    'use strict';

    // Candidate models for label vision and web-grounded text lookup, tried in
    // order until one the account can actually use responds. Google retires
    // models for new accounts (2.5-flash-lite is already gone for them) and the
    // "-lite" tiers carry the largest free-tier daily quotas, so lead with the
    // current lite models and fall back to the flagship flash, which every
    // account can use. The first model that works is remembered per device so
    // later calls skip the dead ones. Order matters: quota-friendly first.
    const GEMINI_MODELS = [
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-3.6-flash',
        'gemini-2.5-flash',
    ];
    const GEMINI_MODEL_STORE = 'geminiModel';

    // ==================== Database ====================
    class ChemDB {
        constructor() {
            this.db = null;
        }

        async init() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open('ChemicalInventory', 5);
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
                    // Audit trail for actions that destroy the record itself,
                    // so a deletion still leaves a trace of who did it.
                    if (!db.objectStoreNames.contains('audit')) {
                        db.createObjectStore('audit', { keyPath: 'id' });
                    }
                    // Item photos, keyed by item id. Kept in their own store (and
                    // their own Firebase node) so the frequent full-inventory
                    // reads never drag image data along.
                    if (!db.objectStoreNames.contains('photos')) {
                        db.createObjectStore('photos', { keyPath: 'id' });
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

        // Per-entry edits. Locally there's no concurrency, so these are just a
        // read-modify-write of the mirrored array — the merge-safety that
        // matters lives in the Firebase layer.
        async addListEntry(key, value) {
            const items = await this.getList(key);
            if (!items.includes(value)) items.push(value);
            return this.saveList(key, items);
        }

        async removeListEntry(key, value) {
            const items = (await this.getList(key)).filter(v => v !== value);
            return this.saveList(key, items);
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

        // -- Audit trail --
        async addAudit(entry) {
            return this._req(this._tx('audit', 'readwrite').put(entry));
        }

        async getAllAudit() {
            return this._req(this._tx('audit', 'readonly').getAll());
        }

        // -- Item photos (thumbnail per item) --
        async savePhoto(id, photo) {
            return this._req(this._tx('photos', 'readwrite').put({ id, ...photo }));
        }

        async getPhoto(id) {
            return this._req(this._tx('photos', 'readonly').get(id));
        }

        async deletePhoto(id) {
            return this._req(this._tx('photos', 'readwrite').delete(id));
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
        // Entries are stored one-per-node under lists/<key>/entries/<slug> so
        // two devices editing the same list touch different children and merge
        // instead of clobbering. The legacy whole-array at lists/<key>/items is
        // still read (and honoured on removal) so nothing already stored is lost.
        _slug(value) {
            // Hex of the UTF-8 bytes: collision-free and free of the characters
            // Firebase forbids in keys (. $ # [ ] /).
            const bytes = new TextEncoder().encode(value == null ? '' : String(value));
            let s = '';
            for (const b of bytes) s += b.toString(16).padStart(2, '0');
            return s || '_';
        }

        _normalizeList(data) {
            const out = [];
            const seen = new Set();
            const add = (v) => {
                if (typeof v === 'string' && v !== '' && !seen.has(v)) { seen.add(v); out.push(v); }
            };
            if (data && data.items) {
                (Array.isArray(data.items) ? data.items : Object.values(data.items)).forEach(add);
            }
            if (data && data.entries) {
                Object.values(data.entries).forEach(add);
            }
            return out;
        }

        async getList(key) {
            const data = await this._get('lists/' + key);
            return this._normalizeList(data);
        }

        async addListEntry(key, value) {
            return this._set('lists/' + key + '/entries/' + this._slug(value), value);
        }

        // Legacy: only reached when a whole-list op queued before this version
        // finally drains. Writes just the items subnode so it can't wipe the
        // per-entry map that replaced it.
        async saveList(key, items) {
            return this._set('lists/' + key + '/items', items);
        }

        async removeListEntry(key, value) {
            // Drop the per-entry node, and also filter any legacy array so the
            // value can't reappear through the backward-compatible merge.
            await this._delete('lists/' + key + '/entries/' + this._slug(value)).catch(() => {});
            const data = await this._get('lists/' + key);
            if (data && data.items) {
                const items = (Array.isArray(data.items) ? data.items : Object.values(data.items))
                    .filter(v => v !== value);
                await this._set('lists/' + key + '/items', items);
            }
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

        // -- Audit trail --
        async addAudit(entry) {
            return this._set('audit/' + entry.id, entry);
        }

        async getAllAudit() {
            const data = await this._get('audit');
            return data ? Object.values(data) : [];
        }

        // -- Item photos (own node, fetched only on demand) --
        async savePhoto(id, photo) {
            return this._set('photos/' + id, photo);
        }

        async getPhoto(id) {
            const data = await this._get('photos/' + id);
            return data || null;
        }

        async deletePhoto(id) {
            return this._delete('photos/' + id);
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
            // A newer op supersedes the older one for the same target. For most
            // kinds that's the record key; for per-entry list ops the target is
            // (list key + value), so adding two different names both survive.
            const sameTarget = (p) => {
                if (p.kind !== op.kind) return false;
                if (op.kind === 'listAdd' || op.kind === 'listRemove') {
                    return p.key === op.key && p.value === op.value;
                }
                return p.key === op.key;
            };
            this.pending = this.pending.filter(p => !sameTarget(p));
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
            if (op.kind === 'list') return this.remote.saveList(op.key, op.value); // legacy queued ops
            if (op.kind === 'listAdd') return this.remote.addListEntry(op.key, op.value);
            if (op.kind === 'listRemove') return this.remote.removeListEntry(op.key, op.value);
            if (op.kind === 'audit') return this.remote.addAudit(op.value);
            if (op.kind === 'photo') return op.value ? this.remote.savePhoto(op.key, op.value) : this.remote.deletePhoto(op.key);
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
            let base;
            try {
                base = await this.remote.getList(key);
                this._setOnline(true);
                this.local.saveList(key, base).catch(() => { /* mirror is best-effort */ });
            } catch (e) {
                this._setOnline(false);
                base = await this.local.getList(key);
            }
            // Overlay only this device's unsynced entry edits. Crucially the
            // real DB is the base, so a stuck queue can never hide entries that
            // exist remotely — it can only surface an add you haven't synced yet.
            return this._applyPendingList(key, base);
        }

        // Applies queued per-entry list ops onto a freshly-read list, in order.
        _applyPendingList(key, base) {
            const out = [];
            const seen = new Set();
            const add = (v) => { if (!seen.has(v)) { seen.add(v); out.push(v); } };
            (base || []).forEach(add);
            for (const p of this.pending) {
                if (p.key !== key) continue;
                if (p.kind === 'listAdd') add(p.value);
                else if (p.kind === 'listRemove') {
                    const i = out.indexOf(p.value);
                    if (i >= 0) { out.splice(i, 1); seen.delete(p.value); }
                } else if (p.kind === 'list' && Array.isArray(p.value)) {
                    // A legacy whole-list op still draining: union it in so its
                    // additions show, but never let it hide the live list.
                    p.value.forEach(add);
                }
            }
            return out;
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

        addListEntry(key, value) {
            return this._write(
                () => this.local.addListEntry(key, value),
                () => this.remote.addListEntry(key, value),
                { kind: 'listAdd', key, value }
            );
        }

        removeListEntry(key, value) {
            return this._write(
                () => this.local.removeListEntry(key, value),
                () => this.remote.removeListEntry(key, value),
                { kind: 'listRemove', key, value }
            );
        }

        addAudit(entry) {
            return this._write(
                () => this.local.addAudit(entry),
                () => this.remote.addAudit(entry),
                { kind: 'audit', key: entry.id, value: entry }
            );
        }

        async getAllAudit() {
            try {
                const entries = await this.remote.getAllAudit();
                this._setOnline(true);
                return entries;
            } catch (e) {
                this._setOnline(false);
                return this.local.getAllAudit();
            }
        }

        // -- Item photos --
        savePhoto(id, photo) {
            return this._write(
                () => this.local.savePhoto(id, photo),
                () => this.remote.savePhoto(id, photo),
                { kind: 'photo', key: id, value: photo }
            );
        }

        deletePhoto(id) {
            return this._write(
                () => this.local.deletePhoto(id),
                () => this.remote.deletePhoto(id),
                { kind: 'photo', key: id, value: null }
            );
        }

        async getPhoto(id) {
            const queued = this.pending.find(p => p.kind === 'photo' && p.key === id);
            if (queued) return queued.value;
            try {
                const photo = await this.remote.getPhoto(id);
                this._setOnline(true);
                if (photo) this.local.savePhoto(id, photo).catch(() => { /* mirror best-effort */ });
                return photo;
            } catch (e) {
                this._setOnline(false);
                return this.local.getPhoto(id);
            }
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
    // Long IUPAC names wrap to three or four lines and swallow the controls
    // underneath, so trim rather than relying on a CSS clamp.
    const TOAST_MAX_CHARS = 64;

    function showToast(message, type = '') {
        const toast = document.getElementById('toast');
        toast.textContent = message.length > TOAST_MAX_CHARS
            ? message.slice(0, TOAST_MAX_CHARS - 1).trimEnd() + '…'
            : message;
        // Visibility is driven by a class, not an inline style, so the
        // stylesheet can control layout (line clamping, camera positioning).
        toast.className = 'toast show' + (type ? ' ' + type : '');
        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => {
            toast.className = 'toast' + (type ? ' ' + type : '');
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
            this.mode = 'input'; // 'input' or 'inventory'
            this.movingId = null; // item being relocated via the move modal
            this.modalTarget = null; // 'names' or 'locations'
            this.editingId = null;   // set while the form is editing an existing entry
            this.cameraStream = null; // live MediaStream while the in-app camera is open
            this.batchCount = 0;      // bottles added in the current auto-add run
            this.approvedDuplicates = new Set(); // "productNumber|location" the user already OK'd this batch
            this.expandedGroups = new Set(); // group keys currently expanded in the inventory list
            this.pendingShots = [];  // extra photos of the current label, awaiting analysis together
            this.pendingPhoto = null; // source image for the form in progress, saved as the item's thumbnail
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
                // No Firebase configured: this device keeps its own private
                // inventory. Say so loudly — silently diverging from everyone
                // else looks identical to a sync bug.
                this.db = new ChemDB();
                await this.db.init();
                this.localOnly = true;
                this.renderLocalOnlyStatus();
                showToast('Not connected to the lab database — this device is on its own. Open Settings.', 'error');
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
        renderLocalOnlyStatus() {
            const el = document.getElementById('sync-status');
            if (!el) return;
            el.textContent = 'Local';
            el.className = 'sync-status local';
            el.title = 'This device is not connected to the shared lab database.';
        }

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
            const [names, locations, labels, used] = await Promise.all([
                this.db.getList('names'),
                this.db.getList('locations'),
                this.db.getList('labels'),
                this.collectUsedValues(),
            ]);
            // Union the managed list with values that actually appear on the
            // inventory. The managed lists can drift or (before the per-entry
            // fix) be clobbered, but a name/location that's in use must never
            // vanish from the dropdowns — so it's recovered straight from the
            // items, the same place Export reads it from.
            this.populateSelect('session-name', [...new Set([...names, ...used.names])]);
            this.populateSelect('session-location', [...new Set([...locations, ...used.locations])]);
            // Label is a type-ahead box, so its known values feed a datalist.
            this.populateDatalist('label-suggestions', [...new Set([...labels, ...used.labels])]);
        }

        // Every name/location/label referenced anywhere on the inventory records.
        async collectUsedValues() {
            const items = await this.db.getAllItems();
            const names = new Set();
            const locations = new Set();
            const labels = new Set();
            items.forEach(i => {
                if (i.location) locations.add(i.location);
                if (i.label) labels.add(i.label);
                if (i.addedBy) names.add(i.addedBy);
                if (i.removedBy) names.add(i.removedBy);
                (i.history || []).forEach(h => {
                    if (h.by) names.add(h.by);
                    if (h.from) locations.add(h.from);
                    if (h.to) locations.add(h.to);
                });
            });
            return { names: [...names], locations: [...locations], labels: [...labels] };
        }

        // Normalises a typed label: snaps to an existing spelling if one differs
        // only by case/spacing (so "f1-a1" joins "F1-A1" instead of forking it),
        // otherwise registers the new label so it shows up in the type-ahead.
        async canonicalLabel(value) {
            const label = (value || '').trim();
            if (!label) return '';
            const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
            const known = [...new Set([
                ...(await this.db.getList('labels')),
                ...(await this.collectUsedValues()).labels,
            ])];
            const match = known.find(k => norm(k) === norm(label));
            if (match) return match;
            try { await this.db.addListEntry('labels', label); } catch (e) { /* best-effort */ }
            return label;
        }

        populateDatalist(id, items) {
            const dl = document.getElementById(id);
            if (!dl) return;
            dl.innerHTML = '';
            [...items].sort((a, b) => a.localeCompare(b)).forEach(v => {
                const opt = document.createElement('option');
                opt.value = v;
                dl.appendChild(opt);
            });
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

        getSessionLabel() {
            return document.getElementById('session-label').value.trim();
        }

        saveSession() {
            try {
                localStorage.setItem('chem_session_name', this.getSessionName());
                localStorage.setItem('chem_session_location', this.getSessionLocation());
                localStorage.setItem('chem_session_label', this.getSessionLabel());
            } catch (e) { /* ignore */ }
        }

        restoreSession() {
            try {
                const name = localStorage.getItem('chem_session_name');
                const loc = localStorage.getItem('chem_session_location');
                const label = localStorage.getItem('chem_session_label');
                if (name) document.getElementById('session-name').value = name;
                if (loc) document.getElementById('session-location').value = loc;
                if (label) document.getElementById('session-label').value = label;
            } catch (e) { /* ignore */ }
        }

        // ---- List Edit Modal ----
        openModal(target) {
            this.modalTarget = target;
            const noun = { names: 'Names', locations: 'Locations', labels: 'Labels' }[target] || 'List';
            document.getElementById('modal-title').textContent = 'Edit ' + noun;
            const addNoun = { names: 'name', locations: 'location', labels: 'label' }[target] || 'entry';
            document.getElementById('modal-new-item').placeholder = 'Add new ' + addNoun + '...';
            document.getElementById('modal-new-item').value = '';
            document.getElementById('list-modal').style.display = '';
            this.refreshModalList();
        }

        closeModal() {
            document.getElementById('list-modal').style.display = 'none';
            this.modalTarget = null;
        }

        // How many inventory entries reference each list value, so removing one
        // is an informed decision rather than a blind tap.
        async countListUsage(target) {
            const items = await this.db.getAllItems();
            const counts = new Map();
            const bump = v => { if (v) counts.set(v, (counts.get(v) || 0) + 1); };
            items.forEach(i => {
                if (target === 'locations') {
                    bump(i.location);
                } else if (target === 'labels') {
                    bump(i.label);
                } else {
                    // A person can be attached as adder, remover, or via history.
                    const people = new Set([i.addedBy, i.removedBy].filter(Boolean));
                    (i.history || []).forEach(h => h.by && people.add(h.by));
                    people.forEach(bump);
                }
            });
            return counts;
        }

        async refreshModalList() {
            // Same union as the dropdowns: show managed entries plus any value
            // that's live on the inventory, so the manager matches what people
            // actually see and can rename/merge a recovered entry.
            const stored = await this.db.getList(this.modalTarget);
            const used = (await this.collectUsedValues())[this.modalTarget] || [];
            const items = [...new Set([...stored, ...used])];
            const ul = document.getElementById('modal-list');
            const emptyMsg = document.getElementById('modal-empty');

            if (items.length === 0) {
                ul.innerHTML = '';
                emptyMsg.style.display = '';
                return;
            }
            emptyMsg.style.display = 'none';
            const counts = await this.countListUsage(this.modalTarget);
            items.sort((a, b) => a.localeCompare(b));
            ul.innerHTML = items.map(item => {
                const n = counts.get(item) || 0;
                return `
                <li>
                    <span>
                        ${this.esc(item)}
                        <span class="list-usage">${n ? n + (n === 1 ? ' entry' : ' entries') : 'unused'}</span>
                    </span>
                    <span class="list-actions">
                        <button class="rename-btn" data-item="${this.esc(item)}" title="Rename">&#9998;</button>
                        <button class="remove-btn" data-item="${this.esc(item)}" title="Remove">&times;</button>
                    </span>
                </li>
            `;
            }).join('');

            ul.querySelectorAll('.remove-btn').forEach(btn => {
                btn.addEventListener('click', () => this.removeListItem(btn.dataset.item));
            });
            ul.querySelectorAll('.rename-btn').forEach(btn => {
                btn.addEventListener('click', () => this.renameListItem(btn.dataset.item));
            });
        }

        // Renaming rewrites every entry that uses the value, so the list and
        // the data can't drift apart the way a remove-and-re-add would.
        async renameListItem(oldValue) {
            const target = this.modalTarget;
            const noun = target === 'locations' ? 'location' : 'name';
            const typed = prompt(`Rename ${noun} "${oldValue}" to:`, oldValue);
            if (typed === null) return;
            const newValue = typed.trim();
            if (!newValue || newValue === oldValue) return;

            const list = await this.db.getList(target);
            const merging = list.some(i => i !== oldValue && i.toLowerCase() === newValue.toLowerCase());
            const counts = await this.countListUsage(target);
            const affected = counts.get(oldValue) || 0;
            const plural = affected === 1 ? 'entry' : 'entries';

            if (affected > 0 || merging) {
                const message = merging
                    ? `"${newValue}" already exists.\n\nMerge "${oldValue}" into it? ${affected} ${plural} will be relabelled and "${oldValue}" removed from the list.`
                    : `Rename "${oldValue}" to "${newValue}"?\n\n${affected} inventory ${plural} will be updated to match.`;
                if (!confirm(message)) return;
            }

            // Remember whether this value is the active session selection, so
            // the user isn't silently deselected by their own rename.
            const nameSel = document.getElementById('session-name');
            const locSel = document.getElementById('session-location');
            const reselectName = target === 'names' && nameSel.value === oldValue;
            const reselectLoc = target === 'locations' && locSel.value === oldValue;

            const ok = await this.write(async () => {
                // Add the new label, drop the old one, then relabel the data.
                // Two independent entry edits rather than a whole-list rewrite,
                // so a concurrent edit elsewhere isn't clobbered.
                await this.db.addListEntry(target, newValue);
                await this.db.removeListEntry(target, oldValue);
                await this.applyRename(target, oldValue, newValue);
            }, 'Renaming');
            if (!ok) return;

            await this.refreshModalList();
            await this.loadSessionDropdowns();
            if (reselectName) nameSel.value = newValue;
            if (reselectLoc) locSel.value = newValue;
            this.saveSession();
            if (this.mode === 'inventory') {
                await this.populateLocationFilter();
                this.refreshInventory();
            }
            feedbackSuccess();
            showToast(
                affected
                    ? `Renamed to "${newValue}" — ${affected} ${plural} updated.`
                    : `Renamed to "${newValue}".`,
                'success'
            );
        }

        // Rewrites the value everywhere it appears on inventory items, history
        // included, so a shelf or person has one label throughout. The audit
        // log is deliberately left alone — it records what happened at the time.
        async applyRename(target, oldValue, newValue) {
            const items = await this.db.getAllItems();
            for (const item of items) {
                let changed = false;
                if (target === 'locations') {
                    if (item.location === oldValue) { item.location = newValue; changed = true; }
                    (item.history || []).forEach(h => {
                        if (h.from === oldValue) { h.from = newValue; changed = true; }
                        if (h.to === oldValue) { h.to = newValue; changed = true; }
                    });
                } else if (target === 'labels') {
                    if (item.label === oldValue) { item.label = newValue; changed = true; }
                } else {
                    if (item.addedBy === oldValue) { item.addedBy = newValue; changed = true; }
                    if (item.removedBy === oldValue) { item.removedBy = newValue; changed = true; }
                    (item.history || []).forEach(h => {
                        if (h.by === oldValue) { h.by = newValue; changed = true; }
                    });
                }
                if (changed) await this.db.updateItem(item);
            }
        }

        async addListItem() {
            const input = document.getElementById('modal-new-item');
            const value = input.value.trim();
            if (!value) return;

            // Catch a case/spacing twin of anything already selectable — the
            // managed list AND values already on the inventory — so we don't end
            // up with "Bryan" and "bryan " as two different people.
            const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
            const stored = await this.db.getList(this.modalTarget);
            const used = (await this.collectUsedValues())[this.modalTarget] || [];
            const existing = [...new Set([...stored, ...used])];
            const clash = existing.find(e => norm(e) === norm(value));
            if (clash) {
                showToast(
                    clash === value
                        ? 'Already exists.'
                        : `Already exists as "${clash}". Pick that one, or use Rename to change its spelling.`,
                    'error'
                );
                return;
            }
            const ok = await this.write(() => this.db.addListEntry(this.modalTarget, value), 'Adding entry');
            if (!ok) return;
            input.value = '';
            await this.refreshModalList();
            await this.loadSessionDropdowns();
            showToast('Added: ' + value, 'success');
        }

        async removeListItem(value) {
            const noun = this.modalTarget === 'locations' ? 'location' : 'name';
            // A value that's still on inventory records can't be hidden: the
            // dropdowns are rebuilt from the data, so it would just reappear.
            // Say so and point at Rename, which relabels those entries too.
            const counts = await this.countListUsage(this.modalTarget);
            const inUse = counts.get(value) || 0;
            if (inUse > 0) {
                alert(
                    `"${value}" is still on ${inUse} inventory ${inUse === 1 ? 'entry' : 'entries'}, ` +
                    `so it can't be removed from the dropdown — it would just come back from the data.\n\n` +
                    `To retire this ${noun}, use Rename (✎) to relabel those ${inUse === 1 ? 'entry' : 'entries'}, ` +
                    `or move/relabel the bottles first.`
                );
                return;
            }

            const ok = await this.write(() => this.db.removeListEntry(this.modalTarget, value), 'Removing entry');
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
            document.body.classList.add('camera-open');
            document.getElementById('camera-shutter').disabled = false;
            document.getElementById('snap-status').textContent = '';
            this.renderThumbs();
            document.getElementById('camera-view').scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
        }

        // ---- Multi-photo capture ----
        // Small bottles can need several photos to catch every field. Each
        // "Add another" stashes the current frame; the shutter captures the
        // final frame and analyzes them all together as one label.
        renderThumbs() {
            const wrap = document.getElementById('camera-thumbs');
            const hint = document.querySelector('.camera-hint');
            const n = this.pendingShots.length;
            if (wrap) {
                wrap.style.display = n ? 'flex' : 'none';
                wrap.innerHTML = this.pendingShots.map((im, i) => `
                    <div class="thumb">
                        <img src="data:${im.mimeType};base64,${im.data}" alt="Photo ${i + 1}">
                        <button type="button" class="thumb-x" data-i="${i}" aria-label="Remove photo">&times;</button>
                    </div>`).join('');
                wrap.querySelectorAll('.thumb-x').forEach(b => b.addEventListener('click', () => {
                    this.pendingShots.splice(+b.dataset.i, 1);
                    this.renderThumbs();
                }));
            }
            if (hint) {
                hint.textContent = n
                    ? `${n} photo${n !== 1 ? 's' : ''} added — tap the circle to capture the last and read them together.`
                    : 'Fill the frame with the label, then tap the circle. Multi-part label? Tap “Add another photo”.';
            }
        }

        addShot() {
            const image = this.captureFrame();
            if (!image) {
                showToast('Camera not ready yet — try again.', 'error');
                return;
            }
            this.pendingShots.push(image);
            hapticFeedback('light');
            this.renderThumbs();
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
            document.body.classList.remove('camera-open');
            // Abandon any half-captured multi-photo set.
            this.pendingShots = [];
            this.renderThumbs();
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
            const frame = this.captureFrame();
            if (!frame) {
                showToast('Camera not ready yet — try again.', 'error');
                shutter.disabled = false;
                return;
            }
            // Everything stashed via "Add another", plus this final frame.
            const images = [...this.pendingShots, frame];
            this.pendingShots = [];
            hapticFeedback('light');
            this.closeCamera();
            await this.handleLabelImages(images, true);
        }

        async handleLabelCapture(files) {
            const list = Array.from(files || []).filter(Boolean);
            if (!list.length) return;
            const snapStatus = document.getElementById('snap-status');
            try {
                snapStatus.textContent = list.length > 1 ? `Processing ${list.length} photos…` : 'Processing photo…';
                snapStatus.className = 'lookup-status loading';
                const images = [];
                for (const f of list) images.push(await this.fileToBase64(f));
                await this.handleLabelImages(images);
            } catch (e) {
                console.error('Label analysis failed:', e);
                // Errors we've already phrased for a human are shown as-is;
                // anything unexpected keeps the generic prefix.
                snapStatus.textContent = e.friendly ? e.message : 'Analysis failed: ' + (e.message || 'Unknown error');
                snapStatus.className = 'lookup-status error';
            }
        }

        async handleLabelImages(images, fromCamera = false) {
            const snapStatus = document.getElementById('snap-status');
            snapStatus.textContent = images.length > 1
                ? `Reading ${images.length} photos…` : 'Analyzing label…';
            snapStatus.className = 'lookup-status loading';

            try {
                // Call Gemini Vision API. The callback lets a rate-limit retry
                // show its countdown in the same status line.
                const result = await this.analyzeWithGemini(images, (msg) => {
                    snapStatus.textContent = msg;
                    snapStatus.className = 'lookup-status loading';
                });

                if (result) {
                    snapStatus.textContent = 'Label read successfully!';
                    snapStatus.className = 'lookup-status success';

                    // Keep the first photo to save as this bottle's thumbnail on submit.
                    this.pendingPhoto = images[0] || null;

                    // Show and fill the form
                    const form = document.getElementById('chemical-form');
                    document.getElementById('chem-form').reset();
                    document.getElementById('f-label').value = this.getSessionLabel();
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
                // Errors we've already phrased for a human are shown as-is;
                // anything unexpected keeps the generic prefix.
                snapStatus.textContent = e.friendly ? e.message : 'Analysis failed: ' + (e.message || 'Unknown error');
                snapStatus.className = 'lookup-status error';
            }
        }

        // ---- Batch upload: one photo = one bottle, added straight in ----
        async handleBatchUpload(files) {
            const list = Array.from(files || []).filter(Boolean);
            if (!list.length) return;
            if (!this.getSessionName() || !this.getSessionLocation()) {
                showToast('Select your Name and Location first.', 'error');
                return;
            }
            if (!this.getGeminiKey()) {
                showToast('Set up your API key first (gear icon).', 'error');
                this.openSettings();
                return;
            }
            const snapStatus = document.getElementById('snap-status');
            const total = list.length;
            let done = 0, added = 0, failed = 0;
            const update = () => {
                snapStatus.textContent = `Batch: ${done}/${total} analysed · ${added} added` + (failed ? ` · ${failed} skipped` : '');
                snapStatus.className = 'lookup-status loading';
            };
            update();

            // A few at a time: parallel enough to be fast, gentle enough on the
            // Gemini free-tier per-minute limit (the analyzer still retries 429s).
            let idx = 0;
            const worker = async () => {
                while (idx < list.length) {
                    const file = list[idx++];
                    try {
                        const image = await this.fileToBase64(file);
                        const result = await this.analyzeWithGemini([image]);
                        const res = result ? await this.addItemFromResult(result, image) : { ok: false };
                        res.ok ? added++ : failed++;
                    } catch (e) {
                        console.error('Batch item failed:', e);
                        failed++;
                    }
                    done++;
                    update();
                }
            };
            await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));

            feedbackSuccess();
            snapStatus.textContent = `Batch done: ${added} added` + (failed ? `, ${failed} skipped (couldn't read).` : '.');
            snapStatus.className = 'lookup-status ' + (added ? 'success' : 'error');
            this.refreshInventory();
        }

        // Builds and stores one bottle from an analysis result, using the current
        // session Name/Location/Label. Returns {ok} so the batch can tally.
        async addItemFromResult(result, sourceImage) {
            const productName = (result.productName || '').trim();
            const productNumber = (result.productNumber || '').trim();
            if (!productName && !productNumber) return { ok: false };

            const unitMap = { 'g': 'g', 'kg': 'kg', 'mg': 'mg', 'ml': 'mL', 'l': 'L', 'ul': 'uL', 'oz': 'oz', 'lb': 'lb' };
            const rawUnit = (result.unit || '').toString().trim();
            const unit = unitMap[rawUnit.toLowerCase()] || rawUnit || 'each';
            const amount = (result.amount || '').toString().trim() || '1';
            const vendor = (result.vendor || '').trim();
            const casNumber = (result.casNumber || '').trim();
            const addedBy = this.getSessionName();
            const location = this.getSessionLocation();
            const label = await this.canonicalLabel(this.getSessionLabel());
            const barcode = productNumber
                ? (productNumber + (amount && unit ? '-' + amount + unit.toUpperCase() : ''))
                : 'LABEL-' + generateId();

            const item = {
                id: generateId(), barcode, vendor, productNumber, productName, casNumber,
                amount, unit, location, label, expiration: '',
                notes: result.lotNumber ? 'Lot: ' + result.lotNumber : '',
                addedBy, removedBy: null, status: 'active',
                dateIn: new Date().toISOString(), dateOut: null, history: [],
            };

            let thumb = null;
            if (sourceImage) {
                try { thumb = await this.makeThumbnail(sourceImage); item.hasPhoto = true; }
                catch (e) { /* photo is a nice-to-have */ }
            }
            try {
                await this.db.addItem(item);
            } catch (e) {
                console.error('Batch add failed:', e);
                return { ok: false };
            }
            if (thumb) this.db.savePhoto(item.id, thumb).catch(() => { /* best-effort */ });
            this.db.saveChemical({ barcode, vendor, productNumber, productName, casNumber, amount, unit })
                .catch(() => { /* template cache is best-effort */ });
            return { ok: true };
        }

        // ---- View a stored item photo ----
        async viewPhoto(id) {
            const modal = document.getElementById('photo-modal');
            const img = document.getElementById('photo-modal-img');
            img.src = '';
            modal.style.display = '';
            try {
                const photo = await this.db.getPhoto(id);
                if (photo && photo.data) {
                    img.src = `data:${photo.mimeType || 'image/jpeg'};base64,${photo.data}`;
                } else {
                    this.closePhoto();
                    showToast('No photo stored for this item.', 'error');
                }
            } catch (e) {
                this.closePhoto();
                showToast('Could not load the photo.', 'error');
            }
        }

        closePhoto() {
            document.getElementById('photo-modal').style.display = 'none';
            document.getElementById('photo-modal-img').src = '';
        }

        // Phone cameras produce 3-5 MB JPEGs; base64 inflates that by a third
        // again. Downscaling first cuts the upload roughly tenfold with no
        // measurable loss in label legibility.
        // Shrinks a captured image to a small thumbnail for storage: big enough
        // to recognise a label, small enough (~30-60 KB) that syncing it is cheap.
        async makeThumbnail(image, maxDim = 600, quality = 0.6) {
            const dataUrl = `data:${image.mimeType || 'image/jpeg'};base64,${image.data}`;
            const img = await new Promise((resolve, reject) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.onerror = reject;
                i.src = dataUrl;
            });
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            return { data: canvas.toDataURL('image/jpeg', quality).split(',')[1], mimeType: 'image/jpeg' };
        }

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
        geminiRequest(body, model) {
            const apiKey = this.getGeminiKey();
            if (!apiKey) throw new Error('No API key configured');
            const useModel = model || this.getPreferredModels()[0];
            return fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent`,
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

        // Candidate models to try, with the last one that worked on this device
        // pulled to the front so we don't re-probe dead models every scan.
        getPreferredModels() {
            let saved = null;
            try { saved = localStorage.getItem(GEMINI_MODEL_STORE); } catch (e) { /* private mode */ }
            const list = GEMINI_MODELS.slice();
            if (saved && list.includes(saved)) {
                return [saved, ...list.filter(m => m !== saved)];
            }
            return list;
        }

        rememberModel(model) {
            try { localStorage.setItem(GEMINI_MODEL_STORE, model); } catch (e) { /* private mode */ }
        }

        async analyzeWithGemini(images, onProgress) {
            // Accept a single image or several photos of the same label.
            const list = Array.isArray(images) ? images : [images];

            // A response schema makes the model return parseable JSON by
            // construction, instead of asking for JSON in the prompt and
            // regexing it back out of prose.
            const fields = ['vendor', 'productNumber', 'productName', 'casNumber',
                'amount', 'unit', 'lotNumber', 'expiration'];

            const intro = list.length > 1
                ? `These ${list.length} images are different photos of the SAME chemical product label (e.g. a small bottle photographed from several angles). Combine information across all of them into one result; if a field is legible in any photo, use it.`
                : 'Read this chemical product label image and extract:';

            const body = {
                contents: [{
                    parts: [
                        {
                            text: `${intro}
- vendor: manufacturer or vendor name (e.g. Sigma-Aldrich, Fisher Scientific, Alfa Aesar)
- productNumber: catalog or product number
- productName: chemical or product name
- casNumber: CAS registry number, exactly in the format XXXXX-XX-X
- amount: quantity number only (e.g. 500, 1, 2.5)
- unit: unit of measurement (g, kg, mg, mL, L, etc.)
- lotNumber: lot or batch number if visible
- expiration: expiration date as YYYY-MM-DD if visible

Use an empty string for any field that is not visible in any photo or cannot be determined. Do not guess.`
                        },
                        ...list.map(im => ({ inlineData: { mimeType: im.mimeType, data: im.data } }))
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
            };

            return this.runGemini(body, onProgress);
        }

        // Tries each candidate model until one the account can use responds,
        // then remembers it. Only an "unavailable to this account" error moves
        // on to the next model — quota, parse and network errors aren't fixed by
        // switching models, so they surface straight away.
        async runGemini(body, onProgress) {
            const models = this.getPreferredModels();
            let lastErr = null;
            for (let i = 0; i < models.length; i++) {
                try {
                    const result = await this.callGeminiModel(body, models[i], onProgress);
                    this.rememberModel(models[i]);
                    return result;
                } catch (e) {
                    lastErr = e;
                    if (e.modelUnavailable && i < models.length - 1) continue;
                    throw e;
                }
            }
            throw lastErr || new Error('AI request failed');
        }

        // One model attempt, with a single automatic retry when the free tier is
        // briefly rate-limited (HTTP 429). Google reports how long until the
        // quota window resets; if that's soon we wait it out — showing a live
        // countdown — rather than making the user re-shoot the label.
        async callGeminiModel(body, model, onProgress) {
            for (let attempt = 0; ; attempt++) {
                const response = await this.geminiRequest(body, model);
                if (response.ok) {
                    const data = await response.json();
                    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!text) throw new Error('No response from AI');
                    return this.parseGeminiJson(text);
                }
                const errJson = await response.json().catch(() => ({}));
                const wait = this.parseRetryDelay(errJson);
                if (response.status === 429 && attempt === 0 && wait !== null && wait <= 60) {
                    for (let s = Math.ceil(wait); s > 0; s--) {
                        if (onProgress) onProgress(`Gemini free-tier limit reached — retrying in ${s}s…`);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    continue;
                }
                throw this.geminiError(response.status, errJson);
            }
        }

        parseGeminiJson(text) {
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

        // Pulls Google's RetryInfo.retryDelay ("49s") out of a 429 error body.
        parseRetryDelay(errJson) {
            const details = (errJson && errJson.error && errJson.error.details) || [];
            for (const d of details) {
                if (d && typeof d.retryDelay === 'string') {
                    const m = /([\d.]+)s/.exec(d.retryDelay);
                    if (m) return parseFloat(m[1]);
                }
            }
            return null;
        }

        // Turns a raw Gemini API error into one short, human sentence. Marked
        // .friendly so callers show it as-is instead of prefixing "Analysis
        // failed:" onto an already-explained problem.
        geminiError(status, errJson) {
            const raw = (errJson && errJson.error && errJson.error.message) || '';
            // A model the account can't use — 404, or a 400 whose text says the
            // model is gone/unknown. This flag tells runGemini to try the next
            // candidate rather than give up.
            const unavailable = status === 404
                || /no longer available|not available|is not found|not found for api version|does not exist|unsupported|cannot be used/i.test(raw);
            let msg;
            if (unavailable) {
                msg = 'This AI model isn\'t available on your Google account. The app is trying another — if this keeps up, enter the chemical manually below.';
            } else if (status === 429) {
                const wait = this.parseRetryDelay(errJson);
                if (wait !== null && wait > 120) {
                    // A multi-minute reset means the daily free-tier allowance is
                    // spent, not a brief burst limit — retrying won't help.
                    const mins = Math.round(wait / 60);
                    const when = mins >= 90 ? `about ${Math.round(mins / 60)} hour(s)` : `about ${mins} min`;
                    msg = `Gemini's daily free-AI limit for this API key is used up (resets in ${when}). Enter the chemical manually below, or enable billing on the key for higher limits.`;
                } else {
                    const when = wait ? ` Try again in about ${Math.ceil(wait)}s` : ' Try again in a minute';
                    msg = `Gemini's free AI tier is rate-limited right now.${when}, or just enter the chemical manually below.`;
                }
            } else if (status === 400 && /api[_ ]?key/i.test(raw)) {
                msg = 'Gemini rejected the API key — re-check it in Settings (the gear icon).';
            } else {
                msg = raw || ('AI request failed (' + status + ')');
            }
            const err = new Error(msg);
            err.friendly = true;
            err.modelUnavailable = unavailable;
            return err;
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
            // Label is a free-text box, so persist as it's typed.
            document.getElementById('session-label').addEventListener('input', () => this.saveSession());

            // Edit buttons for name/location/label lists
            document.getElementById('edit-names').addEventListener('click', () => this.openModal('names'));
            document.getElementById('edit-locations').addEventListener('click', () => this.openModal('locations'));
            document.getElementById('edit-labels').addEventListener('click', () => this.openModal('labels'));

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
                if (e.target.files.length) this.handleLabelCapture(e.target.files);
                e.target.value = ''; // Reset so the same file can be re-selected
            });

            // Batch upload: many photos, one bottle each, auto-added.
            document.getElementById('batch-upload').addEventListener('click', () => {
                document.getElementById('batch-capture').click();
            });
            document.getElementById('batch-capture').addEventListener('change', (e) => {
                if (e.target.files.length) this.handleBatchUpload(e.target.files);
                e.target.value = '';
            });

            // Photo viewer
            document.getElementById('photo-close').addEventListener('click', () => this.closePhoto());
            document.getElementById('photo-modal').addEventListener('click', (e) => {
                if (e.target === document.getElementById('photo-modal')) this.closePhoto();
            });

            // In-app camera
            document.getElementById('camera-shutter').addEventListener('click', () => this.shootLabel());
            document.getElementById('camera-add').addEventListener('click', () => this.addShot());
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

            // Move modal (per-item, launched from an inventory card)
            document.getElementById('move-confirm').addEventListener('click', () => this.confirmMove());
            document.getElementById('move-cancel').addEventListener('click', () => this.closeMoveModal());
            document.getElementById('move-close').addEventListener('click', () => this.closeMoveModal());
            document.getElementById('move-modal').addEventListener('click', (e) => {
                if (e.target === document.getElementById('move-modal')) this.closeMoveModal();
            });

            // Inventory search & filter
            document.getElementById('search-inventory').addEventListener('input', () => this.refreshInventory());
            document.getElementById('filter-status').addEventListener('change', () => this.refreshInventory());
            document.getElementById('filter-location').addEventListener('change', () => this.refreshInventory());
            document.getElementById('filter-label').addEventListener('change', () => this.refreshInventory());
            const groupToggle = document.getElementById('group-items');
            groupToggle.checked = localStorage.getItem('chem_group_items') !== 'off';
            groupToggle.addEventListener('change', () => {
                localStorage.setItem('chem_group_items', groupToggle.checked ? 'on' : 'off');
                this.refreshInventory();
            });

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
            document.getElementById('mode-inventory').classList.toggle('active', mode === 'inventory');

            // Show/hide sections based on mode
            document.getElementById('scanner-section').style.display = mode === 'input' ? '' : 'none';
            // Name is needed in both modes: to credit additions, and to record
            // who disposed, moved, edited or deleted an entry.
            document.getElementById('session-name').closest('.session-field').style.display = '';
            // Location is the destination for new bottles, so Add mode only.
            document.getElementById('session-location').closest('.session-field').style.display = mode === 'input' ? '' : 'none';
            this.hideForm();

            // Inventory & export only visible in inventory mode
            document.getElementById('inventory-section').style.display = mode === 'inventory' ? '' : 'none';
            document.getElementById('export-section').style.display = mode === 'inventory' ? '' : 'none';

            if (mode === 'inventory') {
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
            this.pendingPhoto = null; // typed/looked-up entry, no photo to attach
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
            document.getElementById('f-label').value = this.getSessionLabel();

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
            this.pendingPhoto = null; // typed entry, no photo to attach
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
            // Carry the current bin/label into the new entry; still editable.
            document.getElementById('f-label').value = this.getSessionLabel();

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
            // Per-item label, falling back to the session label (the current bin).
            const labelRaw = document.getElementById('f-label').value.trim() || this.getSessionLabel();
            // Status can be set at entry (e.g. logging an already-disposed bottle),
            // plus a quick "running low" flag. Only used when adding, not editing.
            const status = document.getElementById('f-status').value;
            const lowStock = document.getElementById('f-low').checked;

            if (!vendor || !productNumber || !productName || !amount) {
                showToast('Fill in all required fields.', 'error');
                feedbackError();
                return false;
            }

            const label = await this.canonicalLabel(labelRaw);

            if (this.editingId) {
                await this.saveEdit({ barcode, vendor, productNumber, productName, casNumber, amount, unit, expiration, notes, label });
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
                label,
                expiration,
                notes,
                addedBy,
                removedBy: null,
                status: 'active',
                dateIn: new Date().toISOString(),
                dateOut: null,
                history: [],
            };

            const now = item.dateIn;
            if (status === 'disposed') {
                item.status = 'disposed';
                item.dateOut = now;
                item.removedBy = addedBy;
                this.addHistory(item, 'disposed', { by: addedBy, at: now });
            }
            if (lowStock) {
                item.lowStock = true;
                item.lowStockBy = addedBy;
                item.lowStockAt = now;
            }

            // Attach the scanned label as this bottle's thumbnail, if there is one.
            let thumb = null;
            if (this.pendingPhoto) {
                try { thumb = await this.makeThumbnail(this.pendingPhoto); item.hasPhoto = true; }
                catch (e) { console.warn('Thumbnail failed:', e); }
            }

            const ok = await this.write(() => this.db.addItem(item), 'Adding to inventory');
            if (!ok) return false;
            if (thumb) this.db.savePhoto(item.id, thumb).catch(e => console.warn('Photo save failed:', e));
            this.pendingPhoto = null;
            feedbackSuccess();
            showToast(`Added: ${productName} (${amount} ${unit})`, 'success');
            this.hideForm();
            this.refreshInventory();
            return true;
        }

        // ---- Editing an existing entry ----
        async startEdit(id) {
            if (!this.requireIdentity('edit an entry')) return;
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
            document.getElementById('f-label').value = item.label || '';

            const locations = await this.db.getList('locations');
            this.populateSelect('f-location', locations.slice());
            document.getElementById('f-location').value = item.location || '';

            document.getElementById('form-title').textContent = 'Edit Entry';
            document.getElementById('form-submit').textContent = 'Save Changes';
            document.getElementById('f-location').closest('.form-group').style.display = '';
            // Status is set-at-entry only; editing an existing bottle keeps using
            // the Dispose/Reactivate/Running-low actions in the inventory list.
            document.getElementById('f-status-group').style.display = 'none';
            document.getElementById('autofill-notice').style.display = 'none';
            this.setLookupStatus('');

            const form = document.getElementById('chemical-form');
            form.style.display = '';
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        async saveEdit(fields) {
            // Re-check: the Name could have been cleared after the form opened.
            const by = this.requireIdentity('save changes');
            if (!by) return;
            const item = await this.db.getItem(this.editingId);
            if (!item) {
                showToast('Entry no longer exists.', 'error');
                this.hideForm();
                return;
            }

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
            this.pendingPhoto = null;
            document.getElementById('form-title').textContent = 'Add Chemical to Inventory';
            document.getElementById('form-submit').textContent = 'Add to Inventory';
            document.getElementById('f-location').closest('.form-group').style.display = 'none';
            document.getElementById('f-status-group').style.display = '';
        }

        // ---- Inventory Display ----
        async populateLocationFilter() {
            // Include locations that actually appear on items, not just the
            // managed list. Renaming or removing a location from the list would
            // otherwise strand every bottle still filed under the old name —
            // they'd count towards the badge but be impossible to browse to.
            const [managedLoc, managedLabels, items] = await Promise.all([
                this.db.getList('locations'),
                this.db.getList('labels'),
                this.db.getAllItems(),
            ]);
            const usedLoc = items.map(i => i.location).filter(Boolean);
            const usedLabels = items.map(i => i.label).filter(Boolean);
            this.populateSelect('filter-location', [...new Set([...managedLoc, ...usedLoc])]);
            this.populateSelect('filter-label', [...new Set([...managedLabels, ...usedLabels])]);
        }

        async refreshInventory() {
            const allItems = await this.db.getAllItems();
            const search = document.getElementById('search-inventory').value.toLowerCase().trim();
            const filterStatus = document.getElementById('filter-status').value;
            const filterLocation = document.getElementById('filter-location').value;
            const filterLabel = document.getElementById('filter-label').value;

            // Update count badge
            const activeCount = allItems.filter(i => i.status === 'active').length;
            document.getElementById('inventory-count').textContent = activeCount;

            const listEl = document.getElementById('inventory-list');
            const emptyEl = document.getElementById('inventory-empty');

            this.renderExpiryBanner(allItems);

            // A search term is normally required so we don't render hundreds of
            // cards, but picking a location or the Expiring filter is itself a
            // narrowing choice — those browse without one.
            const browsing = !!filterLocation || !!filterLabel || filterStatus === 'expiring' || filterStatus === 'lowstock';
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
            } else if (filterStatus === 'lowstock') {
                items = items.filter(i => i.status === 'active' && i.lowStock);
            } else if (filterStatus !== 'all') {
                items = items.filter(i => i.status === filterStatus);
            }

            if (filterLocation) {
                items = items.filter(i => (i.location || '') === filterLocation);
            }

            if (filterLabel) {
                items = items.filter(i => (i.label || '') === filterLabel);
            }

            // Search
            if (search) {
                items = items.filter(i => this.matchesQuery(i, search,
                    ['productName', 'vendor', 'productNumber', 'casNumber', 'location', 'label', 'addedBy', 'notes']
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

            const grouping = document.getElementById('group-items');
            if (!grouping || !grouping.checked) {
                listEl.innerHTML = items.map(item => this.renderCard(item)).join('');
                return;
            }

            // Group bottles of the same product so a solvent with five bottles
            // is one row you expand, not five stacked cards.
            const groups = new Map();
            for (const item of items) {
                const key = this.groupKey(item);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(item);
            }
            const entries = [...groups.entries()];

            // Sort groups like the individual cards were: expiring filter →
            // soonest first; otherwise most recently active first.
            entries.sort(([, am], [, bm]) => {
                if (filterStatus === 'expiring') {
                    const ax = Math.min(...am.map(i => daysUntil(i.expiration) ?? Infinity));
                    const bx = Math.min(...bm.map(i => daysUntil(i.expiration) ?? Infinity));
                    if (ax !== bx) return ax - bx;
                }
                const at = Math.max(...am.map(i => new Date(i.dateIn).getTime()));
                const bt = Math.max(...bm.map(i => new Date(i.dateIn).getTime()));
                return bt - at;
            });

            // A search that narrows to a single product opens it automatically.
            if (entries.length === 1) this.expandedGroups.add(entries[0][0]);

            this._renderGroupKeys = entries.map(([key]) => key);
            listEl.innerHTML = entries.map(([key, members], idx) =>
                members.length === 1 ? this.renderCard(members[0]) : this.renderGroup(key, members, idx)
            ).join('');

            listEl.querySelectorAll('.inv-group-header').forEach(btn => {
                btn.addEventListener('click', () => this.toggleGroup(+btn.dataset.gi));
            });
        }

        // Identity of a product for grouping. CAS wins when present: the same
        // CAS is the same chemical, so different sizes or catalog numbers of one
        // reagent group together. Without a CAS, fall back to vendor + catalog
        // number, then name.
        groupKey(item) {
            const cas = (item.casNumber || '').replace(/\s+/g, '').trim();
            if (cas) return 'cas:' + cas;
            const vendor = (item.vendor || '').toLowerCase().trim();
            const pn = (item.productNumber || '').toLowerCase().trim();
            if (pn) return 'pn:' + vendor + '|' + pn;
            return 'name:' + (item.productName || '').toLowerCase().trim();
        }

        renderGroup(key, members, idx) {
            const open = this.expandedGroups.has(key);
            const sample = members[0];
            const activeN = members.filter(i => i.status === 'active').length;
            const disposedN = members.length - activeN;

            // Worst expiry across the bottles drives the collapsed badge.
            const states = members.map(expiryState).filter(Boolean);
            const worst = states.find(s => s.level === 'expired') || states.find(s => s.level === 'expiring');

            const lowN = members.filter(i => i.status === 'active' && i.lowStock).length;

            const locations = [...new Set(members.filter(i => i.status === 'active' && i.location).map(i => i.location))];
            const locLabel = locations.length
                ? locations.slice(0, 3).join(', ') + (locations.length > 3 ? ` +${locations.length - 3}` : '')
                : '';

            const countLabel = disposedN
                ? `${activeN} active · ${disposedN} disposed`
                : `${activeN} bottle${activeN !== 1 ? 's' : ''}`;

            // The group can span multiple vendors and catalog numbers (same CAS,
            // different packaging), so summarise rather than showing one sample.
            const vendors = [...new Set(members.map(i => i.vendor).filter(Boolean))];
            const pns = [...new Set(members.map(i => i.productNumber).filter(Boolean))];
            const subParts = [];
            if (vendors.length === 1) subParts.push(vendors[0]);
            else if (vendors.length > 1) subParts.push(vendors.length + ' vendors');
            if (pns.length === 1) subParts.push(pns[0]);
            else if (pns.length > 1) subParts.push(pns.length + ' product #s');
            if (sample.casNumber) subParts.push('CAS ' + sample.casNumber);
            const sub = subParts.map(s => this.esc(s)).join(' &bull; ');

            return `
                <div class="inv-group ${open ? 'open' : ''} ${worst ? worst.level : ''} ${lowN ? 'low-stock' : ''}">
                    <button type="button" class="inv-group-header" data-gi="${idx}">
                        <span class="inv-group-caret">${open ? '&#9662;' : '&#9656;'}</span>
                        <span class="inv-group-title">
                            <span class="inv-group-name">${this.esc(sample.productName)}</span>
                            <span class="inv-group-sub">${sub}</span>
                            ${locLabel ? `<span class="inv-group-sub">${this.esc(locLabel)}</span>` : ''}
                        </span>
                        <span class="inv-group-badges">
                            ${lowN ? `<span class="inv-status low">${lowN} low</span>` : ''}
                            ${worst ? `<span class="inv-status ${worst.level}">${worst.label}</span>` : ''}
                            <span class="badge">${countLabel}</span>
                        </span>
                    </button>
                    <div class="inv-group-body" ${open ? '' : 'style="display:none"'}>
                        ${members.map(m => this.renderCard(m)).join('')}
                    </div>
                </div>
            `;
        }

        toggleGroup(idx) {
            const key = (this._renderGroupKeys || [])[idx];
            if (!key) return;
            if (this.expandedGroups.has(key)) this.expandedGroups.delete(key);
            else this.expandedGroups.add(key);
            this.refreshInventory();
        }

        renderCard(item) {
            const expiry = expiryState(item);
            const low = item.lowStock && item.status === 'active';
            return `
                <div class="inv-card ${item.status === 'disposed' ? 'disposed' : ''} ${expiry ? expiry.level : ''} ${low ? 'low-stock' : ''}">
                    <div class="inv-header">
                        <div class="inv-name">${this.esc(item.productName)}</div>
                        ${low ? `<span class="inv-status low">Low</span>` : ''}
                        ${expiry ? `<span class="inv-status ${expiry.level}">${expiry.label}</span>` : ''}
                        <span class="inv-status ${item.status}">${item.status}</span>
                    </div>
                    <div class="inv-meta">
                        <div><strong>Vendor:</strong> ${this.esc(item.vendor)}</div>
                        <div><strong>Product #:</strong> ${this.esc(item.productNumber)}</div>
                        <div><strong>CAS:</strong> ${this.esc(item.casNumber || '—')}</div>
                        <div><strong>Amount:</strong> ${this.esc(item.amount)} ${this.esc(item.unit)}</div>
                        ${item.location ? `<div><strong>Location:</strong> ${this.esc(item.location)}</div>` : ''}
                        ${item.label ? `<div><strong>Label:</strong> ${this.esc(item.label)}</div>` : ''}
                        ${item.expiration ? `<div><strong>Expires:</strong> ${this.esc(item.expiration)}</div>` : ''}
                        ${item.addedBy ? `<div><strong>Added by:</strong> ${this.esc(item.addedBy)}</div>` : ''}
                        ${item.removedBy ? `<div><strong>Removed by:</strong> ${this.esc(item.removedBy)}</div>` : ''}
                        ${low && item.lowStockBy ? `<div><strong>Flagged low by:</strong> ${this.esc(item.lowStockBy)}</div>` : ''}
                        ${item.notes ? `<div><strong>Notes:</strong> ${this.esc(item.notes)}</div>` : ''}
                    </div>
                    <div class="inv-dates">
                        In: ${formatDate(item.dateIn)}
                        ${item.dateOut ? ' &bull; Out: ' + formatDate(item.dateOut) : ''}
                        ${this.formatMoveHistory(item)}
                    </div>
                    <div class="inv-actions">
                        ${item.hasPhoto ? `<button class="btn btn-secondary" onclick="app.viewPhoto('${item.id}')">&#128247; Photo</button>` : ''}
                        ${item.status === 'active'
                            ? `<button class="btn btn-danger" onclick="app.disposeSingle('${item.id}')">Dispose</button>`
                            : `<button class="btn btn-success" onclick="app.reactivate('${item.id}')">Reactivate</button>`
                        }
                        ${item.status === 'active'
                            ? `<button class="btn btn-primary" onclick="app.startMove('${item.id}')">Move</button>`
                            : ''
                        }
                        ${item.status === 'active'
                            ? `<button class="btn ${item.lowStock ? 'btn-secondary' : 'btn-warn'}" onclick="app.toggleLowStock('${item.id}')">${item.lowStock ? 'Restocked' : 'Running Low'}</button>`
                            : ''
                        }
                        <button class="btn btn-secondary" onclick="app.startEdit('${item.id}')">Edit</button>
                        <button class="btn btn-secondary" onclick="app.deleteItem('${item.id}')">Delete</button>
                    </div>
                </div>
            `;
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

        // Every change to an existing entry is attributed, so nothing in the
        // shared inventory can be altered anonymously.
        requireIdentity(action) {
            const who = this.getSessionName();
            if (!who) {
                showToast(`Select your Name at the top before you ${action}.`, 'error');
                feedbackError();
                const sel = document.getElementById('session-name');
                sel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                sel.focus();
                return null;
            }
            return who;
        }

        // ---- Move a single bottle ----
        async startMove(id) {
            if (!this.requireIdentity('move a bottle')) return;
            const item = await this.db.getItem(id);
            if (!item) {
                showToast('Entry not found.', 'error');
                return;
            }
            this.movingId = id;
            document.getElementById('move-item-name').textContent = item.productName || item.productNumber || 'Bottle';
            document.getElementById('move-current-location').textContent = item.location || 'no location';

            const locations = await this.db.getList('locations');
            this.populateSelect('move-to-location', locations.slice());
            // Don't preselect where it already is.
            document.getElementById('move-to-location').value = '';
            document.getElementById('move-modal').style.display = '';
        }

        closeMoveModal() {
            document.getElementById('move-modal').style.display = 'none';
            this.movingId = null;
        }

        async confirmMove() {
            const by = this.requireIdentity('move a bottle');
            if (!by) return;
            const newLocation = document.getElementById('move-to-location').value;
            if (!newLocation) {
                showToast('Select a destination location.', 'error');
                return;
            }
            const item = await this.db.getItem(this.movingId);
            if (!item) {
                showToast('Entry no longer exists.', 'error');
                this.closeMoveModal();
                return;
            }
            if (item.location === newLocation) {
                showToast('Already in that location.', 'error');
                return;
            }

            const from = item.location || '';
            this.addHistory(item, 'moved', { from, to: newLocation, by, at: new Date().toISOString() });
            item.location = newLocation;

            const ok = await this.write(() => this.db.updateItem(item), 'Moving bottle');
            if (!ok) return;
            feedbackSuccess();
            showToast(`Moved to ${newLocation}.`, 'success');
            this.closeMoveModal();
            this.refreshInventory();
        }

        async disposeSingle(id) {
            const by = this.requireIdentity('dispose of a bottle');
            if (!by) return;
            const item = await this.db.getItem(id);
            if (!item) return;
            const now = new Date().toISOString();
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

        // ---- Flag / clear "running low" ----
        // A shared flag so anyone browsing sees what's in short supply. Like
        // every other mutation here it's attributed, and toggling clears it
        // once the chemical has been restocked.
        async toggleLowStock(id) {
            const by = this.requireIdentity('flag stock levels');
            if (!by) return;
            const item = await this.db.getItem(id);
            if (!item) return;
            const now = new Date().toISOString();
            const nowLow = !item.lowStock;
            const ok = await this.write(async () => {
                item.lowStock = nowLow;
                item.lowStockBy = nowLow ? by : null;
                item.lowStockAt = nowLow ? now : null;
                this.addHistory(item, nowLow ? 'flagged-low' : 'restocked', { by, at: now });
                await this.db.updateItem(item);
            }, nowLow ? 'Flagging low stock' : 'Clearing low-stock flag');
            if (!ok) return;
            feedbackSuccess();
            showToast(nowLow ? 'Flagged as running low.' : 'Low-stock flag cleared.', 'success');
            this.refreshInventory();
        }

        async reactivate(id) {
            const by = this.requireIdentity('reactivate a bottle');
            if (!by) return;
            const item = await this.db.getItem(id);
            if (!item) return;
            const ok = await this.write(async () => {
                item.status = 'active';
                item.dateOut = null;
                this.addHistory(item, 'reactivated', { by, at: new Date().toISOString() });
                await this.db.updateItem(item);
            }, 'Reactivating bottle');
            if (!ok) return;
            showToast('Reactivated.', 'success');
            this.refreshInventory();
        }

        async deleteItem(id) {
            const by = this.requireIdentity('delete an entry');
            if (!by) return;
            const item = await this.db.getItem(id);
            if (!item) return;
            if (!confirm(`Permanently delete "${item.productName || item.productNumber}"?\n\nThis cannot be undone. The deletion will be recorded against your name.`)) return;

            const ok = await this.write(async () => {
                // Deleting destroys the record and its history, so the audit
                // entry is written first — otherwise there'd be no trace of who
                // removed what.
                await this.db.addAudit({
                    id: generateId(),
                    at: new Date().toISOString(),
                    by,
                    action: 'deleted',
                    itemId: item.id,
                    productName: item.productName || '',
                    productNumber: item.productNumber || '',
                    vendor: item.vendor || '',
                    amount: (item.amount || '') + ' ' + (item.unit || ''),
                    location: item.location || '',
                    label: item.label || '',
                    notes: item.notes || '',
                });
                await this.db.deleteItem(id);
            }, 'Deleting entry');
            if (!ok) return;
            if (item.hasPhoto) this.db.deletePhoto(id).catch(() => { /* orphan photo is harmless */ });
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
                        labels: new Set(),
                        addedBy: new Set(),
                        expirations: new Set(),
                        notes: [],
                        activeBottles: 0,
                        disposedBottles: 0,
                        lowBottles: 0,
                    };
                }
                if (item.location) grouped[key].locations.add(item.location);
                if (item.label) grouped[key].labels.add(item.label);
                if (item.addedBy) grouped[key].addedBy.add(item.addedBy);
                if (item.expiration) grouped[key].expirations.add(item.expiration);
                if (item.notes) grouped[key].notes.push(item.notes);
                if (item.status === 'active') grouped[key].activeBottles++;
                else grouped[key].disposedBottles++;
                if (item.status === 'active' && item.lowStock) grouped[key].lowBottles++;
            });

            const summaryData = Object.values(grouped).map(g => ({
                'Vendor': g.vendor,
                'Product Number': g.productNumber,
                'Product Name': g.productName,
                'CAS Number': g.casNumber,
                'Amount Per Bottle': g.amount,
                'Location': [...g.locations].join(', '),
                'Label': [...g.labels].join(', '),
                'Active Bottles': g.activeBottles,
                'Running Low': g.lowBottles,
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
                'Label': item.label || '',
                'Status': item.status,
                'Running Low': item.status === 'active' && item.lowStock ? 'YES' : '',
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

            // Deleted entries no longer exist in the inventory, so their record
            // comes from the audit trail instead.
            const audit = await this.db.getAllAudit().catch(() => []);
            audit.forEach(a => logEntries.push({
                _ts: a.at || '',
                'Date': formatDate(a.at),
                'Action': (a.action || 'audit').toUpperCase(),
                'Person': a.by || '',
                'Product Name': a.productName || '',
                'Vendor': a.vendor || '',
                'Product Number': a.productNumber || '',
                'CAS Number': '',
                'Amount': a.amount || '',
                'Location': a.location || '',
                'Notes': a.notes || '',
            }));

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
