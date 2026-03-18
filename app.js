// ============================================================
// Chemical Inventory Scanner - Application Logic
// ============================================================
// Uses IndexedDB for persistent local storage, html5-qrcode
// for camera barcode scanning, and SheetJS for XLSX export.
// ============================================================

(function () {
    'use strict';

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

    // ==================== Main App ====================
    class App {
        constructor() {
            this.db = new ChemDB();
            this.scanner = null;
            this.scanning = false;
            this.mode = 'input'; // 'input' or 'output'
            this.selectedBottles = new Set();
            this.modalTarget = null; // 'names' or 'locations'
        }

        async init() {
            await this.db.init();
            this.bindEvents();
            await this.loadSessionDropdowns();
            this.restoreSession();
            this.refreshInventory();
        }

        // ---- Session (Name + Location) ----
        async loadSessionDropdowns() {
            await this.populateSelect('session-name', await this.db.getList('names'));
            await this.populateSelect('session-location', await this.db.getList('locations'));
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
            await this.db.saveList(this.modalTarget, items);
            input.value = '';
            await this.refreshModalList();
            await this.loadSessionDropdowns();
            showToast('Added: ' + value, 'success');
        }

        async removeListItem(value) {
            let items = await this.db.getList(this.modalTarget);
            items = items.filter(i => i !== value);
            await this.db.saveList(this.modalTarget, items);
            await this.refreshModalList();
            await this.loadSessionDropdowns();
            showToast('Removed: ' + value, 'success');
        }

        // ---- QR Code / Barcode Content Parsing ----
        parseScannedContent(content) {
            content = content.trim();
            try {
                const url = new URL(content);
                const host = url.hostname.toLowerCase();
                const parts = url.pathname.split('/').filter(Boolean);
                const lastPart = parts[parts.length - 1] || '';

                if (host.includes('sigmaaldrich') || host.includes('milliporesigma') || host.includes('emdmillipore')) {
                    return { barcode: content, vendor: 'Sigma-Aldrich', productNumber: lastPart.toUpperCase(), isUrl: true };
                }
                if (host.includes('fishersci') || host.includes('thermofisher')) {
                    return { barcode: content, vendor: 'Fisher Scientific', productNumber: lastPart.toUpperCase(), isUrl: true };
                }
                if (host.includes('vwr.com') || host.includes('avantorsciences')) {
                    return { barcode: content, vendor: 'VWR', productNumber: lastPart.toUpperCase(), isUrl: true };
                }
                if (host.includes('alfa.com')) {
                    return { barcode: content, vendor: 'Alfa Aesar', productNumber: lastPart.toUpperCase(), isUrl: true };
                }
                if (host.includes('tcichemicals')) {
                    return { barcode: content, vendor: 'TCI', productNumber: lastPart.toUpperCase(), isUrl: true };
                }
                if (host.includes('acros') || host.includes('acrosorganics')) {
                    return { barcode: content, vendor: 'Acros Organics', productNumber: lastPart.toUpperCase(), isUrl: true };
                }
                return { barcode: content, isUrl: true };
            } catch (e) {
                // Not a URL — plain barcode
            }
            return { barcode: content };
        }

        // ---- PubChem Lookup ----
        async doLookup() {
            const vendor = document.getElementById('f-vendor').value.trim();
            const productNumber = document.getElementById('f-product-number').value.trim();
            if (!vendor && !productNumber) {
                showToast('Enter vendor and/or product number first.', 'error');
                return;
            }

            const btn = document.getElementById('lookup-btn');
            const vendorLink = document.getElementById('vendor-link');
            btn.disabled = true;
            btn.textContent = 'Searching...';
            this.setLookupStatus('Searching PubChem...', 'loading');
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
            const cleanNum = productNumber.replace(/[-_]?\d+\s*(?:g|kg|mg|ml|l|oz|lb)$/i, '').trim();
            const sourceNames = this.getPubchemSources(vendor);

            // Strategy 1: PubChem substance source ID lookup
            for (const source of sourceNames) {
                for (const num of [cleanNum, productNumber]) {
                    const cid = await this.pubchemSubstanceLookup(source, num);
                    if (cid) return await this.getCompoundInfo(cid);
                }
            }

            // Strategy 2: Compound name search (works for CAS numbers and common names)
            const cid = await this.pubchemCompoundSearch(cleanNum);
            if (cid) return await this.getCompoundInfo(cid);

            return null;
        }

        getPubchemSources(vendor) {
            const v = vendor.toLowerCase();
            const names = [];
            if (v.includes('sigma') || v.includes('aldrich')) names.push('Sigma-Aldrich', 'MilliporeSigma');
            if (v.includes('millipore')) names.push('MilliporeSigma', 'Sigma-Aldrich');
            if (v.includes('fisher') || v.includes('thermo')) names.push('Fisher Scientific');
            if (v.includes('acros')) names.push('Acros Organics');
            if (v.includes('alfa')) names.push('Alfa Aesar');
            if (v.includes('tci')) names.push('TCI');
            if (v.includes('vwr') || v.includes('avantor')) names.push('VWR');
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

        bindEvents() {
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

            // Mode toggle
            document.getElementById('mode-input').addEventListener('click', () => this.setMode('input'));
            document.getElementById('mode-output').addEventListener('click', () => this.setMode('output'));

            // Scanner
            document.getElementById('start-scan').addEventListener('click', () => this.startScanner());
            document.getElementById('stop-scan').addEventListener('click', () => this.stopScanner());

            // Manual barcode entry
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
            document.getElementById('cancel-output').addEventListener('click', () => this.hideOutputSelect());

            // Inventory search & filter
            document.getElementById('search-inventory').addEventListener('input', () => this.refreshInventory());
            document.getElementById('filter-status').addEventListener('change', () => this.refreshInventory());

            // Export
            document.getElementById('export-active').addEventListener('click', () => this.exportXLSX('active'));
            document.getElementById('export-all').addEventListener('click', () => this.exportXLSX('all'));
            document.getElementById('export-log').addEventListener('click', () => this.exportActivityLog());
        }

        // ---- Mode Management ----
        setMode(mode) {
            this.mode = mode;
            document.body.className = 'mode-' + mode;

            document.getElementById('mode-input').classList.toggle('active', mode === 'input');
            document.getElementById('mode-output').classList.toggle('active', mode === 'output');

            document.getElementById('scanner-title').textContent =
                mode === 'input' ? 'Scan Chemical In' : 'Scan Chemical Out';

            // Hide forms when switching modes
            this.hideForm();
            this.hideOutputSelect();
        }

        // ---- Scanner ----
        async startScanner() {
            const readerContainer = document.getElementById('reader-container');
            readerContainer.classList.add('active');
            document.getElementById('start-scan').style.display = 'none';
            document.getElementById('stop-scan').style.display = '';

            try {
                this.scanner = new Html5Qrcode('reader');
                await this.scanner.start(
                    { facingMode: 'environment' },
                    {
                        fps: 10,
                        qrbox: { width: 250, height: 150 },
                        aspectRatio: 1.5,
                        formatsToSupport: [
                            Html5QrcodeSupportedFormats.CODE_128,
                            Html5QrcodeSupportedFormats.CODE_39,
                            Html5QrcodeSupportedFormats.EAN_13,
                            Html5QrcodeSupportedFormats.EAN_8,
                            Html5QrcodeSupportedFormats.UPC_A,
                            Html5QrcodeSupportedFormats.UPC_E,
                            Html5QrcodeSupportedFormats.DATA_MATRIX,
                            Html5QrcodeSupportedFormats.QR_CODE,
                            Html5QrcodeSupportedFormats.CODE_93,
                            Html5QrcodeSupportedFormats.ITF,
                        ],
                    },
                    (decodedText) => this.onScanSuccess(decodedText),
                    () => {} // ignore scan failures (no barcode in frame)
                );
                this.scanning = true;
            } catch (err) {
                console.error('Scanner error:', err);
                showToast('Camera access failed. Use manual entry.', 'error');
                this.resetScannerUI();
            }
        }

        async stopScanner() {
            if (this.scanner && this.scanning) {
                try {
                    await this.scanner.stop();
                } catch (e) {
                    // ignore
                }
                this.scanning = false;
            }
            this.resetScannerUI();
        }

        resetScannerUI() {
            document.getElementById('reader-container').classList.remove('active');
            document.getElementById('start-scan').style.display = '';
            document.getElementById('stop-scan').style.display = 'none';
        }

        async onScanSuccess(content) {
            await this.stopScanner();
            const parsed = this.parseScannedContent(content);
            showToast('Scanned: ' + (parsed.productNumber || parsed.barcode), 'success');
            this.handleBarcode(parsed.barcode, parsed);
        }

        handleManualBarcode() {
            const input = document.getElementById('manual-barcode');
            const raw = input.value.trim();
            if (!raw) {
                showToast('Enter a barcode or product number.', 'error');
                return;
            }
            input.value = '';
            const parsed = this.parseScannedContent(raw);
            this.handleBarcode(parsed.barcode, parsed);
        }

        async handleBarcode(barcode, parsed = {}) {
            if (!this.getSessionName() || !this.getSessionLocation()) {
                showToast('Select your Name and Location first.', 'error');
                return;
            }
            if (this.mode === 'input') {
                await this.showInputForm(barcode, parsed);
            } else {
                await this.showOutputSelect(barcode);
            }
        }

        // ---- Input Mode: Chemical Form ----
        async showInputForm(barcode, parsed = {}) {
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

                // Pre-fill from QR code URL parsing
                if (parsed.vendor) document.getElementById('f-vendor').value = parsed.vendor;
                if (parsed.productNumber) document.getElementById('f-product-number').value = parsed.productNumber;

                // Auto-lookup if we got vendor + product number from QR
                if (parsed.vendor && parsed.productNumber) {
                    form.style.display = '';
                    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    this.doLookup();
                    return;
                }
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
            const notes = document.getElementById('f-notes').value.trim();
            const location = this.getSessionLocation();
            const addedBy = this.getSessionName();

            if (!vendor || !productNumber || !productName || !amount) {
                showToast('Fill in all required fields.', 'error');
                return;
            }

            // Save chemical template for future auto-fill
            await this.db.saveChemical({
                barcode,
                vendor,
                productNumber,
                productName,
                casNumber,
                amount,
                unit,
            });

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
                notes,
                addedBy,
                removedBy: null,
                status: 'active',
                dateIn: new Date().toISOString(),
                dateOut: null,
            };

            await this.db.addItem(item);
            showToast(`Added: ${productName} (${amount} ${unit})`, 'success');
            this.hideForm();
            this.refreshInventory();
        }

        hideForm() {
            document.getElementById('chemical-form').style.display = 'none';
        }

        // ---- Output Mode: Select Bottles ----
        async showOutputSelect(barcode) {
            const items = await this.db.getActiveItemsByBarcode(barcode);
            const section = document.getElementById('output-select');
            const list = document.getElementById('matching-bottles');
            const noMsg = document.getElementById('no-bottles-msg');
            const actions = document.getElementById('output-actions');

            document.getElementById('output-barcode-label').textContent = 'Barcode: ' + barcode;

            this.selectedBottles.clear();
            list.innerHTML = '';

            if (items.length === 0) {
                noMsg.style.display = '';
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

            section.style.display = '';
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        async disposeSelected() {
            if (this.selectedBottles.size === 0) {
                showToast('Select at least one bottle to remove.', 'error');
                return;
            }

            const now = new Date().toISOString();
            const removedBy = this.getSessionName();
            let count = 0;

            for (const id of this.selectedBottles) {
                const item = await this.db.getItem(id);
                if (item && item.status === 'active') {
                    item.status = 'disposed';
                    item.dateOut = now;
                    item.removedBy = removedBy;
                    await this.db.updateItem(item);
                    count++;
                }
            }

            showToast(`Removed ${count} bottle${count !== 1 ? 's' : ''} from inventory.`, 'success');
            this.hideOutputSelect();
            this.refreshInventory();
        }

        hideOutputSelect() {
            document.getElementById('output-select').style.display = 'none';
            this.selectedBottles.clear();
        }

        // ---- Inventory Display ----
        async refreshInventory() {
            const allItems = await this.db.getAllItems();
            const search = document.getElementById('search-inventory').value.toLowerCase().trim();
            const filterStatus = document.getElementById('filter-status').value;

            let items = allItems;

            // Filter by status
            if (filterStatus !== 'all') {
                items = items.filter(i => i.status === filterStatus);
            }

            // Search
            if (search) {
                items = items.filter(i =>
                    (i.productName || '').toLowerCase().includes(search) ||
                    (i.vendor || '').toLowerCase().includes(search) ||
                    (i.productNumber || '').toLowerCase().includes(search) ||
                    (i.casNumber || '').toLowerCase().includes(search) ||
                    (i.barcode || '').toLowerCase().includes(search) ||
                    (i.location || '').toLowerCase().includes(search) ||
                    (i.addedBy || '').toLowerCase().includes(search) ||
                    (i.notes || '').toLowerCase().includes(search)
                );
            }

            // Sort: active first, then by dateIn descending
            items.sort((a, b) => {
                if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
                return new Date(b.dateIn) - new Date(a.dateIn);
            });

            // Update count badge
            const activeCount = allItems.filter(i => i.status === 'active').length;
            document.getElementById('inventory-count').textContent = activeCount;

            // Render
            const listEl = document.getElementById('inventory-list');
            const emptyEl = document.getElementById('inventory-empty');

            if (items.length === 0) {
                listEl.innerHTML = '';
                emptyEl.style.display = '';
                emptyEl.textContent = search
                    ? 'No results for "' + search + '".'
                    : filterStatus === 'disposed'
                        ? 'No disposed items.'
                        : 'No items in inventory yet. Scan a chemical to get started.';
                return;
            }

            emptyEl.style.display = 'none';
            listEl.innerHTML = items.map(item => `
                <div class="inv-card ${item.status === 'disposed' ? 'disposed' : ''}">
                    <div class="inv-header">
                        <div class="inv-name">${this.esc(item.productName)}</div>
                        <span class="inv-status ${item.status}">${item.status}</span>
                    </div>
                    <div class="inv-meta">
                        <div><strong>Vendor:</strong> ${this.esc(item.vendor)}</div>
                        <div><strong>Product #:</strong> ${this.esc(item.productNumber)}</div>
                        <div><strong>CAS:</strong> ${this.esc(item.casNumber || '—')}</div>
                        <div><strong>Amount:</strong> ${this.esc(item.amount)} ${this.esc(item.unit)}</div>
                        ${item.location ? `<div><strong>Location:</strong> ${this.esc(item.location)}</div>` : ''}
                        ${item.addedBy ? `<div><strong>Added by:</strong> ${this.esc(item.addedBy)}</div>` : ''}
                        ${item.removedBy ? `<div><strong>Removed by:</strong> ${this.esc(item.removedBy)}</div>` : ''}
                        ${item.notes ? `<div><strong>Notes:</strong> ${this.esc(item.notes)}</div>` : ''}
                    </div>
                    <div class="inv-dates">
                        In: ${formatDate(item.dateIn)}
                        ${item.dateOut ? ' &bull; Out: ' + formatDate(item.dateOut) : ''}
                    </div>
                    <div class="inv-actions">
                        ${item.status === 'active'
                            ? `<button class="btn btn-danger" onclick="app.disposeSingle('${item.id}')">Dispose</button>`
                            : `<button class="btn btn-success" onclick="app.reactivate('${item.id}')">Reactivate</button>`
                        }
                        <button class="btn btn-secondary" onclick="app.deleteItem('${item.id}')">Delete</button>
                    </div>
                </div>
            `).join('');
        }

        async disposeSingle(id) {
            const item = await this.db.getItem(id);
            if (item) {
                item.status = 'disposed';
                item.dateOut = new Date().toISOString();
                item.removedBy = this.getSessionName() || '';
                await this.db.updateItem(item);
                showToast('Marked as disposed.', 'success');
                this.refreshInventory();
            }
        }

        async reactivate(id) {
            const item = await this.db.getItem(id);
            if (item) {
                item.status = 'active';
                item.dateOut = null;
                await this.db.updateItem(item);
                showToast('Reactivated.', 'success');
                this.refreshInventory();
            }
        }

        async deleteItem(id) {
            if (!confirm('Permanently delete this entry? This cannot be undone.')) return;
            await this.db.deleteItem(id);
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

            // Build summary sheet: group by barcode, count bottles
            const grouped = {};
            items.forEach(item => {
                const key = item.barcode;
                if (!grouped[key]) {
                    grouped[key] = {
                        barcode: item.barcode,
                        vendor: item.vendor,
                        productNumber: item.productNumber,
                        productName: item.productName,
                        casNumber: item.casNumber,
                        amount: item.amount + ' ' + item.unit,
                        activeBottles: 0,
                        disposedBottles: 0,
                    };
                }
                if (item.status === 'active') grouped[key].activeBottles++;
                else grouped[key].disposedBottles++;
            });

            const summaryData = Object.values(grouped).map(g => ({
                'Vendor': g.vendor,
                'Product Number': g.productNumber,
                'Product Name': g.productName,
                'CAS Number': g.casNumber,
                'Amount Per Bottle': g.amount,
                'Active Bottles': g.activeBottles,
                'Disposed Bottles': g.disposedBottles,
                'Barcode': g.barcode,
            }));

            // Build detail sheet: one row per bottle
            const detailData = items.map(item => ({
                'Bottle ID': item.id.split('-')[0],
                'Vendor': item.vendor,
                'Product Number': item.productNumber,
                'Product Name': item.productName,
                'CAS Number': item.casNumber || '',
                'Amount': item.amount,
                'Unit': item.unit,
                'Location': item.location || '',
                'Status': item.status,
                'Added By': item.addedBy || '',
                'Date Added': formatDate(item.dateIn),
                'Removed By': item.removedBy || '',
                'Date Removed': item.dateOut ? formatDate(item.dateOut) : '',
                'Notes': item.notes || '',
                'Barcode': item.barcode,
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

            // Build log entries: one for each "in" and one for each "out"
            const logEntries = [];
            allItems.forEach(item => {
                logEntries.push({
                    'Date': formatDate(item.dateIn),
                    'Action': 'IN',
                    'Person': item.addedBy || '',
                    'Product Name': item.productName,
                    'Vendor': item.vendor,
                    'Product Number': item.productNumber,
                    'CAS Number': item.casNumber || '',
                    'Amount': item.amount + ' ' + item.unit,
                    'Location': item.location || '',
                    'Notes': item.notes || '',
                });
                if (item.dateOut) {
                    logEntries.push({
                        'Date': formatDate(item.dateOut),
                        'Action': 'OUT',
                        'Person': item.removedBy || '',
                        'Product Name': item.productName,
                        'Vendor': item.vendor,
                        'Product Number': item.productNumber,
                        'CAS Number': item.casNumber || '',
                        'Amount': item.amount + ' ' + item.unit,
                        'Location': item.location || '',
                        'Notes': item.notes || '',
                    });
                }
            });

            logEntries.sort((a, b) => new Date(a.Date) - new Date(b.Date));

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
